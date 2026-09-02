import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth';
import { AuthorizationModule } from '@/modules/authorization';
import { InvitationService } from './invitation.service';
import { InvitationsController } from './invitations.controller';
import { PasswordController } from './password.controller';
import { PasswordResetService } from './password-reset.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Users who are not replicated from legacy, and the administration of every
 * user once they exist.
 *
 * Imports AuthModule for PasswordHasherService and TokenService — accepting an
 * invitation ends with an issued token pair, and every access-affecting change
 * revokes the user's sessions. Prisma and MailDispatcher arrive from the global
 * DatabaseModule and MailerModule.
 */
@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [InvitationsController, PasswordController, UsersController],
  providers: [InvitationService, PasswordResetService, UsersService],
  exports: [InvitationService, UsersService],
})
export class UsersModule {}
