import type { ErrorCode } from '../constants/error-codes';

/**
 * The single response shape for every failure the API produces. Frontend and
 * integration partners can rely on this being stable across all endpoints.
 */
export interface ErrorEnvelope {
  readonly error: {
    /** Stable machine-readable code — branch on this. */
    readonly code: ErrorCode;
    /** Human-readable, safe to display. Never contains internals. */
    readonly message: string;
    /** Optional structured context, e.g. per-field validation failures. */
    readonly details?: Record<string, unknown>;
  };
  readonly meta: {
    /** Correlates the response with server logs and Sentry. */
    readonly requestId: string;
    readonly timestamp: string;
    readonly path: string;
  };
}

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}
