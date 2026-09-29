from __future__ import annotations

import asyncio
import json

from backend.app.memory_repository import MemorySupportRepository
from backend.app.retrieval import KeywordPolicySearch

CASES = (
    ("charged-twice", "Why was my subscription charged twice?", "POL-REFUND-STANDARD"),
    ("two-charges", "I see two charges for this month.", "POL-REFUND-STANDARD"),
    ("platform-outage", "The platform outage lasted three hours.", "POL-REFUND-OUTAGE"),
    ("trial-extension", "Could I get more time in my trial?", "POL-TRIAL-EXTEND"),
    ("stolen-card", "Someone used my stolen card.", "POL-DISPUTE-ESCALATE"),
    (
        "unexpected-invoice-increase",
        "My next invoice is much higher than I expected.",
        "POL-REFUND-STANDARD",
    ),
)


async def evaluate() -> dict[str, object]:
    repository = MemorySupportRepository()
    policies = await repository.list_policies()
    search = KeywordPolicySearch()
    cases = []
    reciprocal_ranks = []

    for case_id, query, expected_id in CASES:
        hits = await search.search(policies, query, limit=3)
        ranked_ids = [hit["policy"]["id"] for hit in hits]
        rank = ranked_ids.index(expected_id) + 1 if expected_id in ranked_ids else None
        if rank is not None:
            reciprocal_ranks.append(1 / rank)
        cases.append(
            {
                "id": case_id,
                "expectedPolicyId": expected_id,
                "rankedPolicyIds": ranked_ids,
                "rank": rank,
            }
        )

    return {
        "mode": "keyword",
        "caseCount": len(cases),
        "recallAt3": round(len(reciprocal_ranks) / len(cases), 4),
        "meanReciprocalRankAt3": round(sum(reciprocal_ranks) / len(cases), 4),
        "cases": cases,
    }


def main() -> None:
    print(json.dumps(asyncio.run(evaluate()), indent=2))


if __name__ == "__main__":
    main()
