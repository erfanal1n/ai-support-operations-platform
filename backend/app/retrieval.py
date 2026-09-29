from __future__ import annotations

import asyncio
import hashlib
import math
from collections.abc import Iterable
from typing import Any, Protocol

from openai import AsyncOpenAI

from backend.app.policy_search import search_policies
from backend.app.repository import SupportRepository

EMBEDDING_DIMENSIONS = 1536
MINIMUM_SIMILARITY = 0.3
KEYWORD_BOOST = 0.12


class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class PolicySearchEngine(Protocol):
    async def search(
        self,
        policies: Iterable[dict[str, Any]],
        query: str,
        limit: int = 3,
    ) -> list[dict[str, Any]]: ...


class KeywordPolicySearch:
    async def search(
        self,
        policies: Iterable[dict[str, Any]],
        query: str,
        limit: int = 3,
    ) -> list[dict[str, Any]]:
        return search_policies(policies, query, limit)


class OpenAIEmbeddingProvider:
    def __init__(self, api_key: str, model: str) -> None:
        self.client = AsyncOpenAI(api_key=api_key, timeout=15, max_retries=2)
        self.model = model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        response = await self.client.embeddings.create(
            model=self.model,
            input=texts,
            dimensions=EMBEDDING_DIMENSIONS,
            encoding_format="float",
        )
        ordered = sorted(response.data, key=lambda item: item.index)
        if len(ordered) != len(texts):
            raise ValueError("Embedding response did not match the input count")
        return [item.embedding for item in ordered]


def policy_text(policy: dict[str, Any]) -> str:
    return f"{policy['title']}\n{policy['summary']}\n{policy['fullText']}"


def policy_source_hash(policy: dict[str, Any]) -> str:
    return hashlib.sha256(policy_text(policy).encode()).hexdigest()


def _validate_vector(vector: list[float]) -> None:
    if len(vector) != EMBEDDING_DIMENSIONS or any(not math.isfinite(value) for value in vector):
        raise ValueError("Embedding provider returned an invalid vector")


def _cosine(left: list[float], right: list[float]) -> float:
    _validate_vector(left)
    _validate_vector(right)
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if not left_norm or not right_norm:
        raise ValueError("Embedding vector has zero magnitude")
    return dot / (left_norm * right_norm)


class SemanticPolicySearch:
    def __init__(
        self,
        repository: SupportRepository,
        embeddings: EmbeddingProvider,
        model: str,
    ) -> None:
        self.repository = repository
        self.embeddings = embeddings
        self.model = model
        self._index_lock = asyncio.Lock()

    async def search(
        self,
        policies: Iterable[dict[str, Any]],
        query: str,
        limit: int = 3,
    ) -> list[dict[str, Any]]:
        if type(limit) is not int or limit < 1:
            raise ValueError("limit must be a positive integer")
        policy_list = list(policies)
        if not policy_list or not query.strip():
            return []

        await self._index_policies(policy_list)
        query_vectors = await self.embeddings.embed([query])
        if len(query_vectors) != 1:
            raise ValueError("Embedding provider returned no query vector")
        query_vector = query_vectors[0]
        _validate_vector(query_vector)

        keyword_hits = {
            hit["policy"]["id"]: hit
            for hit in search_policies(policy_list, query, max(len(policy_list), 1))
        }
        candidates = await self.repository.search_policy_embeddings(
            query_vector,
            self.model,
            [policy["id"] for policy in policy_list],
            max(limit * 4, 20),
        )
        policies_by_id = {policy["id"]: policy for policy in policy_list}
        hits = []
        for candidate in candidates:
            policy = policies_by_id.get(candidate["policyId"])
            if policy is None:
                continue
            keyword_hit = keyword_hits.get(policy["id"])
            score = candidate["similarity"] + (KEYWORD_BOOST if keyword_hit else 0)
            if score >= MINIMUM_SIMILARITY:
                hits.append(
                    {
                        "policy": policy,
                        "matchedKeywords": keyword_hit["matchedKeywords"] if keyword_hit else [],
                        "score": score,
                    }
                )
        hits.sort(key=lambda hit: (-hit["score"], hit["policy"]["id"]))
        return hits[:limit]

    async def _index_policies(self, policies: list[dict[str, Any]]) -> None:
        async with self._index_lock:
            ids = [policy["id"] for policy in policies]
            stored = await self.repository.get_policy_embedding_hashes(self.model, ids)
            missing = [
                policy
                for policy in policies
                if stored.get(policy["id"]) != policy_source_hash(policy)
            ]
            if not missing:
                return
            vectors = await self.embeddings.embed([policy_text(policy) for policy in missing])
            if len(vectors) != len(missing):
                raise ValueError("Embedding response did not match the policy count")
            records = []
            for policy, vector in zip(missing, vectors, strict=True):
                _validate_vector(vector)
                records.append(
                    {
                        "policyId": policy["id"],
                        "model": self.model,
                        "sourceHash": policy_source_hash(policy),
                        "embedding": vector,
                    }
                )
            await self.repository.upsert_policy_embeddings(records)
