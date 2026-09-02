import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import {
  ForbiddenError,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
  UnauthenticatedError,
  type AuthenticatedActor,
  type Permission,
  type Role,
} from '@/common';
import { PermissionService } from './permission.service';

/**
 * Enforces @Roles() and @RequirePermissions().
 *
 * Runs after JwtAuthGuard, which is why both are registered in AuthModule in
 * that order — authentication establishes who the caller is, and this decides
 * what they may do with it.
 *
 * A route that declares neither decorator passes through. That is deliberate:
 * being authenticated is itself an authorization decision for most read
 * endpoints, and requiring a permission annotation on every handler would make
 * the annotations noise that nobody reads. Anything that mutates state or
 * crosses a portal boundary is expected to declare what it needs.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    // getAllAndOverride, not getAllAndMerge: a handler-level requirement
    // replaces the controller-level one rather than adding to it, so a route
    // can be *less* restrictive than its controller without having to be moved
    // to a different controller.
    const requiredRoles = this.reflector.getAllAndOverride<readonly Role[]>(ROLES_KEY, targets);
    const requiredPermissions = this.reflector.getAllAndOverride<readonly Permission[]>(
      PERMISSIONS_KEY,
      targets,
    );

    const needsRoles = requiredRoles !== undefined && requiredRoles.length > 0;
    const needsPermissions = requiredPermissions !== undefined && requiredPermissions.length > 0;
    if (!needsRoles && !needsPermissions) return true;

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { actor?: AuthenticatedActor }>();

    // Only reachable if this guard somehow ran before JwtAuthGuard. Failing
    // closed with a 401 is the right answer either way.
    if (!request.actor) throw new UnauthenticatedError('Authentication required');
    const actor = request.actor;

    if (needsRoles && !requiredRoles.includes(actor.role)) {
      throw new ForbiddenError('Your role does not have access to this resource', {
        details: { requiredRoles, role: actor.role },
      });
    }

    if (needsPermissions) {
      const effective = await this.permissions.resolve(actor);
      const missing = requiredPermissions.filter((permission) => !effective.has(permission));

      if (missing.length > 0) {
        // The missing permission names are safe to return: they are a fixed,
        // public vocabulary, and telling an integrator which permission their
        // token lacks saves a support round trip. No grant data is exposed.
        throw new ForbiddenError('You do not have permission to perform this action', {
          details: { missingPermissions: missing },
        });
      }
    }

    return true;
  }
}
