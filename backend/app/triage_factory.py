from __future__ import annotations

from backend.app.repository import SupportRepository
from backend.app.retrieval import PolicySearchEngine
from backend.app.settings import Settings
from backend.app.triage import OpenAITriageModel, TicketTriageAgent


def create_triage_agent(
    settings: Settings,
    repository: SupportRepository,
    policy_search: PolicySearchEngine,
) -> TicketTriageAgent | None:
    if settings.ai_triage_mode != "openai" or not settings.openai_api_key:
        return None
    return TicketTriageAgent(
        repository,
        policy_search,
        OpenAITriageModel(settings.openai_api_key, settings.openai_triage_model),
        settings.database_url if settings.storage_mode == "postgres" else None,
    )
