from __future__ import annotations

from typing import Any

import pytest

from backend.app.memory_repository import MemorySupportRepository
from backend.app.retrieval import SemanticPolicySearch


def _axis(index: int) -> list[float]:
    vector = [0.0] * 1536
    vector[index] = 1.0
    return vector


class FixedEmbeddings:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(texts)
        vectors = []
        for text in texts:
            normalized = text.lower()
            if "standard subscription" in normalized or "charged twice" in normalized:
                vectors.append(_axis(0))
            elif "outage" in normalized:
                vectors.append(_axis(1))
            else:
                vectors.append(_axis(2))
        return vectors


@pytest.mark.asyncio
async def test_semantic_retrieval_indexes_then_reuses_policy_vectors():
    repository = MemorySupportRepository()
    embeddings = FixedEmbeddings()
    retriever = SemanticPolicySearch(repository, embeddings, "fixture-model")
    policies = await repository.list_policies()

    hits = await retriever.search(policies, "I was charged twice")
    assert hits[0]["policy"]["id"] == "POL-REFUND-STANDARD"
    assert hits[0]["matchedKeywords"] == ["charged twice"]
    assert len(embeddings.calls) == 2

    await retriever.search(policies, "I was charged twice")
    assert len(embeddings.calls) == 3
    assert len(embeddings.calls[-1]) == 1


@pytest.mark.asyncio
async def test_semantic_retrieval_reindexes_changed_policy_text():
    repository = MemorySupportRepository()
    embeddings = FixedEmbeddings()
    retriever = SemanticPolicySearch(repository, embeddings, "fixture-model")
    policies: list[dict[str, Any]] = await repository.list_policies()
    await retriever.search(policies, "I was charged twice")

    policies[0]["summary"] = "The revised billing policy."
    await retriever.search(policies, "I was charged twice")

    assert len(embeddings.calls[-2]) == 1
    assert len(embeddings.calls[-1]) == 1
