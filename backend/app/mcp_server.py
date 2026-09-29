from __future__ import annotations

import asyncio
import json
from typing import Literal

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from backend.app.repository import SupportRepository
from backend.app.repository_factory import create_repository
from backend.app.search_factory import create_policy_search
from backend.app.settings import Settings, get_settings


def create_server(repository: SupportRepository, settings: Settings) -> MCPServer:
    policy_search = create_policy_search(settings, repository)
    server = MCPServer(
        name="support-operations",
        title="Support Operations",
        description="Read-only support case and policy lookup tools.",
        version="0.2.0",
    )
    read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)

    @server.tool(
        name="list_support_cases",
        description="List cases by status. Does not return customer email addresses.",
        annotations=read_only,
        structured_output=False,
    )
    async def list_support_cases(
        status: Literal["open", "pending_approval", "resolved", "rejected"] | None = None,
    ) -> str:
        cases = await repository.list_tickets(status)
        return json.dumps(cases, separators=(",", ":"), ensure_ascii=False)

    @server.tool(
        name="read_support_case",
        description=(
            "Read one case, its customer-safe invoice fields, and matching policy evidence."
        ),
        annotations=read_only,
        structured_output=False,
    )
    async def read_support_case(ticket_id: str) -> str:
        ticket = await repository.get_ticket(ticket_id)
        if ticket is None:
            return json.dumps({"error": "Case not found"})
        hits = await policy_search.search(
            await repository.list_policies(), f"{ticket['subject']}\n{ticket['rawMessage']}"
        )
        context = await repository.get_ticket_context(ticket_id, hits)
        return json.dumps(context, separators=(",", ":"), ensure_ascii=False)

    @server.tool(
        name="search_support_policies",
        description="Find policy text relevant to a short support question.",
        annotations=read_only,
        structured_output=False,
    )
    async def search_support_policies(query: str) -> str:
        hits = await policy_search.search(await repository.list_policies(), query)
        return json.dumps(
            [
                {
                    "policy": {
                        key: hit["policy"][key] for key in ("id", "title", "summary", "fullText")
                    },
                    "matchedKeywords": hit["matchedKeywords"],
                }
                for hit in hits
            ],
            separators=(",", ":"),
            ensure_ascii=False,
        )

    return server


async def serve() -> None:
    settings = get_settings()
    repository = create_repository(settings)
    server = create_server(repository, settings)
    await repository.open()
    try:
        await server.run_stdio_async()
    finally:
        await repository.close()


def main() -> None:
    asyncio.run(serve())


if __name__ == "__main__":
    main()
