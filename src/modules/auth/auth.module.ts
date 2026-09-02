import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthorizationGuard, AuthorizationModule } from '@/modules/authorization';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LegacyUserRepository } from './legacy-user.repository';
import { PasswordHasherService } from './password/password-hasher.service';
import { TokenService } from './token.service';
import { UserProvisioningService } from './user-provisioning.service';

/**
 * Authentication across two databases.
 *
 * Both PrismaService and LegacyPrismaService come from the global
 * DatabaseModule, so nothing is imported for them here. JwtModule is registered
 * without a secret on purpose: access and refresh tokens are signed with
 * different keys, so each call passes its own — a module-level default would be
 * silently used by any future `signAsync` that forgot to.
 *
 * JwtAuthGuard is registered globally, making every route authenticated unless
 * it opts out with @Public(). See public.decorator.ts for why that direction.
 *
 * AuthorizationGuard is registered here too, immediately after it. Nest runs
 * global guards in provider-registration order, and that order is only
 * deterministic within one module — splitting the pair across two modules would
 * make "authenticate, then authorize" depend on module import order, and get it
 * wrong silently.
 */
@Module({
  imports: [JwtModule.register({}), AuthorizationModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    LegacyUserRepository,
    PasswordHasherService,
    TokenService,
    UserProvisioningService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
  exports: [AuthService, TokenService, PasswordHasherService],
})
export class AuthModule {}
