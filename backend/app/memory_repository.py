from __future__ import annotations

import asyncio
import hashlib
import json
import math
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from backend.app.domain import assess_refund
from backend.app.errors import (
    ApprovalRequiredError,
    IdempotencyConflictError,
    NotFoundError,
    PolicyMismatchError,
    StateConflictError,
)


def _fingerprint(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4()}"


def _seed_policies() -> dict[str, dict[str, Any]]:
    policies = [
        {
            "id": "POL-REFUND-STANDARD",
            "category": "refund",
            "title": "Standard Subscription Refund Policy",
            "summary": "Refunds permitted for billing issues within 14 days of invoice.",
            "fullText": (
                "Customers may request a full or partial refund within 14 days of billing if "
                "service "
                "expectations were not met. Automatic approval is limited to $50.00. Amounts above "
                "$50.00 or accounts under 30 days tenure require supervisor approval."
            ),
            "maxAutoApprovedCents": 5000,
            "minTenureDays": 30,
            "refundWindowDays": 14,
            "keywords": [
                "refund",
                "double charge",
                "charged twice",
                "two charges",
                "duplicate charge",
                "billed twice",
                "billing mistake",
                "money back",
            ],
        },
        {
            "id": "POL-REFUND-OUTAGE",
            "category": "refund",
            "title": "Platform Service Outage Compensation",
            "summary": "Pro-rated credit or refund for verified system downtime.",
            "fullText": (
                "In the event of an unplanned platform outage exceeding 2 hours, affected accounts "
                "may be credited or refunded up to $150.00 automatically."
            ),
            "maxAutoApprovedCents": 15000,
            "minTenureDays": 0,
            "keywords": ["outage", "downtime", "server down", "incident", "offline"],
        },
        {
            "id": "POL-TRIAL-EXTEND",
            "category": "account_tier",
            "title": "Evaluation Trial Extension",
            "summary": "Permits 7-day trial extension for accounts actively testing features.",
            "fullText": (
                "Trial accounts with ongoing technical evaluation may be granted one 7-day "
                "extension. "
                "Automatic approval applies if risk score is under 25."
            ),
            "maxAutoApprovedCents": 0,
            "minTenureDays": 0,
            "keywords": ["extend trial", "more time", "testing period", "trial expired"],
        },
        {
            "id": "POL-DISPUTE-ESCALATE",
            "category": "dispute",
            "title": "Fraud and Chargeback Risk Escalation",
            "summary": "Immediate escalation to Risk Operations on chargeback threats.",
            "fullText": (
                "Any explicit mention of unauthorized card usage, bank dispute, or lawyer "
                "escalation "
                "must bypass auto-actions and transition ticket directly to Tier 2 Risk Operations."
            ),
            "maxAutoApprovedCents": 0,
            "minTenureDays": 0,
            "keywords": [
                "fraud",
                "stolen card",
                "chargeback",
                "bank dispute",
                "unauthorized transaction",
            ],
        },
    ]
    return {item["id"]: item for item in policies}


def _seed_customers() -> dict[str, dict[str, Any]]:
    values = [
        {
            "id": "cust_acme_corp",
            "email": "billing@harborline.example",
            "name": "Harborline Analytics",
            "tenureDays": 140,
            "tier": "enterprise",
            "riskScore": 5,
        },
        {
            "id": "cust_solo_dev",
            "email": "alex@devstudio.io",
            "name": "Alex Rivera",
            "tenureDays": 12,
            "tier": "starter",
            "riskScore": 18,
        },
        {
            "id": "cust_suspicious_user",
            "email": "morgan@customer.example",
            "name": "Morgan Hayes",
            "tenureDays": 2,
            "tier": "free",
            "riskScore": 82,
        },
    ]
    return {item["id"]: item for item in values}


class MemorySupportRepository:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.policies = _seed_policies()
        self.customers = _seed_customers()
        issued = datetime.now(UTC) - timedelta(days=6)
        self.invoices: dict[str, dict[str, Any]] = {
            item["id"]: item
            for item in [
                {
                    "id": "inv_acme_001",
                    "customerId": "cust_acme_corp",
                    "amountCents": 4900,
                    "refundedAmountCents": 0,
                    "currency": "USD",
                    "status": "paid",
                    "issuedAt": (datetime.now(UTC) - timedelta(days=4)).isoformat(),
                },
                {
                    "id": "inv_acme_002",
                    "customerId": "cust_acme_corp",
                    "amountCents": 18000,
                    "refundedAmountCents": 0,
                    "currency": "USD",
                    "status": "paid",
                    "issuedAt": (datetime.now(UTC) - timedelta(days=2)).isoformat(),
                },
                *[
                    {
                        "id": f"inv_solo_00{number}",
                        "customerId": "cust_solo_dev",
                        "amountCents": 2900,
                        "refundedAmountCents": 0,
                        "currency": "USD",
                        "status": "paid",
                        "issuedAt": issued.isoformat(),
                    }
                    for number in (1, 2)
                ],
            ]
        }
        current = datetime.now(UTC)
        tickets = [
            {
                "id": "ticket_solo_duplicate_charge",
                "customerId": "cust_solo_dev",
                "subject": "Possible duplicate $29 charge",
                "rawMessage": (
                    "I was charged twice for the same $29 plan today. The statement shows two "
                    "entries for this plan."
                ),
                "status": "open",
                "createdAt": (current - timedelta(minutes=20)).isoformat(),
            },
            {
                "id": "ticket_acme_refund_review",
                "customerId": "cust_acme_corp",
                "subject": "Refund request for the $180 plan",
                "rawMessage": (
                    "Please refund the latest invoice for $180.00. I no longer need the upgraded "
                    "plan."
                ),
                "status": "open",
                "createdAt": (current - timedelta(minutes=50)).isoformat(),
            },
            {
                "id": "ticket_card_dispute",
                "customerId": "cust_suspicious_user",
                "subject": "I may dispute this card charge",
                "rawMessage": "I do not recognize this charge and may file a bank dispute.",
                "status": "open",
                "createdAt": (current - timedelta(hours=2)).isoformat(),
            },
        ]
        self.tickets = {item["id"]: item for item in tickets}
        self.proposals: dict[str, dict[str, Any]] = {}
        self.idempotency: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
        self.audit_logs: list[dict[str, Any]] = []
        self.operator_sessions: dict[str, dict[str, str]] = {}
        self.login_attempts: dict[str, dict[str, int]] = {}
        self.policy_embeddings: dict[tuple[str, str], dict[str, Any]] = {}

    async def open(self) -> None:
        return None

    async def health(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def create_operator_session(self, session: dict[str, str]) -> None:
        async with self._lock:
            self.operator_sessions[session["sessionHash"]] = {
                key: session[key]
                for key in ("sessionHash", "operatorId", "credentialHash", "expiresAt")
            }

    async def get_operator_session(self, session_hash: str) -> dict[str, str] | None:
        record = self.operator_sessions.get(session_hash)
        if not record or datetime.fromisoformat(
            record["expiresAt"].replace("Z", "+00:00")
        ) <= datetime.now(UTC):
            return None
        return record.copy()

    async def delete_operator_session(self, session_hash: str) -> None:
        self.operator_sessions.pop(session_hash, None)

    async def consume_login_attempt(
        self, key: str, window_seconds: int, max_attempts: int
    ) -> dict[str, Any]:
        now = int(time.time())
        async with self._lock:
            current = self.login_attempts.get(key)
            if not current or now - current["windowStartedAt"] >= window_seconds:
                current = {"windowStartedAt": now, "attempts": 0}
            current["attempts"] += 1
            self.login_attempts[key] = current
            retry_after = max(1, window_seconds - (now - current["windowStartedAt"]))
            return {
                "allowed": current["attempts"] <= max_attempts,
                "retryAfterSeconds": retry_after,
            }

    async def clear_login_attempts(self, key: str) -> None:
        self.login_attempts.pop(key, None)

    async def get_policy_embedding_hashes(
        self, model: str, policy_ids: list[str]
    ) -> dict[str, str]:
        return {
            policy_id: self.policy_embeddings[(policy_id, model)]["sourceHash"]
            for policy_id in policy_ids
            if (policy_id, model) in self.policy_embeddings
        }

    async def upsert_policy_embeddings(self, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            self.policy_embeddings[(row["policyId"], row["model"])] = row.copy()

    async def search_policy_embeddings(
        self,
        query_vector: list[float],
        model: str,
        policy_ids: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        ids = set(policy_ids)
        query_norm = math.sqrt(sum(value * value for value in query_vector))
        if not query_norm:
            raise ValueError("Embedding vector has zero magnitude")
        matches = []
        for (policy_id, indexed_model), item in self.policy_embeddings.items():
            if indexed_model != model or policy_id not in ids:
                continue
            vector = item["embedding"]
            vector_norm = math.sqrt(sum(value * value for value in vector))
            if not vector_norm:
                raise ValueError("Embedding vector has zero magnitude")
            similarity = sum(a * b for a, b in zip(query_vector, vector, strict=True))
            similarity /= query_norm * vector_norm
            matches.append({"policyId": policy_id, "similarity": similarity})
        matches.sort(key=lambda row: (-row["similarity"], row["policyId"]))
        return matches[:limit]

    async def get_ticket(self, ticket_id: str) -> dict[str, Any] | None:
        item = self.tickets.get(ticket_id)
        return item.copy() if item else None

    async def get_customer(self, customer_id: str) -> dict[str, Any] | None:
        item = self.customers.get(customer_id)
        return item.copy() if item else None

    async def list_customer_invoices(self, customer_id: str) -> list[dict[str, Any]]:
        invoices = [
            item.copy() for item in self.invoices.values() if item["customerId"] == customer_id
        ]
        invoices.sort(key=lambda item: item["id"])
        return sorted(invoices, key=lambda item: item["issuedAt"], reverse=True)

    async def list_policies(self) -> list[dict[str, Any]]:
        return [self.policies[key].copy() for key in sorted(self.policies)]

    async def list_tickets(self, status: str | None = None) -> list[dict[str, Any]]:
        results = []
        for ticket in self.tickets.values():
            if status and ticket["status"] != status:
                continue
            customer = self.customers.get(ticket["customerId"])
            if customer is None:
                raise NotFoundError("Customer", ticket["customerId"])
            results.append(
                {
                    "id": ticket["id"],
                    "subject": ticket["subject"],
                    "status": ticket["status"],
                    "createdAt": ticket["createdAt"],
                    "customer": {
                        "id": customer["id"],
                        "name": customer["name"],
                        "tier": customer["tier"],
                    },
                }
            )
        results.sort(key=lambda item: item["id"])
        return sorted(results, key=lambda item: item["createdAt"], reverse=True)

    async def get_ticket_context(
        self, ticket_id: str, policy_hits: list[dict[str, Any]]
    ) -> dict[str, Any]:
        ticket = self.tickets.get(ticket_id)
        if not ticket:
            raise NotFoundError("Ticket", ticket_id)
        customer = self.customers.get(ticket["customerId"])
        if not customer:
            raise NotFoundError("Customer", ticket["customerId"])
        invoices = [
            {
                key: item[key]
                for key in (
                    "id",
                    "amountCents",
                    "refundedAmountCents",
                    "currency",
                    "status",
                    "issuedAt",
                )
            }
            for item in await self.list_customer_invoices(customer["id"])
        ]
        proposal_fields = (
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
        proposals = [
            {key: item[key] for key in proposal_fields if item.get(key) is not None}
            for item in self.proposals.values()
            if item["ticketId"] == ticket_id
        ]
        policy_fields = ("id", "category", "title", "summary", "fullText")
        return {
            "ticket": ticket.copy(),
            "customer": {key: customer[key] for key in ("id", "name", "tier", "tenureDays")},
            "invoices": invoices,
            "relevantPolicies": [
                {
                    **{key: hit["policy"][key] for key in policy_fields},
                    "matchedKeywords": hit["matchedKeywords"],
                }
                for hit in policy_hits
            ],
            "proposals": proposals,
        }

    async def create_ticket(self, input_data: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            customer_id = input_data["customerId"]
            if customer_id not in self.customers:
                raise NotFoundError("Customer", customer_id)
            item = {
                "id": _new_id("ticket"),
                "customerId": customer_id,
                "subject": input_data["subject"],
                "rawMessage": input_data["rawMessage"],
                "status": "open",
                "createdAt": _now(),
            }
            self.tickets[item["id"]] = item
            self._audit("SYSTEM", "TICKET_CREATED", item["id"], {"customerId": customer_id})
            return item.copy()

    async def create_refund_proposal(self, input_data: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            ticket_id = input_data["ticketId"]
            invoice_id = input_data["invoiceId"]
            policy_id = input_data["policyId"]
            amount = input_data["amountCents"]
            key = ("refund-proposal", input_data["idempotencyKey"])
            shape = _fingerprint([ticket_id, invoice_id, policy_id, amount])
            previous = self._previous(key, shape)
            if previous:
                return {**previous, "replayed": True}

            ticket = self.tickets.get(ticket_id)
            if ticket is None:
                raise NotFoundError("Ticket", ticket_id)
            if ticket["status"] != "open":
                raise StateConflictError("Ticket is not open for a refund proposal")
            customer = self.customers.get(ticket["customerId"])
            if customer is None:
                raise NotFoundError("Customer", ticket["customerId"])
            invoice = self.invoices.get(invoice_id)
            if invoice is None:
                raise NotFoundError("Invoice", invoice_id)
            policy = self.policies.get(policy_id)
            if policy is None:
                raise NotFoundError("Policy", policy_id)
            if any(
                item["ticketId"] == ticket_id
                and item.get("targetInvoiceId") == invoice_id
                and item["actionType"] == "ISSUE_REFUND"
                and item["status"] in ("PROPOSED", "APPROVED")
                for item in self.proposals.values()
            ):
                raise StateConflictError(
                    "An unresolved refund proposal already exists for this invoice"
                )

            assessment = assess_refund(customer, invoice, policy, amount)
            if assessment["disposition"] == "REJECTED":
                self._audit(
                    "SYSTEM",
                    "REFUND_ASSESSMENT_REJECTED",
                    ticket_id,
                    {
                        "invoiceId": invoice_id,
                        "policyId": policy_id,
                        "amountCents": amount,
                        "reason": assessment["reason"],
                    },
                )
                raise PolicyMismatchError(str(assessment["reason"]))

            needs_approval = assessment["disposition"] == "REQUIRES_APPROVAL"
            reasons = assessment.get("reasons", [])
            proposal = {
                "id": _new_id("proposal"),
                "ticketId": ticket_id,
                "customerId": customer["id"],
                "actionType": "ISSUE_REFUND",
                "targetInvoiceId": invoice_id,
                "amountCents": amount,
                "matchedPolicyId": policy_id,
                "policyCitation": policy["fullText"],
                "requiresHumanApproval": needs_approval,
                "approvalReason": ", ".join(reasons) if needs_approval else None,
                "status": "PROPOSED",
                "createdAt": _now(),
            }
            self.proposals[proposal["id"]] = proposal
            if needs_approval:
                self.tickets[ticket_id] = {**ticket, "status": "pending_approval"}
            self._remember(key, shape, {"proposal": proposal})
            self._audit(
                "SYSTEM",
                "REFUND_PROPOSED",
                proposal["id"],
                {
                    "ticketId": ticket_id,
                    "invoiceId": invoice_id,
                    "policyId": policy_id,
                    "amountCents": amount,
                    "requiresHumanApproval": needs_approval,
                },
            )
            return {"proposal": proposal.copy(), "replayed": False}

    async def decide_refund_proposal(self, input_data: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            proposal_id = input_data["proposalId"]
            decision = input_data["decision"]
            operator_id = input_data["operatorId"]
            key = ("refund-decision", input_data["idempotencyKey"])
            shape = _fingerprint([proposal_id, decision, operator_id])
            previous = self._previous(key, shape)
            if previous:
                return {**previous, "replayed": True}

            proposal = self.proposals.get(proposal_id)
            if proposal is None:
                raise NotFoundError("Refund proposal", proposal_id)
            if proposal["status"] != "PROPOSED":
                raise StateConflictError("Refund proposal already has a decision")
            ticket = self.tickets.get(proposal["ticketId"])
            if ticket is None:
                raise NotFoundError("Ticket", proposal["ticketId"])
            if proposal["requiresHumanApproval"] and ticket["status"] != "pending_approval":
                raise StateConflictError("Ticket is not waiting for approval")

            status = "APPROVED" if decision == "APPROVE" else "REJECTED"
            updated = {**proposal, "status": status}
            self.proposals[proposal_id] = updated
            self.tickets[ticket["id"]] = {
                **ticket,
                "status": "open" if decision == "APPROVE" else "rejected",
            }
            self._audit(
                "OPERATOR",
                f"REFUND_{decision}",
                proposal_id,
                {
                    "ticketId": ticket["id"],
                    "operatorId": operator_id,
                },
                operator_id,
            )
            result = {"proposal": updated.copy()}
            self._remember(key, shape, result)
            return {**result, "replayed": False}

    async def execute_refund_proposal(self, input_data: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            proposal_id = input_data["proposalId"]
            key = ("refund-execution", input_data["idempotencyKey"])
            shape = _fingerprint(proposal_id)
            previous = self._previous(key, shape)
            if previous:
                return {**previous, "replayed": True}

            proposal = self.proposals.get(proposal_id)
            if proposal is None:
                raise NotFoundError("Refund proposal", proposal_id)
            invoice_id = proposal.get("targetInvoiceId")
            amount = proposal.get("amountCents")
            if proposal["actionType"] != "ISSUE_REFUND" or not invoice_id or amount is None:
                raise StateConflictError("Proposal is not a complete refund action")
            if proposal["status"] not in ("PROPOSED", "APPROVED"):
                raise StateConflictError("Refund proposal cannot be executed in its current state")
            ticket = self.tickets.get(proposal["ticketId"])
            customer = self.customers.get(proposal["customerId"])
            invoice = self.invoices.get(invoice_id)
            policy = self.policies.get(proposal["matchedPolicyId"])
            if ticket is None:
                raise NotFoundError("Ticket", proposal["ticketId"])
            if customer is None:
                raise NotFoundError("Customer", proposal["customerId"])
            if invoice is None:
                raise NotFoundError("Invoice", invoice_id)
            if policy is None:
                raise NotFoundError("Policy", proposal["matchedPolicyId"])

            assessment = assess_refund(customer, invoice, policy, amount)
            if assessment["disposition"] == "REJECTED":
                self._audit(
                    "SYSTEM",
                    "REFUND_EXECUTION_REJECTED",
                    proposal_id,
                    {
                        "invoiceId": invoice_id,
                        "reason": assessment["reason"],
                    },
                )
                raise PolicyMismatchError(str(assessment["reason"]))
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
                    self.proposals[proposal_id] = proposal
                    self.tickets[ticket["id"]] = {**ticket, "status": "pending_approval"}
                    self._audit(
                        "SYSTEM",
                        "REFUND_REQUIRES_APPROVAL",
                        proposal_id,
                        {
                            "ticketId": ticket["id"],
                            "reasons": reasons,
                        },
                    )
                raise ApprovalRequiredError(proposal_id, ", ".join(reasons))
            if proposal["requiresHumanApproval"] and proposal["status"] != "APPROVED":
                raise ApprovalRequiredError(
                    proposal_id, proposal.get("approvalReason") or "operator approval is missing"
                )

            refunded = invoice["refundedAmountCents"] + amount
            updated_invoice = {
                **invoice,
                "refundedAmountCents": refunded,
                "status": "refunded"
                if refunded == invoice["amountCents"]
                else "partially_refunded",
            }
            executed_at = _now()
            updated_proposal = {**proposal, "status": "EXECUTED", "executedAt": executed_at}
            unresolved = [
                item
                for item in self.proposals.values()
                if item["ticketId"] == ticket["id"]
                and item["id"] != proposal_id
                and item["status"] in ("PROPOSED", "APPROVED")
            ]
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

            self.invoices[invoice_id] = updated_invoice
            self.proposals[proposal_id] = updated_proposal
            self.tickets[ticket["id"]] = updated_ticket
            self._audit(
                "SYSTEM",
                "REFUND_EXECUTED",
                proposal_id,
                {
                    "ticketId": ticket["id"],
                    "invoiceId": invoice_id,
                    "amountCents": amount,
                    "refundedAmountCents": refunded,
                },
            )
            result = {"proposal": updated_proposal.copy(), "invoice": updated_invoice.copy()}
            self._remember(key, shape, result)
            return {**result, "replayed": False}

    def _previous(self, key: tuple[str, str], shape: str) -> dict[str, Any] | None:
        previous = self.idempotency.get(key)
        if previous is None:
            return None
        if previous[0] != shape:
            raise IdempotencyConflictError()
        return json.loads(json.dumps(previous[1]))

    def _remember(self, key: tuple[str, str], shape: str, response: dict[str, Any]) -> None:
        self.idempotency[key] = (shape, json.loads(json.dumps(response)))

    def _audit(
        self,
        actor: str,
        action_type: str,
        entity_id: str,
        details: dict[str, Any],
        operator_id: str | None = None,
    ) -> None:
        self.audit_logs.append(
            {
                "id": _new_id("audit"),
                "timestamp": _now(),
                "actor": actor,
                "operatorId": operator_id,
                "actionType": action_type,
                "entityId": entity_id,
                "details": details,
            }
        )
