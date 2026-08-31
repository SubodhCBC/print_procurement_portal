import { Injectable, type NestMiddleware } from '@nestjs/common';
import { runWithRequestContext, type RequestContext } from '@/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Opens the AsyncLocalStorage scope for the request.
 *
 * Runs before everything else so that guards, interceptors, services and the
 * Prisma tenant guard all observe the same context. The actor is attached
 * later by the auth guard via `attachActor` — the context object itself is
 * created here, while the request is still anonymous.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: FastifyRequest['raw'], _res: FastifyReply['raw'], next: () => void): void {
    const request = req as FastifyRequest['raw'] & { id?: string };

    const context: RequestContext = {
      requestId: request.id ?? 'unknown',
      startedAt: Date.now(),
      ip: request.socket?.remoteAddress,
      userAgent: request.headers['user-agent'],
    };

    runWithRequestContext(context, next);
  }
}
