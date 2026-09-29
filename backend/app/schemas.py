from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

SupportId = Annotated[str, StringConstraints(min_length=1, max_length=120, strip_whitespace=True)]
SupportText = Annotated[
    str, StringConstraints(min_length=1, max_length=5000, strip_whitespace=True)
]


class RequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateTicketRequest(RequestBody):
    customer_id: SupportId = Field(alias="customerId")
    subject: Annotated[str, StringConstraints(min_length=3, max_length=180, strip_whitespace=True)]
    raw_message: SupportText = Field(alias="rawMessage")


class RefundProposalRequest(RequestBody):
    invoice_id: SupportId = Field(alias="invoiceId")
    policy_id: SupportId = Field(alias="policyId")
    amount_cents: Annotated[
        int, Field(alias="amountCents", strict=True, gt=0, le=9_007_199_254_740_991)
    ]


class RefundDecisionRequest(RequestBody):
    decision: Literal["APPROVE", "REJECT"]
    operator_id: SupportId | None = Field(alias="operatorId", default=None)


class LoginRequest(RequestBody):
    id: SupportId
    token: Annotated[str, StringConstraints(min_length=1, max_length=512)]


TicketStatusFilter = Literal["open", "pending_approval", "resolved", "rejected"]
