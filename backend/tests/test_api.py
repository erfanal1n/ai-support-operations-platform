from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.memory_repository import MemorySupportRepository
from backend.app.settings import OperatorCredential, Settings


def test_health_response():
    client = TestClient(create_app(Settings()))
    assert client.get("/health").json() == {"status": "ok"}


def test_session_reports_auth_and_triage_flags():
    settings = Settings()
    response = TestClient(create_app(settings)).get("/api/session")
    assert response.json() == {"authRequired": False, "operator": None, "triageEnabled": False}


def test_refund_proposal_replay_and_execution():
    client = TestClient(create_app(Settings(), MemorySupportRepository()))
    url = "/api/tickets/ticket_acme_refund_review/refund-proposals"
    headers = {"Idempotency-Key": "proposal-key-00000001"}
    body = {
        "invoiceId": "inv_acme_001",
        "policyId": "POL-REFUND-STANDARD",
        "amountCents": 4900,
    }

    created = client.post(url, json=body, headers=headers)
    replayed = client.post(url, json=body, headers=headers)
    changed = client.post(url, json={**body, "amountCents": 4800}, headers=headers)

    assert created.status_code == 201
    assert replayed.status_code == 200
    assert replayed.json()["proposal"]["id"] == created.json()["proposal"]["id"]
    assert changed.status_code == 409
    assert changed.json()["error"]["code"] == "E_IDEMPOTENCY_CONFLICT"

    proposal_id = created.json()["proposal"]["id"]
    executed = client.post(
        f"/api/refund-proposals/{proposal_id}/execute",
        headers={"Idempotency-Key": "execute-key-00000001"},
    )
    ticket = client.get("/api/tickets/ticket_acme_refund_review")
    assert executed.status_code == 201
    assert executed.json()["invoice"]["refundedAmountCents"] == 4900
    assert ticket.json()["ticket"]["status"] == "resolved"


def test_short_tenure_refund_waits_for_supervisor():
    client = TestClient(create_app(Settings(), MemorySupportRepository()))
    created = client.post(
        "/api/tickets/ticket_solo_duplicate_charge/refund-proposals",
        json={
            "invoiceId": "inv_solo_001",
            "policyId": "POL-REFUND-STANDARD",
            "amountCents": 1000,
        },
        headers={"Idempotency-Key": "proposal-key-00000002"},
    )
    proposal_id = created.json()["proposal"]["id"]
    decided = client.post(
        f"/api/refund-proposals/{proposal_id}/decision",
        json={"decision": "APPROVE", "operatorId": "supervisor-1"},
        headers={"Idempotency-Key": "decision-key-00000001"},
    )
    executed = client.post(
        f"/api/refund-proposals/{proposal_id}/execute",
        headers={"Idempotency-Key": "execute-key-00000002"},
    )

    assert created.status_code == 201
    assert created.json()["proposal"]["requiresHumanApproval"] is True
    assert decided.status_code == 201
    assert decided.json()["proposal"]["status"] == "APPROVED"
    assert executed.status_code == 201
    assert executed.json()["proposal"]["status"] == "EXECUTED"


def test_session_login_protects_operator_routes():
    credential = OperatorCredential(id="agent-1", role="agent", token="a" * 40)
    settings = Settings(
        auth_mode="session",
        session_secret="s" * 40,
        support_operator_tokens=[credential],
    )
    client = TestClient(create_app(settings, MemorySupportRepository()))

    assert client.get("/api/tickets").status_code == 401
    login = client.post("/api/session/login", json={"id": "agent-1", "token": "a" * 40})
    assert login.status_code == 200
    assert client.get("/api/tickets").status_code == 200
    forbidden = client.post(
        "/api/refund-proposals/missing/decision",
        json={"decision": "APPROVE"},
        headers={"Idempotency-Key": "decision-key-00000002"},
    )
    assert forbidden.status_code == 403
    assert client.post("/api/session/logout").status_code == 200
    assert client.get("/api/tickets").status_code == 401
