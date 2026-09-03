import { Module } from '@nestjs/common';
import { ApprovalsModule } from '@/modules/approvals';
import { CatalogModule } from '@/modules/catalog';
import { AuthorizationModule } from '@/modules/authorization';
import { CartModule } from '@/modules/cart';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Orders (SOW BE-06).
 *
 * Imports CartModule and is never imported by it. The cart's budget check does
 * need committed spend from this table, but it reads the rows directly through
 * Prisma and imports only `order-status.ts` — a file with no dependencies of its
 * own. That keeps the module graph acyclic while still letting both sides agree
 * on which statuses count as committed, which is the part that must not drift.
 *
 * AuthorizationModule supplies PermissionService: which orders a user may see —
 * their own, their branches', or the account's — is a permission question that
 * RLS cannot answer, because the tenant scope carries an account and not a user.
 *
 * Exported for BE-07, whose approval engine acts on these rows, and BE-09,
 * which aggregates them by `billingPeriod`.
 */
@Module({
  imports: [ApprovalsModule, AuthorizationModule, CartModule, CatalogModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
