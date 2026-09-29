from __future__ import annotations

from backend.app.repository import SupportRepository
from backend.app.retrieval import (
    KeywordPolicySearch,
    OpenAIEmbeddingProvider,
    PolicySearchEngine,
    SemanticPolicySearch,
)
from backend.app.settings import Settings


def create_policy_search(
    settings: Settings,
    repository: SupportRepository,
) -> PolicySearchEngine:
    if settings.policy_retrieval_mode == "semantic":
        assert settings.openai_api_key is not None
        return SemanticPolicySearch(
            repository,
            OpenAIEmbeddingProvider(settings.openai_api_key, settings.openai_embedding_model),
            settings.openai_embedding_model,
        )
    return KeywordPolicySearch()
