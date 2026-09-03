import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BusinessRuleError,
  ConflictError,
  createId,
  NotFoundError,
  offsetPage,
  Role,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
// The pure period helpers, not the cart barrel: that would pull in CartService
// and its whole dependency chain for two date functions.
import { billingPeriodRange } from '@/modules/cart/budget';
import type {
  GenerateInvoiceDto,
  IssueInvoiceDto,
  ListInvoicesQueryDto,
  MarkInvoicePaidDto,
  VoidInvoiceDto,
} from './dto/invoice.dto';

const FULL_INVOICE = Prisma.validator<Prisma.InvoiceInclude>()({
  account: { select: { id: true, accountCode: true, name: true, contactEmail: true } },
  lines: { orderBy: [{ siteCode: 'asc' }, { orderedAt: 'asc' }] },
});

export type FullInvoice = Prisma.InvoiceGetPayload<{ include: typeof FULL_INVOICE }>;

const INVOICE_SUMMARY = Prisma.validator<Prisma.InvoiceInclude>()({
  account: { select: { id: true, accountCode: true, name: true, contactEmail: true } },
  _count: { select: { lines: true } },
});

export type InvoiceSummary = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_SUMMARY }>;

/** The statuses whose orders are billable: the goods have left the building. */
const BILLABLE_ORDER_STATUSES = ['DISPATCHED', 'DELIVERED'] as const;

/** What FE-07's KPI cards show for one period. */
export interface PeriodSummary {
  readonly billingPeriod: string;
  readonly totalSpend: string;
  readonly invoicedTotal: string;
  readonly unbilledTotal: string;
  readonly sitesBilled: number;
  readonly invoicedOrders: number;
  readonly unbilledOrders: number;
  readonly invoices: {
    readonly draft: number;
    readonly issued: number;
    readonly paid: number;
    readonly void: number;
  };
  readonly settled: boolean;
}

/**
 * Consolidated monthly billing (SOW BE-09).
 *
 * ---------------------------------------------------------------------------
 * Draft, then frozen
 * ---------------------------------------------------------------------------
 * A draft recomputes from the orders on every generation and holds no number.
 * Issuing allocates the number and freezes the lines. After that nothing
 * changes what a customer was billed — a mistake becomes a credit note, which
 * is what a finance team expects and what an auditor will ask for.
 *
 * ---------------------------------------------------------------------------
 * Everything on a line is copied
 * ---------------------------------------------------------------------------
 * The order number, the branch, the cost centre, the purchase order and the
 * amount are all snapshotted. An invoice states what was billed; an order that
 * is corrected next month must not silently restate a figure the customer has
 * already paid against.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- Generating -------------------------------------------------------------

  /**
   * Builds or rebuilds the draft invoice for one account and period.
   *
   * Rebuilding replaces the lines wholesale rather than merging: an order
   * cancelled since the last run has to disappear from the draft, and a merge
   * that only added would keep billing it.
   */
  async generate(actor: AuthenticatedActor, dto: GenerateInvoiceDto): Promise<FullInvoice> {
    const accountId = this.resolveAccount(actor, dto.accountId);
    const { start, end } = billingPeriodRange(dto.billingPeriod);

    const orders = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.order.findMany({
        where: {
          accountId,
          billingPeriod: dto.billingPeriod,
          status: { in: [...BILLABLE_ORDER_STATUSES] },
          // Belt and braces: `billingPeriod` is the authority, but an order
          // whose stamped period disagreed with its own creation date would be
          // a data problem worth not compounding.
          createdAt: { gte: start, lt: end },
        },
        include: {
          site: { select: { id: true, code: true, name: true, costCentre: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    // An order already frozen onto an issued invoice must never be billed
    // twice, however many times this is run.
    const alreadyBilled = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.invoiceLine.findMany({
        where: {
          orderId: { in: orders.map((order) => order.id) },
          invoice: { status: { in: ['ISSUED', 'PAID'] } },
        },
        select: { orderId: true },
      }),
    );
    const billed = new Set(alreadyBilled.map((line) => line.orderId));
    const billable = orders.filter((order) => !billed.has(order.id));

    const subtotal = billable.reduce(
      (total, order) => total.plus(order.total),
      new Prisma.Decimal(0),
    );
    const siteCount = new Set(billable.map((order) => order.siteId)).size;

    const invoice = await withTenantScope(this.prisma, accountId, async (tx) => {
      const existing = await tx.invoice.findFirst({
        where: { accountId, billingPeriod: dto.billingPeriod, status: 'DRAFT' },
        select: { id: true },
      });

      const invoiceId = existing?.id ?? createId('inv');

      if (existing) {
        await tx.invoiceLine.deleteMany({ where: { invoiceId } });
        await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            subtotal,
            tax: 0,
            total: subtotal,
            orderCount: billable.length,
            siteCount,
            notes: dto.notes ?? null,
          },
        });
      } else {
        await tx.invoice.create({
          data: {
            id: invoiceId,
            accountId,
            billingPeriod: dto.billingPeriod,
            status: 'DRAFT',
            subtotal,
            // Always zero — see the migration. The column exists so the PDF and
            // the exports have a place for it that will not need adding later.
            tax: 0,
            total: subtotal,
            orderCount: billable.length,
            siteCount,
            notes: dto.notes ?? null,
          },
        });
      }

      if (billable.length > 0) {
        await tx.invoiceLine.createMany({
          data: billable.map((order) => ({
            id: createId('ivl'),
            invoiceId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderedAt: order.createdAt,
            siteId: order.siteId,
            siteCode: order.site.code,
            siteName: order.site.name,
            costCentre: order.site.costCentre,
            poNumber: order.poNumber,
            campaignCode: order.campaignCode,
            itemCount: order._count.lines,
            amount: order.total,
          })),
        });
      }

      return tx.invoice.findFirstOrThrow({ where: { id: invoiceId }, include: FULL_INVOICE });
    });

    await this.audit.record({
      action: AuditAction.INVOICE_GENERATED,
      entityType: 'ACCOUNT',
      entityId: accountId,
      entityName: `${dto.billingPeriod} draft`,
      accountId,
      details: {
        billingPeriod: dto.billingPeriod,
        orderCount: billable.length,
        total: subtotal.toFixed(2),
        skippedAlreadyBilled: billed.size,
      },
    });

    this.logger.log(
      `Drafted ${dto.billingPeriod} for ${accountId}: ${billable.length} orders, ${subtotal.toFixed(2)}.`,
    );
    return invoice;
  }

  // --- Issuing ----------------------------------------------------------------

  /**
   * Numbers a draft and freezes it.
   *
   * The number comes from a counter table taken with `FOR UPDATE`, not from a
   * sequence: several jurisdictions require invoice numbers to be unbroken, and
   * a sequence does not roll back. The row lock that would be unacceptable on
   * checkout costs nothing here, because issuing is an operator's monthly batch
   * rather than a customer's request.
   */
  async issue(
    actor: AuthenticatedActor,
    invoiceId: string,
    dto: IssueInvoiceDto,
  ): Promise<FullInvoice> {
    const before = await this.requireInvoice(actor, invoiceId);

    if (before.status !== 'DRAFT') {
      throw new ConflictError('Only a draft invoice can be issued.', {
        details: { status: before.status, invoiceNumber: before.invoiceNumber },
      });
    }

    if (before.orderCount === 0) {
      // An invoice for nothing is not a zero-value invoice, it is a mistake —
      // and once numbered it cannot be withdrawn without a void.
      throw new BusinessRuleError(
        'This period has no billable orders, so there is nothing to issue.',
        {
          details: { billingPeriod: before.billingPeriod },
        },
      );
    }

    const issuedAt = new Date();
    const dueAt = new Date(issuedAt.getTime() + dto.paymentTermDays * 86_400_000);

    const invoice = await withTenantScope(this.prisma, before.accountId, async (tx) => {
      const invoiceNumber = await this.nextInvoiceNumber(tx, issuedAt);

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'ISSUED', invoiceNumber, issuedAt, dueAt },
      });

      return tx.invoice.findFirstOrThrow({ where: { id: invoiceId }, include: FULL_INVOICE });
    });

    await this.audit.record({
      action: AuditAction.INVOICE_ISSUED,
      entityType: 'ACCOUNT',
      entityId: before.accountId,
      entityName: invoice.invoiceNumber ?? invoiceId,
      accountId: before.accountId,
      details: {
        billingPeriod: invoice.billingPeriod,
        total: invoice.total.toFixed(2),
        orderCount: invoice.orderCount,
        dueAt: dueAt.toISOString(),
      },
    });

    this.logger.log(`Issued ${invoice.invoiceNumber} (${invoice.total.toFixed(2)}).`);
    return invoice;
  }

  async markPaid(
    actor: AuthenticatedActor,
    invoiceId: string,
    dto: MarkInvoicePaidDto,
  ): Promise<FullInvoice> {
    const before = await this.requireInvoice(actor, invoiceId);

    if (before.status !== 'ISSUED') {
      throw new ConflictError(
        before.status === 'PAID'
          ? 'This invoice is already settled.'
          : 'Only an issued invoice can be settled.',
        { details: { status: before.status } },
      );
    }

    const invoice = await withTenantScope(this.prisma, before.accountId, (tx) =>
      tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'PAID',
          paidAt: dto.paidAt ?? new Date(),
          paymentReference: dto.paymentReference ?? null,
        },
        include: FULL_INVOICE,
      }),
    );

    await this.audit.record({
      action: AuditAction.INVOICE_PAID,
      entityType: 'ACCOUNT',
      entityId: before.accountId,
      entityName: invoice.invoiceNumber ?? invoiceId,
      accountId: before.accountId,
      details: { total: invoice.total.toFixed(2), reference: dto.paymentReference ?? null },
    });

    return invoice;
  }

  /**
   * Cancels an issued invoice.
   *
   * The number is kept. An invoice number that simply disappears is exactly
   * what a tax audit asks about — "voided" is an answer, "missing" is not.
   *
   * Voiding frees the orders to be billed again, which is how a corrected
   * invoice is produced: void, regenerate, reissue.
   */
  async voidInvoice(
    actor: AuthenticatedActor,
    invoiceId: string,
    dto: VoidInvoiceDto,
  ): Promise<FullInvoice> {
    const before = await this.requireInvoice(actor, invoiceId);

    if (before.status === 'VOID') {
      throw new ConflictError('This invoice is already void.');
    }
    if (before.status === 'DRAFT') {
      throw new BusinessRuleError(
        'A draft has never been sent to anyone. Regenerate it instead of voiding it.',
      );
    }

    const invoice = await withTenantScope(this.prisma, before.accountId, (tx) =>
      tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'VOID', voidReason: dto.reason },
        include: FULL_INVOICE,
      }),
    );

    await this.audit.record({
      action: AuditAction.INVOICE_VOIDED,
      entityType: 'ACCOUNT',
      entityId: before.accountId,
      entityName: invoice.invoiceNumber ?? invoiceId,
      accountId: before.accountId,
      details: { reason: dto.reason, total: invoice.total.toFixed(2) },
    });

    this.logger.log(`Voided ${invoice.invoiceNumber}: ${dto.reason}`);
    return invoice;
  }

  // --- Reading ----------------------------------------------------------------

  async list(
    actor: AuthenticatedActor,
    query: ListInvoicesQueryDto,
  ): Promise<OffsetPage<InvoiceSummary>> {
    const accountId = actor.role === Role.ADMIN ? (query.accountId ?? null) : actor.accountId;

    const clauses: Prisma.InvoiceWhereInput[] = [];
    if (accountId) clauses.push({ accountId });
    if (query.status) clauses.push({ status: query.status });
    if (query.billingPeriod) clauses.push({ billingPeriod: query.billingPeriod });
    if (query.search) {
      clauses.push({ invoiceNumber: { contains: query.search, mode: 'insensitive' } });
    }
    if (query.overdue) {
      // Issued, past its due date, and not yet settled.
      clauses.push({ status: 'ISSUED', dueAt: { lt: new Date() } });
    }

    const where: Prisma.InvoiceWhereInput = clauses.length > 0 ? { AND: clauses } : {};
    const { skip, take } = toSkipTake(query);

    const read = async (client: Prisma.TransactionClient | PrismaService) =>
      Promise.all([
        client.invoice.findMany({
          where,
          include: INVOICE_SUMMARY,
          orderBy: [{ billingPeriod: 'desc' }, { createdAt: 'desc' }],
          skip,
          take,
        }),
        client.invoice.count({ where }),
      ]);

    const [items, total] = accountId
      ? await withTenantScope(this.prisma, accountId, read)
      : await read(this.prisma);

    return offsetPage(items, total, query);
  }

  async findById(actor: AuthenticatedActor, invoiceId: string): Promise<FullInvoice> {
    const invoice = await this.requireInvoice(actor, invoiceId);

    const full = await withTenantScope(this.prisma, invoice.accountId, (tx) =>
      tx.invoice.findFirst({ where: { id: invoiceId }, include: FULL_INVOICE }),
    );

    if (!full) throw new NotFoundError('Invoice');
    return full;
  }

  /**
   * The KPI cards on the billing explorer (FE-07).
   *
   * `unbilled` is the number worth having: orders in the period that have
   * shipped but are not on an issued invoice. Without it, a month can look
   * fully settled while a dozen orders quietly sit outside every invoice.
   */
  async periodSummary(
    actor: AuthenticatedActor,
    billingPeriod: string,
    accountId?: string,
  ): Promise<PeriodSummary> {
    const scope = this.resolveAccount(actor, accountId);

    const [invoices, orders, billedLines] = await withTenantScope(this.prisma, scope, (tx) =>
      Promise.all([
        tx.invoice.findMany({
          where: { accountId: scope, billingPeriod },
          select: { status: true, total: true },
        }),
        tx.order.findMany({
          where: {
            accountId: scope,
            billingPeriod,
            status: { in: [...BILLABLE_ORDER_STATUSES] },
          },
          select: { id: true, total: true, siteId: true },
        }),
        tx.invoiceLine.findMany({
          where: {
            invoice: { accountId: scope, billingPeriod, status: { in: ['ISSUED', 'PAID'] } },
          },
          select: { orderId: true, siteId: true },
        }),
      ]),
    );

    const billedOrderIds = new Set(billedLines.map((line) => line.orderId));
    const unbilled = orders.filter((order) => !billedOrderIds.has(order.id));

    const sum = (rows: { total: Prisma.Decimal }[]) =>
      rows.reduce((total, row) => total.plus(row.total), new Prisma.Decimal(0));

    const live = invoices.filter(
      (invoice) => invoice.status !== 'VOID' && invoice.status !== 'DRAFT',
    );

    return {
      billingPeriod,
      totalSpend: sum(orders).toFixed(2),
      invoicedTotal: sum(live).toFixed(2),
      unbilledTotal: sum(unbilled).toFixed(2),
      sitesBilled: new Set(billedLines.map((line) => line.siteId)).size,
      invoicedOrders: billedOrderIds.size,
      unbilledOrders: unbilled.length,
      invoices: {
        draft: invoices.filter((invoice) => invoice.status === 'DRAFT').length,
        issued: invoices.filter((invoice) => invoice.status === 'ISSUED').length,
        paid: invoices.filter((invoice) => invoice.status === 'PAID').length,
        void: invoices.filter((invoice) => invoice.status === 'VOID').length,
      },
      // Settled means every shipped order is on a paid invoice — not merely
      // that some invoice exists.
      settled:
        orders.length > 0 &&
        unbilled.length === 0 &&
        invoices.filter((invoice) => invoice.status === 'ISSUED').length === 0,
    };
  }

  // --- Internals --------------------------------------------------------------

  /**
   * The next gapless invoice number, taken under a row lock.
   *
   * `FOR UPDATE` serialises two operators issuing at the same instant, and the
   * increment rolls back with the transaction — so a failed issue hands the
   * number back rather than burning it.
   */
  private async nextInvoiceNumber(tx: Prisma.TransactionClient, at: Date): Promise<string> {
    const year = at.getUTCFullYear();

    const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
      INSERT INTO "invoice_sequences" ("year", "lastNumber", "updatedAt")
      VALUES (${year}, 1, now())
      ON CONFLICT ("year")
      DO UPDATE SET "lastNumber" = "invoice_sequences"."lastNumber" + 1, "updatedAt" = now()
      RETURNING "lastNumber"`;

    const next = rows[0]?.lastNumber;
    if (next === undefined) throw new Error('Could not allocate an invoice number.');

    return `INV-${year}-${String(next).padStart(6, '0')}`;
  }

  private resolveAccount(actor: AuthenticatedActor, requested?: string): string {
    if (actor.role === Role.ADMIN && requested) return requested;
    return actor.accountId;
  }

  /**
   * Reads the invoice outside any scope, only to learn which account owns it.
   *
   * A customer asking for another account's invoice gets 404: confirming that
   * an invoice number belongs to somebody discloses that they are a customer.
   */
  private async requireInvoice(actor: AuthenticatedActor, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (actor.role !== Role.ADMIN && invoice.accountId !== actor.accountId) {
      throw new NotFoundError('Invoice');
    }
    return invoice;
  }
}
