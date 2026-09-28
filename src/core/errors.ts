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
