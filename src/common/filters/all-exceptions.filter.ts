import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { loadConfig } from '@/config';
import { ErrorCode, getRequestContext, isAppError, type ErrorEnvelope } from '@/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Sentry } from '@/shared/logger';

const SERVER_ERROR_THRESHOLD = 500;

interface NormalisedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  /** Unexpected errors are reported to Sentry and logged at error level. */
  unexpected: boolean;
}

/**
 * The single exit point for every failure. Guarantees:
 *   - one response shape (ErrorEnvelope) for the whole API;
 *   - internal messages and stack traces never reach the client;
 *   - every failure is correlated with a requestId the user can quote.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly isProduction = loadConfig().app.isProduction;

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    const normalised = this.normalise(exception);
    const requestId = getRequestContext()?.requestId ?? request.id ?? 'unknown';

    if (normalised.unexpected) {
      this.logger.error(
        { err: exception, requestId, path: request.url },
        `Unhandled exception: ${normalised.message}`,
      );
      Sentry.captureException(exception, { tags: { requestId } });
    } else {
      this.logger.warn({ requestId, path: request.url, code: normalised.code }, normalised.message);
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: normalised.code,
        message:
          normalised.unexpected && this.isProduction
            ? 'An unexpected error occurred. Quote the request id when reporting this.'
            : normalised.message,
        details: normalised.details,
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        path: request.url,
      },
    };

    void response.status(normalised.status).send(envelope);
  }

  private normalise(exception: unknown): NormalisedError {
    if (isAppError(exception)) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
        unexpected: false,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        code: mapStatusToCode(status),
        message: Array.isArray(message) ? message.join('; ') : message,
        details: typeof payload === 'object' ? { ...payload } : undefined,
        unexpected: status >= SERVER_ERROR_THRESHOLD,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: exception instanceof Error ? exception.message : 'Unknown error',
      unexpected: true,
    };
  }
}

/**
 * A lookup rather than a switch: HttpStatus is a numeric enum, and comparing it
 * against a plain `number` status is exactly the mismatch the linter flags.
 */
const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.BUSINESS_RULE_VIOLATION,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.NOT_IMPLEMENTED]: ErrorCode.NOT_IMPLEMENTED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.DEPENDENCY_UNAVAILABLE,
};

function mapStatusToCode(status: number): ErrorCode {
  return (
    STATUS_TO_CODE[status] ??
    (status >= SERVER_ERROR_THRESHOLD ? ErrorCode.INTERNAL_ERROR : ErrorCode.MALFORMED_REQUEST)
  );
}
