/**
 * Stable, machine-readable error codes. Clients branch on these — never on the
 * HTTP status alone and never on the message text, which is free to change.
 *
 * Adding a code is safe; renaming one is a breaking API change.
 */
export const ErrorCode = {
  // 400 — the request itself is malformed
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',

  // 401 / 403 — identity and permission
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_MISMATCH: 'TENANT_MISMATCH',

  // 404 / 409 — resource state
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',
  STALE_VERSION: 'STALE_VERSION',
  IMMUTABLE_RESOURCE: 'IMMUTABLE_RESOURCE',

  // 422 — well-formed but rejected by a business rule
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',

  // 429 — throttling
  RATE_LIMITED: 'RATE_LIMITED',

  // 500 / 502 / 503 — our fault
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
