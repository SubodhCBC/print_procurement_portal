import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../authorization/permissions';

export const PERMISSIONS_KEY = 'auth:permissions';

/**
 * Requires every listed permission. AND, not OR — a handler that needs either
 * of two permissions is doing two things and should be two handlers.
 *
 * Lives in `common` alongside @Public() so a feature module can declare what a
 * route needs without importing the authorization module and its database
 * dependencies. The guard that reads this metadata lives in
 * src/modules/authorization.
 */
export const RequirePermissions = (
  ...permissions: readonly Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions);
