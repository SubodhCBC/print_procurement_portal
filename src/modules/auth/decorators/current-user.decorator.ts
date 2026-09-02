import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthenticatedError, type AuthenticatedActor } from '@/common';

/**
 * Injects the authenticated actor into a handler parameter.
 *
 * Throws rather than returning undefined on an unauthenticated request: a
 * handler that asked for the current user is not prepared to run without one,
 * and `undefined` would surface later as a confusing null dereference instead
 * of a 401 here.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedActor => {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { actor?: AuthenticatedActor }>();

    if (!request.actor) {
      throw new UnauthenticatedError('Authentication required');
    }
    return request.actor;
  },
);
