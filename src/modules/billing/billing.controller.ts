import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Permission, RequirePermissions, type AuthenticatedActor, type OffsetPage } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { BillingService, type PeriodSummary } from './billing.service';
import { InvoiceExportService } from './invoice-export.service';
import {
  GenerateInvoiceSchema,
  IssueInvoiceSchema,
  ListInvoicesQuerySchema,
  MarkInvoicePaidSchema,
  VoidInvoiceSchema,
  type GenerateInvoiceDto,
  type IssueInvoiceDto,
  type ListInvoicesQueryDto,
  type MarkInvoicePaidDto,
  type VoidInvoiceDto,
} from './dto/invoice.dto';
import { toInvoiceView, type InvoiceView } from './dto/invoice-response';

/**
 * Consolidated monthly billing (SOW BE-09, FE-07).
 *
 * Reading is `BILLING_VIEW`, which head office holds — a customer can see their
 * own invoices. Everything that changes one is `BILLING_MANAGE`, which no
 * customer role has: generating, issuing, settling and voicing invoices is the
 * platform operator's.
 */
@ApiTags('billing')
@ApiBearerAuth('access-token')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly exports: InvoiceExportService,
  ) {}

  @Get('periods/:billingPeriod')
  @RequirePermissions(Permission.BILLING_VIEW)
  @ApiOperation({
    summary: 'The KPI figures for one month',
    description:
      'What the billing explorer shows above the table. `unbilledOrders` is the number worth ' +
      'watching: shipped orders in the period that are not on any issued invoice. Without it a ' +
      'month can look fully settled while a dozen orders quietly sit outside every invoice.',
  })
  async periodSummary(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('billingPeriod') billingPeriod: string,
    @Query('accountId') accountId?: string,
  ): Promise<PeriodSummary> {
    return this.billing.periodSummary(actor, billingPeriod, accountId);
  }

  @Get('invoices')
  @RequirePermissions(Permission.BILLING_VIEW)
  @ApiOperation({
    summary: 'Invoices, newest period first',
    description: '`overdue=true` narrows to issued invoices past their due date and still unpaid.',
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListInvoicesQuerySchema)) query: ListInvoicesQueryDto,
  ): Promise<OffsetPage<InvoiceView>> {
    const page = await this.billing.list(actor, query);
    return { ...page, items: page.items.map(toInvoiceView) };
  }

  @Get('invoices/:invoiceId')
  @RequirePermissions(Permission.BILLING_VIEW)
  @ApiOperation({
    summary: 'One invoice, with its lines and per-branch breakdown',
    description:
      'An invoice belonging to another account reads as missing rather than forbidden: ' +
      'confirming that an invoice number belongs to somebody discloses that they are a customer.',
  })
  async findOne(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invoiceId') invoiceId: string,
  ): Promise<InvoiceView> {
    return toInvoiceView(await this.billing.findById(actor, invoiceId));
  }

  @Post('invoices/generate')
  @RequirePermissions(Permission.BILLING_MANAGE)
  @ApiOperation({
    summary: 'Build or rebuild the draft for a period',
    description:
      'Collects every order whose own `billingPeriod` is this month and which has reached ' +
      'DISPATCHED or DELIVERED. The period comes from the order rather than from the shipment, ' +
      "so it agrees with the branch's budget for that month; only shipped goods are billed, " +
      'because invoicing something still in production is how a credit note gets created.\n\n' +
      'Safe to run repeatedly: it replaces the draft wholesale, so an order cancelled since the ' +
      'last run disappears from it. Orders already frozen onto an issued invoice are never ' +
      'picked up again.',
  })
  @ApiZodBody(GenerateInvoiceSchema, {
    example: { billingPeriod: '2026-09', notes: 'September consolidated billing' },
  })
  async generate(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(GenerateInvoiceSchema)) body: GenerateInvoiceDto,
  ): Promise<InvoiceView> {
    return toInvoiceView(await this.billing.generate(actor, body));
  }

  @Post('invoices/:invoiceId/issue')
  @RequirePermissions(Permission.BILLING_MANAGE)
  @ApiOperation({
    summary: 'Number the draft and freeze it',
    description:
      'The number is gapless within the year — taken from a counter under a row lock, not from ' +
      'a sequence, because several jurisdictions require invoice numbers to be unbroken and a ' +
      'sequence does not roll back.\n\n' +
      'After this nothing changes what the customer was billed. A mistake becomes a void and a ' +
      'reissue, which is what a finance team expects and what an auditor asks for.',
  })
  @ApiZodBody(IssueInvoiceSchema, { example: { paymentTermDays: 30 } })
  async issue(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invoiceId') invoiceId: string,
    @Body(zodBody(IssueInvoiceSchema)) body: IssueInvoiceDto,
  ): Promise<InvoiceView> {
    return toInvoiceView(await this.billing.issue(actor, invoiceId, body));
  }

  @Post('invoices/:invoiceId/paid')
  @RequirePermissions(Permission.BILLING_MANAGE)
  @ApiOperation({ summary: 'Record settlement' })
  @ApiZodBody(MarkInvoicePaidSchema, { example: { paymentReference: 'EFT-2026-00841' } })
  async markPaid(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invoiceId') invoiceId: string,
    @Body(zodBody(MarkInvoicePaidSchema)) body: MarkInvoicePaidDto,
  ): Promise<InvoiceView> {
    return toInvoiceView(await this.billing.markPaid(actor, invoiceId, body));
  }

  @Post('invoices/:invoiceId/void')
  @RequirePermissions(Permission.BILLING_MANAGE)
  @ApiOperation({
    summary: 'Cancel an issued invoice',
    description:
      'The number is kept. An invoice number that simply disappears is exactly what a tax ' +
      'audit asks about — "voided" is an answer, "missing" is not.\n\n' +
      'Voiding frees its orders to be billed again, which is how a corrected invoice is ' +
      'produced: void, regenerate, reissue.',
  })
  @ApiZodBody(VoidInvoiceSchema, { example: { reason: 'Wrong purchase order on three lines' } })
  async voidInvoice(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invoiceId') invoiceId: string,
    @Body(zodBody(VoidInvoiceSchema)) body: VoidInvoiceDto,
  ): Promise<InvoiceView> {
    return toInvoiceView(await this.billing.voidInvoice(actor, invoiceId, body));
  }

  // --- Exports ----------------------------------------------------------------
  //
  // All three render from the invoice's own frozen rows, so they are
  // reproducible and none is stored: a saved PDF would be a second copy of the
  // truth, and the two would eventually disagree.

  @Get('invoices/:invoiceId/pdf')
  @RequirePermissions(Permission.BILLING_VIEW)
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'The invoice as a PDF' })
  async pdf(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invoiceId') invoiceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const invoice = await this.billing.findById(actor, invoiceId);
    const body = await this.exports.toPdf(invoice);

    await reply
      .header('content-type', 'application/pdf')
      .header(
        'content-disposition',
        attachment(invoice.invoiceNumber, invoice.billingPeriod, 'pdf'),
      )
      .send(body);
  }

  @Get('invoices/:invoiceId/csv')
  @RequirePermissions(Permission.BILLING_VIEW)
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'The invoice as CSV',
    description:
      'One row per order, because that is the level a finance team reconciles at. Cells that ' +
      'begin with a formula character are prefixed with an apostrophe: an export like this is ' +
      'opened on a machine with access to the ledger, which is the worst place for a ' +
      'spreadsheet injection.',
  })
  async csv(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invoiceId') invoiceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const invoice = await this.billing.findById(actor, invoiceId);

    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        attachment(invoice.invoiceNumber, invoice.billingPeriod, 'csv'),
      )
      .send(this.exports.toCsv(invoice));
  }

  @Get('invoices/:invoiceId/xlsx')
  @RequirePermissions(Permission.BILLING_VIEW)
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOperation({
    summary: 'The invoice as a workbook',
    description: 'Two sheets: every order, and the per-branch summary that goes in a board pack.',
  })
  async xlsx(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invoiceId') invoiceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const invoice = await this.billing.findById(actor, invoiceId);
    const body = await this.exports.toXlsx(invoice);

    await reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'content-disposition',
        attachment(invoice.invoiceNumber, invoice.billingPeriod, 'xlsx'),
      )
      .send(body);
  }
}

/**
 * The download filename.
 *
 * Falls back to the period for a draft, which has no number yet — and never
 * interpolates anything a user typed, so the header cannot be split.
 */
function attachment(invoiceNumber: string | null, period: string, extension: string): string {
  const name = (invoiceNumber ?? `draft-${period}`).replace(/[^A-Za-z0-9._-]/g, '');
  return `attachment; filename="${name}.${extension}"`;
}
