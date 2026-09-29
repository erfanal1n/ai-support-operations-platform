from __future__ import annotations

from typing import Any


class AppError(Exception):
    def __init__(
        self,
        message: str,
        code: str,
        status_code: int = 400,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.details = details


class NotFoundError(AppError):
    def __init__(self, entity: str, entity_id: str) -> None:
        super().__init__(f"{entity} with id '{entity_id}' was not found", "E_NOT_FOUND", 404)


class ValidationError(AppError):
    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(message, "E_VALIDATION_FAILED", 422, details)


class ApprovalRequiredError(AppError):
    def __init__(self, proposal_id: str, reason: str) -> None:
        super().__init__(
            f"Action proposal '{proposal_id}' requires human approval: {reason}",
            "E_APPROVAL_REQUIRED",
            403,
        )


class PolicyMismatchError(AppError):
    def __init__(self, reason: str) -> None:
        super().__init__(
            f"Operation rejected by policy verification: {reason}",
            "E_POLICY_MISMATCH",
            422,
        )


class IdempotencyConflictError(AppError):
    def __init__(self) -> None:
        super().__init__(
            "Idempotency key was already used for a different request",
            "E_IDEMPOTENCY_CONFLICT",
            409,
        )


class StateConflictError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "E_STATE_CONFLICT", 409)


class ServiceUnavailableError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "E_SERVICE_UNAVAILABLE", 503)


class UnauthorizedError(AppError):
    def __init__(self, message: str = "Authentication is required") -> None:
        super().__init__(message, "E_UNAUTHORIZED", 401)


class TooManyRequestsError(AppError):
    def __init__(self) -> None:
        super().__init__("Too many sign-in attempts. Try again later.", "E_RATE_LIMITED", 429)


class ForbiddenError(AppError):
    def __init__(self, message: str = "This action requires supervisor access") -> None:
        super().__init__(message, "E_FORBIDDEN", 403)

