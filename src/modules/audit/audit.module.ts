import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * The audit trail.
 *
 * Global because SOW BE-06 requires an entry for *every* entity mutation, which
 * means every domain module writes to it. Making each of them import a module
 * to say "this happened" is the friction that leads to the call being skipped,
 * and a trail with holes is worse than no trail — it looks complete.
 *
 * PrismaService comes from the global DatabaseModule.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
