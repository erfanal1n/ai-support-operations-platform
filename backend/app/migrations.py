from __future__ import annotations

import hashlib
from pathlib import Path

import asyncpg

LOCK_ID = 817435091220


async def run_migrations(database_url: str) -> None:
    connection = await asyncpg.connect(database_url, timeout=5)
    try:
        await connection.execute("SELECT pg_advisory_lock($1::bigint)", LOCK_ID)
        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                checksum TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        directory = Path(__file__).resolve().parents[2] / "database" / "migrations"
        for path in sorted(directory.glob("*.sql")):
            contents = path.read_bytes()
            sql = contents.decode("utf-8")
            checksum = hashlib.sha256(contents).hexdigest()
            applied = await connection.fetchval(
                "SELECT checksum FROM schema_migrations WHERE version = $1", path.name
            )
            if applied is not None:
                if applied != checksum:
                    raise RuntimeError(f"Applied migration '{path.name}' has changed")
                continue
            async with connection.transaction():
                await connection.execute(sql)
                await connection.execute(
                    "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
                    path.name,
                    checksum,
                )
    finally:
        try:
            await connection.execute("SELECT pg_advisory_unlock($1::bigint)", LOCK_ID)
        finally:
            await connection.close()
