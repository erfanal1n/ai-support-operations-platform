from __future__ import annotations

from backend.app.memory_repository import MemorySupportRepository
from backend.app.postgres_repository import PostgresSupportRepository
from backend.app.repository import SupportRepository
from backend.app.settings import Settings


def create_repository(settings: Settings) -> SupportRepository:
    if settings.storage_mode == "postgres":
        assert settings.database_url is not None
        return PostgresSupportRepository(settings.database_url)
    return MemorySupportRepository()
