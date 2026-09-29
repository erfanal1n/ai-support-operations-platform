from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.app.auth import (
    authenticate_operator,
    clear_session_cookie,
    credential_fingerprint,
    issue_session,
    login_attempt_key,
    read_session,
)
from backend.app.errors import (
    AppError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    StateConflictError,
    TooManyRequestsError,
    UnauthorizedError,
    ValidationError,
)
from backend.app.memory_repository import MemorySupportRepository
from backend.app.postgres_repository import PostgresSupportRepository
from backend.app.repository import SupportRepository
from backend.app.retrieval import PolicySearchEngine
from backend.app.schemas import (
    CreateTicketRequest,
    LoginRequest,
    RefundDecisionRequest,
    RefundProposalRequest,
    TicketStatusFilter,
)
from backend.app.search_factory import create_policy_search
from backend.app.settings import Settings, get_settings

logger = logging.getLogger("support.api")
_PUBLIC_ENDPOINTS = {
    ("GET", "/health"),
    ("GET", "/api/session"),
    ("POST", "/api/session/login"),
    ("POST", "/api/session/logout"),
}


def _validation_details(errors: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [
        {
            "path": ".".join(str(part) for part in error["loc"][1:]),
            "message": error["msg"],
        }
        for error in errors
    ]


def _checked_id(value: str, field: str) -> str:
    clean = value.strip()
    if not clean or len(clean) > 120:
        raise ValidationError(
            f"{field} is invalid", [{"path": field, "message": "Invalid identifier"}]
        )
    return clean


def _idempotency_key(value: str | None) -> str:
    key = (value or "").strip()
    if len(key) < 16 or len(key) > 200:
        raise ValidationError(
            "Idempotency-Key header is required",
            [
                {
                    "path": "Idempotency-Key",
                    "message": "String must contain between 16 and 200 characters",
                }
            ],
        )
    return key


async def _request_operator(
    request: Request,
    repository: SupportRepository,
    settings: Settings,
) -> dict[str, str] | None:
    secret = settings.session_secret or ""
    signed = read_session(request.headers.get("cookie"), secret)
    if signed is None:
        return None
    saved = await repository.get_operator_session(signed.session_hash)
    if saved is None:
        return None
    expires = datetime.fromtimestamp(signed.expires_at_ms / 1000, UTC)
    expected_expiry = expires.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if saved["expiresAt"] != expected_expiry:
        return None
    credential = next(
        (item for item in settings.support_operator_tokens if item.id == saved["operatorId"]),
        None,
    )
    if credential is None or credential_fingerprint(credential.token) != saved["credentialHash"]:
        return None
    return {"id": credential.id, "role": credential.role}


def _require_agent(request: Request, settings: Settings) -> dict[str, str] | None:
    operator = getattr(request.state, "operator", None)
    if settings.auth_mode == "session" and operator is None:
        raise UnauthorizedError()
    return operator


def _require_supervisor(request: Request, settings: Settings) -> dict[str, str] | None:
    operator = _require_agent(request, settings)
    if settings.auth_mode == "session" and operator["role"] != "supervisor":
        raise ForbiddenError()
    return operator


def create_app(
    settings: Settings | None = None,
    repository: SupportRepository | None = None,
    triage_agent: Any | None = None,
    policy_search: PolicySearchEngine | None = None,
) -> FastAPI:
    config = settings or get_settings()
    store = repository or _build_repository(config)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await store.open()
        try:
            yield
        finally:
            await store.close()

    app = FastAPI(title="Support Operations API", version="0.2.0", lifespan=lifespan)
    app.state.repository = store
    app.state.settings = config
    app.state.triage_agent = triage_agent
    policy_retriever = policy_search or create_policy_search(config, store)

    @app.middleware("http")
    async def resolve_operator(request: Request, call_next):
        request.state.operator = None
        if (
            config.auth_mode == "session"
            and (request.method, request.url.path) not in _PUBLIC_ENDPOINTS
        ):
            request.state.operator = await _request_operator(request, store, config)
            if request.state.operator is None:
                error = UnauthorizedError()
                body = {"error": {"code": error.code, "message": str(error)}}
                return JSONResponse(status_code=error.status_code, content=body)
        return await call_next(request)

    @app.exception_handler(AppError)
    async def app_error_handler(_: Request, error: AppError) -> JSONResponse:
        body: dict[str, object] = {"code": error.code, "message": str(error)}
        if error.details is not None:
            body["details"] = error.details
        headers = {}
        if isinstance(error, TooManyRequestsError):
            headers["Retry-After"] = str(error.retry_after_seconds)
        return JSONResponse(status_code=error.status_code, content={"error": body}, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_: Request, error: RequestValidationError) -> JSONResponse:
        validation = ValidationError("Request is invalid", _validation_details(error.errors()))
        return JSONResponse(
            status_code=validation.status_code,
            content={
                "error": {
                    "code": validation.code,
                    "message": str(validation),
                    "details": validation.details,
                }
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(_: Request, error: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={
                "error": {"code": f"E_HTTP_{error.status_code}", "message": "Invalid request"}
            },
        )

    @app.exception_handler(Exception)
    async def unexpected_error_handler(_: Request, error: Exception) -> JSONResponse:
        logger.error("Unhandled API error: %s", type(error).__name__)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "E_INTERNAL", "message": "Internal server error"}},
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        await store.health()
        return {"status": "ok"}

    @app.get("/api/session")
    async def session_status(request: Request) -> dict[str, object]:
        return {
            "authRequired": config.auth_mode == "session",
            "operator": await _request_operator(request, store, config),
            "triageEnabled": triage_agent is not None,
        }

    @app.post("/api/session/login")
    async def login(payload: LoginRequest, request: Request, response: Response):
        if config.auth_mode != "session":
            raise StateConflictError("Session authentication is not enabled")
        secret = config.session_secret or ""
        attempt_key = login_attempt_key(
            request.client.host if request.client else "unknown", payload.id, secret
        )
        attempt = await store.consume_login_attempt(attempt_key, 15 * 60, 5)
        if not attempt["allowed"]:
            raise TooManyRequestsError(attempt["retryAfterSeconds"])
        operator = authenticate_operator(payload.id, payload.token, config.support_operator_tokens)
        if operator is None:
            raise UnauthorizedError("Operator ID or token is invalid")
        credential = next(
            item for item in config.support_operator_tokens if item.id == operator["id"]
        )
        issued = issue_session(credential, secret, config.node_env == "production")
        await store.create_operator_session(issued)
        await store.clear_login_attempts(attempt_key)
        response.headers.append("Set-Cookie", issued["cookie"])
        return {"operator": operator}

    @app.post("/api/session/logout")
    async def logout(request: Request, response: Response):
        signed = read_session(request.headers.get("cookie"), config.session_secret or "")
        if signed:
            await store.delete_operator_session(signed.session_hash)
        response.headers.append("Set-Cookie", clear_session_cookie(config.node_env == "production"))
        return {"ok": True}

    @app.get("/api/tickets")
    async def list_tickets(
        request: Request,
        status: TicketStatusFilter | None = None,
    ) -> dict[str, Any]:
        _require_agent(request, config)
        return {"tickets": await store.list_tickets(status)}

    @app.get("/api/tickets/{ticket_id}")
    async def get_ticket(ticket_id: str, request: Request) -> dict[str, Any]:
        _require_agent(request, config)
        ticket_id = _checked_id(ticket_id, "Ticket ID")
        ticket = await store.get_ticket(ticket_id)
        if ticket is None:
            raise NotFoundError("Ticket", ticket_id)
        try:
            hits = await policy_retriever.search(await store.list_policies(), ticket["rawMessage"])
        except Exception as error:
            logger.error("Policy retrieval failed: %s", type(error).__name__)
            raise ServiceUnavailableError("Policy retrieval is temporarily unavailable") from error
        return await store.get_ticket_context(ticket_id, hits)

    @app.post("/api/tickets/{ticket_id}/triage")
    async def triage_ticket(ticket_id: str, request: Request) -> dict[str, Any]:
        _require_agent(request, config)
        ticket_id = _checked_id(ticket_id, "Ticket ID")
        if await store.get_ticket(ticket_id) is None:
            raise NotFoundError("Ticket", ticket_id)
        if triage_agent is None:
            raise ServiceUnavailableError("AI ticket triage is not enabled")
        try:
            return {"triage": await triage_agent.triage(ticket_id)}
        except AppError:
            raise
        except Exception as error:
            logger.error("Ticket triage failed: %s", type(error).__name__)
            raise ServiceUnavailableError("AI ticket triage is temporarily unavailable") from error

    @app.post("/api/tickets", status_code=201)
    async def create_ticket(payload: CreateTicketRequest, request: Request) -> dict[str, Any]:
        _require_agent(request, config)
        ticket = await store.create_ticket(payload.model_dump(by_alias=True))
        return {"ticket": ticket}

    @app.post("/api/tickets/{ticket_id}/refund-proposals")
    async def create_refund_proposal(
        ticket_id: str,
        payload: RefundProposalRequest,
        request: Request,
        response: Response,
    ) -> JSONResponse:
        _require_agent(request, config)
        ticket_id = _checked_id(ticket_id, "Ticket ID")
        key = _idempotency_key(request.headers.get("Idempotency-Key"))
        result = await store.create_refund_proposal(
            {
                **payload.model_dump(by_alias=True),
                "ticketId": ticket_id,
                "idempotencyKey": key,
            }
        )
        response.status_code = 200 if result["replayed"] else 201
        return JSONResponse(status_code=response.status_code, content=result)

    @app.post("/api/refund-proposals/{proposal_id}/decision")
    async def decide_refund_proposal(
        proposal_id: str,
        payload: RefundDecisionRequest,
        request: Request,
        response: Response,
    ) -> JSONResponse:
        operator = _require_supervisor(request, config)
        proposal_id = _checked_id(proposal_id, "Refund proposal ID")
        key = _idempotency_key(request.headers.get("Idempotency-Key"))
        operator_id = operator["id"] if operator else payload.operator_id
        if not operator_id:
            raise ValidationError("Operator ID is required")
        result = await store.decide_refund_proposal(
            {
                "proposalId": proposal_id,
                "decision": payload.decision,
                "operatorId": operator_id,
                "idempotencyKey": key,
            }
        )
        response.status_code = 200 if result["replayed"] else 201
        return JSONResponse(status_code=response.status_code, content=result)

    @app.post("/api/refund-proposals/{proposal_id}/execute")
    async def execute_refund_proposal(
        proposal_id: str,
        request: Request,
        response: Response,
    ) -> JSONResponse:
        _require_supervisor(request, config)
        proposal_id = _checked_id(proposal_id, "Refund proposal ID")
        key = _idempotency_key(request.headers.get("Idempotency-Key"))
        result = await store.execute_refund_proposal(
            {
                "proposalId": proposal_id,
                "idempotencyKey": key,
            }
        )
        response.status_code = 200 if result["replayed"] else 201
        return JSONResponse(status_code=response.status_code, content=result)

    return app


def _build_repository(settings: Settings) -> SupportRepository:
    if settings.storage_mode == "postgres":
        assert settings.database_url is not None
        return PostgresSupportRepository(settings.database_url)
    return MemorySupportRepository()


app = create_app()
