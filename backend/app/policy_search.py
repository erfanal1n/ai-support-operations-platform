from __future__ import annotations

import unicodedata
from collections.abc import Iterable
from typing import Any


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).lower()
    return " ".join("".join(char if char.isalnum() else " " for char in value).split())


def search_policies(
    policies: Iterable[dict[str, Any]], query: str, limit: int = 3
) -> list[dict[str, Any]]:
    if type(limit) is not int or limit < 1:
        raise ValueError("limit must be a positive integer")

    normalized = normalize(query)
    if not normalized:
        return []
    padded_query = f" {normalized} "
    hits = []

    for policy in policies:
        matched = [
            keyword
            for keyword in policy["keywords"]
            if (phrase := normalize(keyword)) and f" {phrase} " in padded_query
        ]
        if matched:
            score = sum(len(normalize(keyword).split()) for keyword in matched)
            hits.append({"policy": policy, "matchedKeywords": matched, "score": score})

    hits.sort(key=lambda hit: (-hit["score"], hit["policy"]["id"]))
    return hits[:limit]
