from __future__ import annotations

import asyncio

from backend.app.migrations import run_migrations
from backend.app.settings import get_settings


async def main() -> None:
    settings = get_settings()
    if not settings.database_url:
        raise SystemExit("DATABASE_URL is required")
    await run_migrations(settings.database_url)
    print("Database migrations are up to date.")


if __name__ == "__main__":
    asyncio.run(main())
