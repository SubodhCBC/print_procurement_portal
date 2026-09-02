import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

/**
 * Tenant administration. ADMIN-only in practice, because ACCOUNT_MANAGE is not
 * in any customer role's baseline.
 *
 * PrismaService and AuditService both come from global modules.
 */
@Module({
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
