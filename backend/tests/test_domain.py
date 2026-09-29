from datetime import UTC, datetime, timedelta

import pytest

from backend.app.domain import assess_refund


@pytest.fixture
def refund_case():
    return {
        "customer": {
            "id": "cust_1",
            "email": "a@example.com",
            "name": "A",
            "tenureDays": 50,
            "tier": "starter",
            "riskScore": 10,
        },
        "invoice": {
            "id": "inv_1",
            "customerId": "cust_1",
            "amountCents": 9000,
            "refundedAmountCents": 0,
            "currency": "USD",
            "status": "paid",
            "issuedAt": (datetime.now(UTC) - timedelta(days=2)).isoformat(),
        },
        "policy": {
            "id": "p1",
            "category": "refund",
            "title": "Refund",
            "summary": "",
            "fullText": "",
            "maxAutoApprovedCents": 5000,
            "minTenureDays": 30,
            "refundWindowDays": 14,
            "keywords": [],
        },
    }


def test_small_valid_refund_can_be_approved(refund_case):
    assert assess_refund(**refund_case, amount_cents=4900)["disposition"] == "AUTO_APPROVABLE"


def test_large_refund_needs_a_supervisor(refund_case):
    result = assess_refund(**refund_case, amount_cents=5100)
    assert result == {
        "disposition": "REQUIRES_APPROVAL",
        "reasons": ["AMOUNT_ABOVE_AUTO_APPROVAL_LIMIT"],
    }


@pytest.mark.parametrize(
    ("amount", "reason"),
    [
        (0, "INVALID_AMOUNT"),
        (9001, "REFUND_EXCEEDS_REMAINING_BALANCE"),
    ],
)
def test_invalid_refund_is_rejected(refund_case, amount, reason):
    assert assess_refund(**refund_case, amount_cents=amount) == {
        "disposition": "REJECTED",
        "reason": reason,
    }


def test_disputed_invoice_is_never_refunded(refund_case):
    refund_case["invoice"]["status"] = "disputed"
    assert assess_refund(**refund_case, amount_cents=1000)["reason"] == "INVOICE_DISPUTED"
