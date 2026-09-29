from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import asyncpg
from pgvector import Vector
from pgvector.asyncpg import register_vector

from backend.app.domain import assess_refund
from backend.app.errors import (
    ApprovalRequiredError,
    IdempotencyConflictError,
    NotFoundError,
    PolicyMismatchError,
    StateConflictError,
)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _fingerprint(value: Any) -> str:
    body = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()


def _customer(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "tenureDays": row["tenure_days"],
        "tier": row["tier"],
        "riskScore": row["risk_score"],
    }


def _invoice(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": row["id"],
        "customerId": row["customer_id"],
        "amountCents": int(row["amount_cents"]),
        "refundedAmountCents": int(row["refunded_amount_cents"]),
        "currency": row["currency"].strip(),
        "status": row["status"],
        "issuedAt": _iso(row["issued_at"]),
    }


def _policy(row: asyncpg.Record) -> dict[str, Any]:
    policy = {
        "id": row["id"],
        "category": row["category"],
        "title": row["title"],
        "summary": row["summary"],
        "fullText": row["full_text"],
        "maxAutoApprovedCents": int(row["max_auto_approved_cents"]),
        "minTenureDays": row["min_tenure_days"],
        "keywords": list(row["keywords"]),
    }
    if row["refund_window_days"] is not None:
        policy["refundWindowDays"] = row["refund_window_days"]
    return policy


def _ticket(row: asyncpg.Record) -> dict[str, Any]:
    value = {
        "id": row["id"],
        "customerId": row["customer_id"],
        "subject": row["subject"],
        "rawMessage": row["raw_message"],
        "status": row["status"],
        "createdAt": _iso(row["created_at"]),
    }
    if row["resolved_at"] is not None:
        value["resolvedAt"] = _iso(row["resolved_at"])
    return value


def _proposal(row: asyncpg.Record) -> dict[str, Any]:
    value: dict[str, Any] = {
        "id": row["id"],
        "ticketId": row["ticket_id"],
        "customerId": row["customer_id"],
        "actionType": row["action_type"],
        "matchedPolicyId": row["matched_policy_id"],
        "policyCitation": row["policy_citation"],
        "requiresHumanApproval": row["requires_human_approval"],
        "status": row["status"],
        "createdAt": _iso(row["created_at"]),
    }
    if row["target_invoice_id"] is not None:
        value["targetInvoiceId"] = row["target_invoice_id"]
    if row["amount_cents"] is not None:
        value["amountCents"] = int(row["amount_cents"])
    if row["approval_reason"] is not None:
        value["approvalReason"] = row["approval_reason"]
    if row["executed_at"] is not None:
        value["executedAt"] = _iso(row["executed_at"])
    return value


class _CommitThenRaise(Exception):
    def __init__(self, error: Exception) -> None:
        super().__init__(str(error))
        self.error = error


class PostgresSupportRepository:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.pool: asyncpg.Pool | None = None

    async def open(self) -> None:
        if self.pool is None:
            self.pool = await asyncpg.create_pool(
                self.database_url,
                min_size=1,
                max_size=10,
                timeout=5,
                command_timeout=30,
                init=self._register_vector,
            )

    @staticmethod
    async def _register_vector(connection: asyncpg.Connection) -> None:
        await register_vector(connection)

    async def _pool(self) -> asyncpg.Pool:
        if self.pool is None:
            await self.open()
        assert self.pool is not None
        return self.pool

    async def health(self) -> None:
        pool = await self._pool()
        row = await pool.fetchrow(
            """
            SELECT to_regclass('public.tickets') AS tickets,
                   to_regclass('public.action_proposals') AS proposals,
                   to_regclass('public.operator_sessions') AS sessions,
                   to_regclass('public.auth_login_attempts') AS login_attempts,
                   to_regclass('public.schema_migrations') AS schema
            """
        )
        if not row or any(row[name] is None for name in row.keys()):
            raise RuntimeError("Database schema is missing; run python -m backend.app.migrate")

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    async def create_operator_session(self, session: dict[str, str]) -> None:
        pool = await self._pool()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM operator_sessions WHERE expires_at <= NOW()")
                await connection.execute(
                    """
                    INSERT INTO operator_sessions(
                        session_hash, operator_id, credential_hash, expires_at
                    )
                    VALUES ($1, $2, $3, $4)
                    """,
                    session["sessionHash"],
                    session["operatorId"],
                    session["credentialHash"],
                    _datetime(session["expiresAt"]),
                )

    async def get_operator_session(self, session_hash: str) -> dict[str, str] | None:
        pool = await self._pool()
        row = await pool.fetchrow(
            """
            SELECT operator_id, credential_hash, expires_at
            FROM operator_sessions WHERE session_hash = $1 AND expires_at > NOW()
            """,
            session_hash,
        )
        if row is None:
            return None
        return {
            "sessionHash": session_hash,
            "operatorId": row["operator_id"],
            "credentialHash": row["credential_hash"],
            "expiresAt": _iso(row["expires_at"]) or "",
        }

    async def delete_operator_session(self, session_hash: str) -> None:
        pool = await self._pool()
        await pool.execute("DELETE FROM operator_sessions WHERE session_hash = $1", session_hash)

    async def consume_login_attempt(
        self,
        key: str,
        window_seconds: int,
        max_attempts: int,
    ) -> dict[str, Any]:
        pool = await self._pool()
        await pool.execute(
            """
            DELETE FROM auth_login_attempts
            WHERE window_started_at <= NOW() - ($1::int * INTERVAL '1 second')
            """,
            window_seconds,
        )
        row = await pool.fetchrow(
            """
            INSERT INTO auth_login_attempts(attempt_key, window_started_at, attempts)
            VALUES ($1, NOW(), 1)
            ON CONFLICT (attempt_key) DO UPDATE
            SET window_started_at = CASE
                    WHEN auth_login_attempts.window_started_at
                        + ($2::int * INTERVAL '1 second') <= NOW()
                    THEN NOW() ELSE auth_login_attempts.window_started_at END,
                attempts = CASE
                    WHEN auth_login_attempts.window_started_at
                        + ($2::int * INTERVAL '1 second') <= NOW()
                    THEN 1 ELSE auth_login_attempts.attempts + 1 END
            RETURNING attempts,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
                    window_started_at + ($2::int * INTERVAL '1 second') - NOW()
                )))::int) AS retry_after_seconds
            """,
            key,
            window_seconds,
        )
        assert row is not None
        return {
            "allowed": row["attempts"] <= max_attempts,
            "retryAfterSeconds": row["retry_after_seconds"],
        }

    async def clear_login_attempts(self, key: str) -> None:
        pool = await self._pool()
        await pool.execute("DELETE FROM auth_login_attempts WHERE attempt_key = $1", key)

    async def get_policy_embedding_hashes(
        self, model: str, policy_ids: list[str]
    ) -> dict[str, str]:
        if not policy_ids:
            return {}
        pool = await self._pool()
        rows = await pool.fetch(
            """
            SELECT policy_id, source_hash FROM policy_embeddings
            WHERE model = $1 AND policy_id = ANY($2::text[])
            """,
            model,
            policy_ids,
        )
        return {row["policy_id"]: row["source_hash"] for row in rows}

    async def upsert_policy_embeddings(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        pool = await self._pool()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await connection.executemany(
                    """
                    INSERT INTO policy_embeddings(policy_id, model, source_hash, embedding)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (policy_id, model) DO UPDATE SET
                        source_hash = EXCLUDED.source_hash,
                        embedding = EXCLUDED.embedding,
                        updated_at = NOW()
                    """,
                    [
                        (
                            item["policyId"],
                            item["model"],
                            item["sourceHash"],
                            Vector(item["embedding"]),
                        )
                        for item in rows
                    ],
                )

    async def search_policy_embeddings(
        self,
        query_vector: list[float],
        model: str,
        policy_ids: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        if not policy_ids:
            return []
        pool = await self._pool()
        rows = await pool.fetch(
            """
            SELECT policy_id, 1 - (embedding <=> $1) AS similarity
            FROM policy_embeddings
            WHERE model = $2 AND policy_id = ANY($3::text[])
            ORDER BY embedding <=> $1, policy_id
            LIMIT $4
            """,
            Vector(query_vector),
            model,
            policy_ids,
            limit,
        )
        return [
            {"policyId": row["policy_id"], "similarity": float(row["similarity"])} for row in rows
        ]

    async def get_ticket(self, ticket_id: str) -> dict[str, Any] | None:
        pool = await self._pool()
        row = await pool.fetchrow("SELECT * FROM tickets WHERE id = $1", ticket_id)
        return _ticket(row) if row else None

    async def get_customer(self, customer_id: str) -> dict[str, Any] | None:
        pool = await self._pool()
        row = await pool.fetchrow("SELECT * FROM customers WHERE id = $1", customer_id)
        return _customer(row) if row else None

    async def list_customer_invoices(self, customer_id: str) -> list[dict[str, Any]]:
        pool = await self._pool()
        rows = await pool.fetch(
            "SELECT * FROM invoices WHERE customer_id = $1 ORDER BY issued_at DESC, id",
            customer_id,
        )
        return [_invoice(row) for row in rows]

    async def list_policies(self) -> list[dict[str, Any]]:
        pool = await self._pool()
        rows = await pool.fetch("SELECT * FROM policies ORDER BY id")
        return [_policy(row) for row in rows]

    async def list_tickets(self, status: str | None = None) -> list[dict[str, Any]]:
        pool = await self._pool()
        rows = await pool.fetch(
            """
            SELECT t.id, t.subject, t.status, t.created_at,
                   c.id AS customer_id, c.name AS customer_name, c.tier
            FROM tickets t JOIN customers c ON c.id = t.customer_id
            WHERE $1::text IS NULL OR t.status = $1
            ORDER BY t.created_at DESC, t.id
            """,
            status,
        )
        return [
            {
                "id": row["id"],
                "subject": row["subject"],
                "status": row["status"],
                "createdAt": _iso(row["created_at"]),
                "customer": {
                    "id": row["customer_id"],
                    "name": row["customer_name"],
                    "tier": row["tier"],
                },
            }
            for row in rows
        ]

    async def get_ticket_context(
        self,
        ticket_id: str,
        policy_hits: list[dict[str, Any]],
    ) -> dict[str, Any]:
        ticket = await self.get_ticket(ticket_id)
        if ticket is None:
            raise NotFoundError("Ticket", ticket_id)
        customer = await self.get_customer(ticket["customerId"])
        if customer is None:
            raise NotFoundError("Customer", ticket["customerId"])
        invoices = await self.list_customer_invoices(customer["id"])
        pool = await self._pool()
        proposals = await pool.fetch(
            "SELECT * FROM action_proposals WHERE ticket_id = $1 ORDER BY created_at, id",
            ticket_id,
        )
        return {
            "ticket": ticket,
            "customer": {key: customer[key] for key in ("id", "name", "tier", "tenureDays")},
            "invoices": [
                {
                    key: invoice[key]
                    for key in (
                        "id",
                        "amountCents",
                        "refundedAmountCents",
                        "currency",
                        "status",
                        "issuedAt",
                    )
                }
                for invoice in invoices
            ],
            "relevantPolicies": [
                {
                    key: hit["policy"][key]
                    for key in ("id", "category", "title", "summary", "fullText")
                }
                | {"matchedKeywords": hit["matchedKeywords"]}
                for hit in policy_hits
            ],
            "proposals": [
                {
                    key: item[key]
                    for key in (
                        "id",
                        "actionType",
                        "status",
                        "amountCents",
                        "targetInvoiceId",
                        "matchedPolicyId",
                        "requiresHumanApproval",
                        "approvalReason",
                        "createdAt",
                        "executedAt",
                    )
                    if key in item
                }
                for item in (_proposal(row) for row in proposals)
            ],
        }

    async def create_ticket(self, input_data: dict[str, Any]) -> dict[str, Any]:
        async def operation(connection: asyncpg.Connection) -> dict[str, Any]:
            exists = await connection.fetchval(
                "SELECT 1 FROM customers WHERE id = $1", input_data["customerId"]
            )
            if not exists:
                raise NotFoundError("Customer", input_data["customerId"])
            ticket = {
                "id": f"ticket_{uuid.uuid4()}",
                "customerId": input_data["customerId"],
                "subject": input_data["subject"],
                "rawMessage": input_data["rawMessage"],
                "status": "open",
                "createdAt": _iso(datetime.now(UTC)),
            }
            await self._write_ticket(connection, ticket)
            await self._audit(
                connection,
                "SYSTEM",
                "TICKET_CREATED",
                ticket["id"],
                {
                    "customerId": ticket["customerId"],
                },
            )
            return ticket

        return await self._transaction(operation)

    async def create_refund_proposal(self, input_data: dict[str, Any]) -> dict[str, Any]:
        key = input_data["idempotencyKey"]
        fingerprint = _fingerprint(
            [
                input_data["ticketId"],
                input_data["invoiceId"],
                input_data["policyId"],
                input_data["amountCents"],
            ]
        )

        async def operation(connection: asyncpg.Connection) -> dict[str, Any]:
            previous = await self._previous_request(connection, "refund-proposal", key, fingerprint)
            if previous:
                return {**previous, "replayed": True}
            ticket_row = await self._select(
                connection, "tickets", input_data["ticketId"], lock=True
            )
            if ticket_row is None:
                raise NotFoundError("Ticket", input_data["ticketId"])
            ticket = _ticket(ticket_row)
            if ticket["status"] != "open":
                raise StateConflictError("Ticket is not open for a refund proposal")
            customer_row = await self._select(connection, "customers", ticket["customerId"])
            if customer_row is None:
                raise NotFoundError("Customer", ticket["customerId"])
            invoice_row = await self._select(
                connection, "invoices", input_data["invoiceId"], lock=True
            )
            if invoice_row is None:
                raise NotFoundError("Invoice", input_data["invoiceId"])
            policy_row = await self._select(connection, "policies", input_data["policyId"])
            if policy_row is None:
                raise NotFoundError("Policy", input_data["policyId"])
            existing = await connection.fetchval(
                """
                SELECT 1 FROM action_proposals
                WHERE ticket_id = $1 AND target_invoice_id = $2 AND action_type = 'ISSUE_REFUND'
                  AND status IN ('PROPOSED', 'APPROVED') LIMIT 1
                """,
                ticket["id"],
                input_data["invoiceId"],
            )
            if existing:
                raise StateConflictError(
                    "An unresolved refund proposal already exists for this invoice"
                )
            customer = _customer(customer_row)
            invoice = _invoice(invoice_row)
            policy = _policy(policy_row)
            assessment = assess_refund(customer, invoice, policy, input_data["amountCents"])
            if assessment["disposition"] == "REJECTED":
                await self._audit(
                    connection,
                    "SYSTEM",
                    "REFUND_ASSESSMENT_REJECTED",
                    ticket["id"],
                    {
                        "invoiceId": invoice["id"],
                        "policyId": policy["id"],
                        "amountCents": input_data["amountCents"],
                        "reason": assessment["reason"],
                    },
                )
                self._commit_then_raise(PolicyMismatchError(str(assessment["reason"])))
            needs_approval = assessment["disposition"] == "REQUIRES_APPROVAL"
            reasons = assessment.get("reasons", [])
            proposal = {
                "id": f"proposal_{uuid.uuid4()}",
                "ticketId": ticket["id"],
                "customerId": customer["id"],
                "actionType": "ISSUE_REFUND",
                "targetInvoiceId": invoice["id"],
                "amountCents": input_data["amountCents"],
                "matchedPolicyId": policy["id"],
                "policyCitation": policy["fullText"],
                "requiresHumanApproval": needs_approval,
                "approvalReason": ", ".join(reasons) if needs_approval else None,
                "status": "PROPOSED",
                "createdAt": _iso(datetime.now(UTC)),
            }
            await self._write_proposal(connection, proposal)
            if needs_approval:
                await self._write_ticket(connection, {**ticket, "status": "pending_approval"})
            result = {"proposal": proposal}
            await self._write_idempotency(connection, "refund-proposal", key, fingerprint, result)
            await self._audit(
                connection,
                "SYSTEM",
                "REFUND_PROPOSED",
                proposal["id"],
                {
                    "ticketId": ticket["id"],
                    "invoiceId": invoice["id"],
                    "policyId": policy["id"],
                    "amountCents": input_data["amountCents"],
                    "requiresHumanApproval": needs_approval,
                },
            )
            return {**result, "replayed": False}

        return await self._transaction(operation)

    async def decide_refund_proposal(self, input_data: dict[str, Any]) -> dict[str, Any]:
        key = input_data["idempotencyKey"]
        fingerprint = _fingerprint(
            [
                input_data["proposalId"],
                input_data["decision"],
                input_data["operatorId"],
            ]
        )

        async def operation(connection: asyncpg.Connection) -> dict[str, Any]:
            previous = await self._previous_request(connection, "refund-decision", key, fingerprint)
            if previous:
                return {**previous, "replayed": True}
            row = await self._select(
                connection, "action_proposals", input_data["proposalId"], lock=True
            )
            if row is None:
                raise NotFoundError("Refund proposal", input_data["proposalId"])
            proposal = _proposal(row)
            if proposal["status"] != "PROPOSED":
                raise StateConflictError("Refund proposal already has a decision")
            ticket_row = await self._select(connection, "tickets", proposal["ticketId"], lock=True)
            if ticket_row is None:
                raise NotFoundError("Ticket", proposal["ticketId"])
            ticket = _ticket(ticket_row)
            if proposal["requiresHumanApproval"] and ticket["status"] != "pending_approval":
                raise StateConflictError("Ticket is not waiting for approval")
            decision = input_data["decision"]
            updated = {**proposal, "status": "APPROVED" if decision == "APPROVE" else "REJECTED"}
            updated_ticket = {
                **ticket,
                "status": "open" if decision == "APPROVE" else "rejected",
            }
            await self._write_proposal(connection, updated)
            await self._write_ticket(connection, updated_ticket)
            await self._audit(
                connection,
                "OPERATOR",
                f"REFUND_{decision}",
                proposal["id"],
                {
                    "ticketId": ticket["id"],
                    "operatorId": input_data["operatorId"],
                },
                input_data["operatorId"],
            )
            result = {"proposal": updated}
            await self._write_idempotency(connection, "refund-decision", key, fingerprint, result)
            return {**result, "replayed": False}

        return await self._transaction(operation)

    async def execute_refund_proposal(self, input_data: dict[str, Any]) -> dict[str, Any]:
        key = input_data["idempotencyKey"]
        fingerprint = _fingerprint(input_data["proposalId"])

        async def operation(connection: asyncpg.Connection) -> dict[str, Any]:
            previous = await self._previous_request(
                connection, "refund-execution", key, fingerprint
            )
            if previous:
                return {**previous, "replayed": True}
            row = await self._select(
                connection, "action_proposals", input_data["proposalId"], lock=True
            )
            if row is None:
                raise NotFoundError("Refund proposal", input_data["proposalId"])
            proposal = _proposal(row)
            invoice_id = proposal.get("targetInvoiceId")
            amount = proposal.get("amountCents")
            if proposal["actionType"] != "ISSUE_REFUND" or not invoice_id or amount is None:
                raise StateConflictError("Proposal is not a complete refund action")
            if proposal["status"] not in ("PROPOSED", "APPROVED"):
                raise StateConflictError("Refund proposal cannot be executed in its current state")
            ticket_row = await self._select(connection, "tickets", proposal["ticketId"], lock=True)
            if ticket_row is None:
                raise NotFoundError("Ticket", proposal["ticketId"])
            customer_row = await self._select(connection, "customers", proposal["customerId"])
            if customer_row is None:
                raise NotFoundError("Customer", proposal["customerId"])
            invoice_row = await self._select(connection, "invoices", invoice_id, lock=True)
            if invoice_row is None:
                raise NotFoundError("Invoice", invoice_id)
            policy_row = await self._select(connection, "policies", proposal["matchedPolicyId"])
            if policy_row is None:
                raise NotFoundError("Policy", proposal["matchedPolicyId"])
            ticket = _ticket(ticket_row)
            invoice = _invoice(invoice_row)
            assessment = assess_refund(
                _customer(customer_row), invoice, _policy(policy_row), amount
            )
            if assessment["disposition"] == "REJECTED":
                await self._audit(
                    connection,
                    "SYSTEM",
                    "REFUND_EXECUTION_REJECTED",
                    proposal["id"],
                    {
                        "invoiceId": invoice["id"],
                        "reason": assessment["reason"],
                    },
                )
                self._commit_then_raise(PolicyMismatchError(str(assessment["reason"])))
            if (
                assessment["disposition"] == "REQUIRES_APPROVAL"
                and proposal["status"] == "PROPOSED"
            ):
                reasons = assessment.get("reasons", [])
                if not proposal["requiresHumanApproval"]:
                    proposal = {
                        **proposal,
                        "requiresHumanApproval": True,
                        "approvalReason": ", ".join(reasons),
                    }
                    await self._write_proposal(connection, proposal)
                    await self._write_ticket(connection, {**ticket, "status": "pending_approval"})
                    await self._audit(
                        connection,
                        "SYSTEM",
                        "REFUND_REQUIRES_APPROVAL",
                        proposal["id"],
                        {
                            "ticketId": ticket["id"],
                            "reasons": reasons,
                        },
                    )
                self._commit_then_raise(ApprovalRequiredError(proposal["id"], ", ".join(reasons)))
            if proposal["requiresHumanApproval"] and proposal["status"] != "APPROVED":
                self._commit_then_raise(
                    ApprovalRequiredError(
                        proposal["id"],
                        proposal.get("approvalReason") or "operator approval is missing",
                    )
                )

            refunded = invoice["refundedAmountCents"] + amount
            updated_invoice = {
                **invoice,
                "refundedAmountCents": refunded,
                "status": "refunded"
                if refunded == invoice["amountCents"]
                else "partially_refunded",
            }
            executed_at = _iso(datetime.now(UTC)) or ""
            updated_proposal = {**proposal, "status": "EXECUTED", "executedAt": executed_at}
            unresolved_rows = await connection.fetch(
                """
                SELECT * FROM action_proposals
                WHERE ticket_id = $1 AND id <> $2 AND status IN ('PROPOSED', 'APPROVED')
                """,
                ticket["id"],
                proposal["id"],
            )
            unresolved = [_proposal(item) for item in unresolved_rows]
            pending = any(
                item["requiresHumanApproval"] and item["status"] == "PROPOSED"
                for item in unresolved
            )
            ticket_status = "pending_approval" if pending else "open" if unresolved else "resolved"
            updated_ticket = {**ticket, "status": ticket_status}
            if ticket_status == "resolved":
                updated_ticket["resolvedAt"] = executed_at
            else:
                updated_ticket.pop("resolvedAt", None)
            await self._write_invoice(connection, updated_invoice)
            await self._write_proposal(connection, updated_proposal)
            await self._write_ticket(connection, updated_ticket)
            await self._audit(
                connection,
                "SYSTEM",
                "REFUND_EXECUTED",
                proposal["id"],
                {
                    "ticketId": ticket["id"],
                    "invoiceId": invoice["id"],
                    "amountCents": amount,
                    "refundedAmountCents": refunded,
                },
            )
            result = {"proposal": updated_proposal, "invoice": updated_invoice}
            await self._write_idempotency(connection, "refund-execution", key, fingerprint, result)
            return {**result, "replayed": False}

        return await self._transaction(operation)

    async def _transaction(
        self,
        operation: Callable[[asyncpg.Connection], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        pool = await self._pool()
        async with pool.acquire() as connection:
            transaction = connection.transaction()
            await transaction.start()
            try:
                result = await operation(connection)
            except _CommitThenRaise as signal:
                await transaction.commit()
                raise signal.error from signal
            except BaseException:
                await transaction.rollback()
                raise
            await transaction.commit()
            return result

    def _commit_then_raise(self, error: Exception) -> None:
        raise _CommitThenRaise(error)

    async def _previous_request(
        self,
        connection: asyncpg.Connection,
        operation: str,
        key: str,
        fingerprint: str,
    ) -> dict[str, Any] | None:
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            f"{operation}:{key}",
        )
        row = await connection.fetchrow(
            """
            SELECT fingerprint, response FROM idempotency_records
            WHERE operation = $1 AND key = $2
            """,
            operation,
            key,
        )
        if row is None:
            return None
        if row["fingerprint"] != fingerprint:
            raise IdempotencyConflictError()
        response = row["response"]
        return json.loads(response) if isinstance(response, str) else response

    async def _write_idempotency(
        self,
        connection: asyncpg.Connection,
        operation: str,
        key: str,
        fingerprint: str,
        response: dict[str, Any],
    ) -> None:
        await connection.execute(
            """
            INSERT INTO idempotency_records(operation, key, fingerprint, response)
            VALUES ($1, $2, $3, $4::jsonb)
            """,
            operation,
            key,
            fingerprint,
            json.dumps(response, separators=(",", ":")),
        )

    async def _select(
        self,
        connection: asyncpg.Connection,
        table: str,
        record_id: str,
        lock: bool = False,
    ) -> asyncpg.Record | None:
        tables = {"tickets", "customers", "invoices", "policies", "action_proposals"}
        if table not in tables:
            raise ValueError("Unknown support table")
        suffix = " FOR UPDATE" if lock else ""
        return await connection.fetchrow(f"SELECT * FROM {table} WHERE id = $1{suffix}", record_id)

    async def _write_ticket(self, connection: asyncpg.Connection, item: dict[str, Any]) -> None:
        await connection.execute(
            """
            INSERT INTO tickets(
                id, customer_id, subject, raw_message, status, created_at, resolved_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status, resolved_at = EXCLUDED.resolved_at
            """,
            item["id"],
            item["customerId"],
            item["subject"],
            item["rawMessage"],
            item["status"],
            _datetime(item["createdAt"]),
            _datetime(item.get("resolvedAt")),
        )

    async def _write_invoice(self, connection: asyncpg.Connection, item: dict[str, Any]) -> None:
        await connection.execute(
            "UPDATE invoices SET refunded_amount_cents = $2, status = $3 WHERE id = $1",
            item["id"],
            item["refundedAmountCents"],
            item["status"],
        )

    async def _write_proposal(self, connection: asyncpg.Connection, item: dict[str, Any]) -> None:
        await connection.execute(
            """
            INSERT INTO action_proposals(
                id, ticket_id, customer_id, action_type, target_invoice_id, amount_cents,
                matched_policy_id, policy_citation, requires_human_approval, approval_reason,
                status, created_at, executed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (id) DO UPDATE SET
                requires_human_approval = EXCLUDED.requires_human_approval,
                approval_reason = EXCLUDED.approval_reason,
                status = EXCLUDED.status,
                executed_at = EXCLUDED.executed_at
            """,
            item["id"],
            item["ticketId"],
            item["customerId"],
            item["actionType"],
            item.get("targetInvoiceId"),
            item.get("amountCents"),
            item["matchedPolicyId"],
            item["policyCitation"],
            item["requiresHumanApproval"],
            item.get("approvalReason"),
            item["status"],
            _datetime(item["createdAt"]),
            _datetime(item.get("executedAt")),
        )

    async def _audit(
        self,
        connection: asyncpg.Connection,
        actor: str,
        action_type: str,
        entity_id: str,
        details: dict[str, Any],
        operator_id: str | None = None,
    ) -> None:
        await connection.execute(
            """
            INSERT INTO audit_logs(
                id, timestamp, actor, operator_id, action_type, entity_id, details
            )
            VALUES ($1, NOW(), $2, $3, $4, $5, $6::jsonb)
            """,
            str(uuid.uuid4()),
            actor,
            operator_id,
            action_type,
            entity_id,
            json.dumps(details, separators=(",", ":")),
        )
