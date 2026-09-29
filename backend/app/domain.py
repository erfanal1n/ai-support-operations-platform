from __future__ import annotations

from datetime import datetime
from typing import Literal, TypedDict

PolicyCategory = Literal["refund", "cancellation", "account_tier", "dispute"]
CustomerTier = Literal["free", "starter", "enterprise"]
InvoiceStatus = Literal["paid", "partially_refunded", "refunded", "disputed"]
TicketStatus = Literal["open", "pending_approval", "resolved", "rejected"]


class Customer(TypedDict):
    id: str
    email: str
    name: str
    tenureDays: int
    tier: CustomerTier
    riskScore: int


class Invoice(TypedDict):
    id: str
    customerId: str
    amountCents: int
    refundedAmountCents: int
    currency: str
    status: InvoiceStatus
    issuedAt: str


class Policy(TypedDict, total=False):
    id: str
    category: PolicyCategory
    title: str
    summary: str
    fullText: str
    maxAutoApprovedCents: int
    minTenureDays: int
    refundWindowDays: int
    keywords: list[str]


RefundApprovalReason = Literal[
    "AMOUNT_ABOVE_AUTO_APPROVAL_LIMIT",
    "CUSTOMER_TENURE_BELOW_MINIMUM",
    "POLICY_RULE_INCOMPLETE",
]

RefundRejectionReason = Literal[
    "INVALID_AMOUNT",
    "INVALID_INVOICE_STATE",
    "INVALID_CUSTOMER_TENURE",
    "INVOICE_DISPUTED",
    "CUSTOMER_INVOICE_MISMATCH",
    "POLICY_NOT_FOR_REFUNDS",
    "INVALID_REVIEW_DATE",
    "INVALID_INVOICE_DATE",
    "INVOICE_ALREADY_REFUNDED",
    "REFUND_EXCEEDS_REMAINING_BALANCE",
    "OUTSIDE_REFUND_WINDOW",
]


def _valid_invoice_state(invoice: Invoice) -> bool:
    amount = invoice["amountCents"]
    refunded = invoice["refundedAmountCents"]
    if (
        type(amount) is not int
        or type(refunded) is not int
        or amount <= 0
        or not 0 <= refunded <= amount
    ):
        return False

    return {
        "paid": refunded == 0,
        "partially_refunded": 0 < refunded < amount,
        "refunded": refunded == amount,
        "disputed": True,
    }.get(invoice["status"], False)


def assess_refund(
    customer: Customer,
    invoice: Invoice,
    policy: Policy,
    amount_cents: int,
    now: datetime | None = None,
) -> dict[str, object]:
    if type(amount_cents) is not int or amount_cents <= 0:
        return {"disposition": "REJECTED", "reason": "INVALID_AMOUNT"}

    now = now or datetime.now().astimezone()
    if now.tzinfo is None:
        return {"disposition": "REJECTED", "reason": "INVALID_REVIEW_DATE"}

    if customer["id"] != invoice["customerId"]:
        return {"disposition": "REJECTED", "reason": "CUSTOMER_INVOICE_MISMATCH"}
    if type(customer["tenureDays"]) is not int or customer["tenureDays"] < 0:
        return {"disposition": "REJECTED", "reason": "INVALID_CUSTOMER_TENURE"}
    if policy.get("category") != "refund":
        return {"disposition": "REJECTED", "reason": "POLICY_NOT_FOR_REFUNDS"}
    if not _valid_invoice_state(invoice):
        return {"disposition": "REJECTED", "reason": "INVALID_INVOICE_STATE"}
    if invoice["status"] == "disputed":
        return {"disposition": "REJECTED", "reason": "INVOICE_DISPUTED"}

    remaining = invoice["amountCents"] - invoice["refundedAmountCents"]
    if remaining == 0:
        return {"disposition": "REJECTED", "reason": "INVOICE_ALREADY_REFUNDED"}
    if amount_cents > remaining:
        return {"disposition": "REJECTED", "reason": "REFUND_EXCEEDS_REMAINING_BALANCE"}

    try:
        issued_at = datetime.fromisoformat(invoice["issuedAt"].replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return {"disposition": "REJECTED", "reason": "INVALID_INVOICE_DATE"}
    if issued_at.tzinfo is None or issued_at > now:
        return {"disposition": "REJECTED", "reason": "INVALID_INVOICE_DATE"}

    maximum = policy.get("maxAutoApprovedCents")
    tenure = policy.get("minTenureDays")
    window = policy.get("refundWindowDays")
    if any(type(value) is not int or value < 0 for value in (maximum, tenure, window)):
        return {"disposition": "REQUIRES_APPROVAL", "reasons": ["POLICY_RULE_INCOMPLETE"]}
    if (now - issued_at).total_seconds() > window * 86_400:
        return {"disposition": "REJECTED", "reason": "OUTSIDE_REFUND_WINDOW"}

    reasons: list[RefundApprovalReason] = []
    if amount_cents > maximum:
        reasons.append("AMOUNT_ABOVE_AUTO_APPROVAL_LIMIT")
    if customer["tenureDays"] < tenure:
        reasons.append("CUSTOMER_TENURE_BELOW_MINIMUM")
    if reasons:
        return {"disposition": "REQUIRES_APPROVAL", "reasons": reasons}
    return {"disposition": "AUTO_APPROVABLE"}
