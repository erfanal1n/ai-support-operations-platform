from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from backend.app.errors import AppError
from backend.app.settings import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()
    app = FastAPI(title="Support Operations API", version="0.2.0")

    @app.exception_handler(AppError)
    async def app_error_handler(_: Request, error: AppError) -> JSONResponse:
        body: dict[str, object] = {"code": error.code, "message": str(error)}
        if error.details is not None:
            body["details"] = error.details
        return JSONResponse(status_code=error.status_code, content={"error": body})

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/session")
    async def session_status() -> dict[str, object]:
        return {
            "authRequired": config.auth_mode == "session",
            "operator": None,
            "triageEnabled": config.ai_triage_mode == "openai" and bool(config.openai_api_key),
        }

    return app


app = create_app()

