import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/**
 * The hierarchical approval workflow (SOW BE-07).
 *
 * Imports nothing from OrdersModule, deliberately. It writes order rows
 * directly — a decision and the order status it produces must commit in one
 * transaction — and takes the transition vocabulary from `order-status.ts`,
 * which is pure. OrdersModule imports this one to raise a request at placement,
 * and the dependency runs that way only.
 *
 * PrismaService and AuditService both come from global modules.
 */
@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
