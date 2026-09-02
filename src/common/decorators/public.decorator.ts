import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Exempts a route from the global JwtAuthGuard.
 *
 * Lives in `common` rather than in the auth module because the modules that
 * need it most — health probes, inbound webhooks — must not have to import the
 * auth module (and with it the whole database and JWT graph) just to declare a
 * route unauthenticated.
 *
 * Authentication is the default and every exemption is visible at the route it
 * applies to. The reverse — opting routes *in* — leaves a new endpoint
 * unauthenticated until someone remembers to protect it.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
