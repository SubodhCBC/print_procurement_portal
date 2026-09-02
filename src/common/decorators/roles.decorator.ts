import { SetMetadata } from '@nestjs/common';
import type { Role } from '../interfaces/request-context.interface';

export const ROLES_KEY = 'auth:roles';

/**
 * Restricts a route to the listed roles. Any one of them is enough.
 *
 * A coarse check, and usually the wrong tool on its own: "which role are you"
 * answers less than "what are you allowed to do", which is what
 * @RequirePermissions asks. Use this for endpoints whose whole existence is
 * tied to a portal — the admin-only integration console, say — and prefer
 * permissions everywhere else.
 *
 * Combining the two on one handler is an AND: the caller must hold one of the
 * roles *and* all of the permissions.
 */
export const Roles = (...roles: readonly Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
