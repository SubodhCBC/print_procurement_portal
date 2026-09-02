import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import {
  attachActor,
  IS_PUBLIC_KEY,
  UnauthenticatedError,
  UserType,
  type AuthenticatedActor,
} from '@/common';
import { TokenService } from '../token.service';

/**
 * Validates the bearer token and attaches the actor to the request context.
 *
 * The access token is verified by signature alone — no database round trip —
 * which is what keeps it cheap enough to run on every request. The cost is a
 * window of up to JWT_ACCESS_TTL (15m) during which a deactivated user's token
 * still works; the refresh path re-checks the account, so the window is bounded
 * by the access TTL rather than the refresh TTL.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) throw new UnauthenticatedError('Authorization header is missing or malformed');

    const claims = await this.tokens.verifyAccessToken(token);

    const actor: AuthenticatedActor = {
      userId: claims.sub,
      accountId: claims.accountId,
      ...(claims.siteId ? { siteId: claims.siteId } : {}),
      role: claims.role,
      // Tokens minted before userType was a claim carry none. Reading them as
      // EXISTING matches what every such token actually belonged to — external
      // users did not exist yet — and the claim becomes mandatory naturally as
      // the old access tokens expire.
      userType: claims.userType ?? UserType.EXISTING,
      email: claims.email,
      sessionId: claims.sid,
    };

    // Fills in the context the middleware opened while the request was still
    // anonymous, so the tenant scope, audit logger and log formatter all see
    // the actor for the rest of this request.
    attachActor(actor);

    // Also on the request object, for the @CurrentUser() parameter decorator.
    (request as FastifyRequest & { actor?: AuthenticatedActor }).actor = actor;

    return true;
  }
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;

  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return undefined;
  if (scheme.toLowerCase() !== 'bearer') return undefined;

  const token = value.trim();
  return token.length > 0 ? token : undefined;
}
