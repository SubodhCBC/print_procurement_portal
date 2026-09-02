import { Module } from '@nestjs/common';
import { AuthorizationController } from './authorization.controller';
import { AuthorizationGuard } from './authorization.guard';
import { PermissionService } from './permission.service';

/**
 * Authorization: the role and permission half of access control.
 *
 * Deliberately provides no APP_GUARD of its own. AuthorizationGuard has to run
 * *after* JwtAuthGuard — it reads the actor that guard attaches — and Nest
 * orders global guards by the order their providers are registered, which is
 * only deterministic within a single module. AuthModule therefore imports this
 * module and registers both guards, in order, in one place.
 *
 * PrismaService comes from the global DatabaseModule.
 */
@Module({
  controllers: [AuthorizationController],
  providers: [PermissionService, AuthorizationGuard],
  exports: [PermissionService, AuthorizationGuard],
})
export class AuthorizationModule {}
