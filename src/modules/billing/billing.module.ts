import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { InvoiceExportService } from './invoice-export.service';

/**
 * Consolidated monthly billing (SOW BE-09).
 *
 * Imports nothing from OrdersModule: it reads order rows directly and takes the
 * two period helpers from the pure `cart/budget.ts`, so the invoice and the
 * branch budget can never disagree about which month an order falls in.
 *
 * PrismaService and AuditService come from global modules.
 */
@Module({
  controllers: [BillingController],
  providers: [BillingService, InvoiceExportService],
  exports: [BillingService, InvoiceExportService],
})
export class BillingModule {}
