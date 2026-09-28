export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entity} with id '${id}' was not found`, 'E_NOT_FOUND', 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'E_VALIDATION_FAILED', 422, details);
  }
}

export class ApprovalRequiredError extends AppError {
  constructor(proposalId: string, reason: string) {
    super(`Action proposal '${proposalId}' requires human approval: ${reason}`, 'E_APPROVAL_REQUIRED', 403);
  }
}

export class PolicyMismatchError extends AppError {
  constructor(reason: string) {
    super(`Operation rejected by policy verification: ${reason}`, 'E_POLICY_MISMATCH', 422);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super('Idempotency key was already used for a different request', 'E_IDEMPOTENCY_CONFLICT', 409);
  }
}

export class StateConflictError extends AppError {
  constructor(message: string) {
    super(message, 'E_STATE_CONFLICT', 409);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 'E_SERVICE_UNAVAILABLE', 503);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required') {
    super(message, 'E_UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'This action requires supervisor access') {
    super(message, 'E_FORBIDDEN', 403);
  }
}
