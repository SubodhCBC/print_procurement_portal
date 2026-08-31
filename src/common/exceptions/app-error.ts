import { ErrorCode } from '../constants/error-codes';

export interface AppErrorOptions {
  /** Machine-readable detail safe to show the caller. Never put secrets here. */
  readonly details?: Record<string, unknown>;
  /** Original error, preserved for logs only — never serialised to the client. */
  readonly cause?: unknown;
}

/**
 * Every deliberately thrown error in the system extends this. The exception
 * filter turns it into the standard envelope; anything that is *not* an
 * AppError is treated as an unexpected bug and reported as INTERNAL_ERROR
 * with its message withheld.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** `true` = an expected condition (bad input, missing row), not an incident. */
  readonly isOperational = true;

  constructor(code: ErrorCode, status: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', options?: AppErrorOptions) {
    super(ErrorCode.VALIDATION_FAILED, 400, message, options);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required', options?: AppErrorOptions) {
    super(ErrorCode.UNAUTHENTICATED, 401, message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource', options?: AppErrorOptions) {
    super(ErrorCode.FORBIDDEN, 403, message, options);
  }
}

/**
 * Raised when a request reaches a row belonging to another account. Deliberately
 * distinct from ForbiddenError so it can be alarmed on separately — in a
 * multi-tenant system this is a security signal, not a routine denial.
 */
export class TenantMismatchError extends AppError {
  constructor(
    message = 'Resource does not belong to the active account',
    options?: AppErrorOptions,
  ) {
    super(ErrorCode.TENANT_MISMATCH, 403, message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', options?: AppErrorOptions) {
    super(ErrorCode.NOT_FOUND, 404, `${resource} not found`, options);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', options?: AppErrorOptions) {
    super(ErrorCode.CONFLICT, 409, message, options);
  }
}

/** Optimistic-locking failure: someone else changed the row first. */
export class StaleVersionError extends AppError {
  constructor(message = 'Resource was modified by someone else', options?: AppErrorOptions) {
    super(ErrorCode.STALE_VERSION, 409, message, options);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(ErrorCode.BUSINESS_RULE_VIOLATION, 422, message, options);
  }
}

export class DependencyUnavailableError extends AppError {
  constructor(dependency: string, options?: AppErrorOptions) {
    super(ErrorCode.DEPENDENCY_UNAVAILABLE, 503, `${dependency} is unavailable`, options);
  }
}

export class NotImplementedError extends AppError {
  constructor(what: string, options?: AppErrorOptions) {
    super(ErrorCode.NOT_IMPLEMENTED, 501, `${what} is not implemented yet`, options);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
