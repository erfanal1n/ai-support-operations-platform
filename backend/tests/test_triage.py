from __future__ import annotations

import pytest

from backend.app.memory_repository import MemorySupportRepository
from backend.app.retrieval import KeywordPolicySearch
from backend.app.triage import TicketTriageAgent


class FixedTriageModel:
    def __init__(self, policy_id: str = "POL-REFUND-STANDARD") -> None:
        self.policy_id = policy_id

    async def generate(self, ticket, customer, policies, invoices):
        assert ticket["rawMessage"]
        assert "email" not in customer
        return {
            "summary": "The customer reports a duplicate charge.",
            "replyDraft": "I can review the two entries on your account.",
            "recommendedAction": "refund_review",
            "decisionBasis": "The ticket says the plan was charged twice.",
            "policyIds": [self.policy_id],
            "invoiceIds": [invoices[0]["id"]],
        }, {
            "inputTokens": 100,
            "outputTokens": 40,
            "totalTokens": 140,
        }


@pytest.mark.asyncio
async def test_graph_builds_review_only_result_from_retrieved_evidence():
    agent = TicketTriageAgent(
        MemorySupportRepository(),
        KeywordPolicySearch(),
        FixedTriageModel(),
    )
    await agent.open()
    result = await agent.triage("ticket_solo_duplicate_charge", "run-id-000000000001")

    assert result["recommendedAction"] == "refund_review"
    assert result["policyIds"] == ["POL-REFUND-STANDARD"]
    assert result["invoiceIds"] == ["inv_solo_001"]
    assert result["requiresHumanReview"] is True
    assert result["metrics"]["modelCalls"] == 1
    assert result["metrics"]["tokenUsage"]["totalTokens"] == 140


@pytest.mark.asyncio
async def test_graph_rejects_a_citation_outside_retrieved_evidence():
    agent = TicketTriageAgent(
        MemorySupportRepository(),
        KeywordPolicySearch(),
        FixedTriageModel("POL-NOT-RETRIEVED"),
    )
    await agent.open()

    with pytest.raises(ValueError, match="unavailable policy"):
        await agent.triage("ticket_solo_duplicate_charge", "run-id-000000000002")


@pytest.mark.asyncio
async def test_graph_streams_progress_and_a_final_result():
    agent = TicketTriageAgent(
        MemorySupportRepository(),
        KeywordPolicySearch(),
        FixedTriageModel(),
    )
    await agent.open()
    events = [
        item async for item in agent.stream("ticket_solo_duplicate_charge", "run-id-000000000003")
    ]

    assert events[0] == {"event": "progress", "data": {"stage": "ticket_loaded"}}
    assert events[-1]["event"] == "result"
    assert events[-1]["data"]["requiresHumanReview"] is True
