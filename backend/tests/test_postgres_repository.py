from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.migrations import run_migrations
from backend.app.postgres_repository import PostgresSupportRepository
from backend.app.settings import Settings

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")


@pytest.mark.asyncio
async def test_postgres_refund_workflow_is_atomic_and_idempotent():
    assert DATABASE_URL is not None
    await run_migrations(DATABASE_URL)
    repository = PostgresSupportRepository(DATABASE_URL)
    await repository.open()
    assert repository.pool is not None

    suffix = uuid.uuid4().hex
    customer_id = f"customer_test_{suffix}"
    invoice_id = f"invoice_test_{suffix}"
    key = f"proposal-test-{suffix}"
    ticket = None
    proposal_id = None
    try:
        await repository.pool.execute(
            """
            INSERT INTO customers(id, email, name, tenure_days, tier, risk_score)
            VALUES ($1, $2, 'Test Customer', 90, 'starter', 10)
            """,
            customer_id,
            f"{suffix}@test.invalid",
        )
        await repository.pool.execute(
            """
            INSERT INTO invoices(
                id, customer_id, amount_cents, refunded_amount_cents, currency, status, issued_at
            ) VALUES ($1, $2, 4900, 0, 'USD', 'paid', NOW() - INTERVAL '2 days')
            """,
            invoice_id,
            customer_id,
        )
        ticket = await repository.create_ticket(
            {
                "customerId": customer_id,
                "subject": "Duplicate subscription charge",
                "rawMessage": "I was charged twice for my plan.",
            }
        )
        proposal_input = {
            "ticketId": ticket["id"],
            "invoiceId": invoice_id,
            "policyId": "POL-REFUND-STANDARD",
            "amountCents": 4900,
            "idempotencyKey": key,
        }
        results = await asyncio.gather(
            repository.create_refund_proposal(proposal_input),
            repository.create_refund_proposal(proposal_input),
        )
        proposal_id = results[0]["proposal"]["id"]
        assert {item["replayed"] for item in results} == {False, True}
        assert results[0]["proposal"]["id"] == results[1]["proposal"]["id"]

        execution = await repository.execute_refund_proposal(
            {
                "proposalId": proposal_id,
                "idempotencyKey": f"execute-test-{suffix}",
            }
        )
        replay = await repository.execute_refund_proposal(
            {
                "proposalId": proposal_id,
                "idempotencyKey": f"execute-test-{suffix}",
            }
        )
        assert execution["invoice"]["refundedAmountCents"] == 4900
        assert replay["replayed"] is True
        assert replay["proposal"]["status"] == "EXECUTED"
        assert (await repository.get_ticket(ticket["id"]))["status"] == "resolved"
    finally:
        if repository.pool is not None:
            async with repository.pool.acquire() as connection:
                async with connection.transaction():
                    await connection.execute(
                        "DELETE FROM idempotency_records WHERE key LIKE $1",
                        f"%{suffix}%",
                    )
                    await connection.execute(
                        "DELETE FROM audit_logs WHERE entity_id = ANY($1::text[])",
                        [ticket["id"], proposal_id]
                        if ticket and proposal_id
                        else [ticket["id"]]
                        if ticket
                        else [],
                    )
                    if proposal_id:
                        await connection.execute(
                            "DELETE FROM action_proposals WHERE id = $1", proposal_id
                        )
                    await connection.execute(
                        "DELETE FROM tickets WHERE customer_id = $1", customer_id
                    )
                    await connection.execute("DELETE FROM invoices WHERE id = $1", invoice_id)
                    await connection.execute("DELETE FROM customers WHERE id = $1", customer_id)
        await repository.close()


def test_fastapi_uses_postgres_repository():
    assert DATABASE_URL is not None
    settings = Settings(storage_mode="postgres", database_url=DATABASE_URL)
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").json() == {"status": "ok"}
        tickets = client.get("/api/tickets")
    assert tickets.status_code == 200
    assert len(tickets.json()["tickets"]) >= 3
