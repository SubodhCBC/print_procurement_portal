import { Prisma } from '@prisma/client';
import type { FullInvoice, InvoiceSummary } from '../billing.service';

/**
 * An invoice as the API exposes it.
 *
 * Money is a string throughout, as everywhere else: these are NUMERIC columns
 * and a JSON number would be rounded by the client's parser.
 */
export interface InvoiceView {
  readonly id: string;
  /** Null while it is a draft — a draft holds no number, by design. */
  readonly invoiceNumber: string | null;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly billingPeriod: string;
  readonly status: InvoiceSummary['status'];
  readonly subtotal: string;
  /** Always zero for now; the column exists so the layout is already right. */
  readonly tax: string;
  readonly total: string;
  readonly orderCount: number;
  readonly siteCount: number;
  readonly issuedAt: string | null;
  readonly dueAt: string | null;
  readonly paidAt: string | null;
  readonly paymentReference: string | null;
  /** True when it is issued, past due and still unpaid. */
  readonly overdue: boolean;
  readonly voidReason: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Present only on the single-invoice read. */
  readonly lines?: readonly InvoiceLineView[];
  /** The per-branch grouping the billing table shows. Single read only. */
  readonly sites?: readonly InvoiceSiteView[];
}

export interface InvoiceLineView {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderedAt: string;
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly costCentre: string | null;
  readonly poNumber: string | null;
  readonly campaignCode: string | null;
  readonly itemCount: number;
  readonly amount: string;
}

export interface InvoiceSiteView {
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly orders: number;
  readonly amount: string;
}

export function toInvoiceView(invoice: FullInvoice | InvoiceSummary): InvoiceView {
  const detailed = 'lines' in invoice ? invoice : null;

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    accountId: invoice.accountId,
    accountCode: invoice.account.accountCode,
    accountName: invoice.account.name,
    billingPeriod: invoice.billingPeriod,
    status: invoice.status,
    subtotal: invoice.subtotal.toFixed(2),
    tax: invoice.tax.toFixed(2),
    total: invoice.total.toFixed(2),
    orderCount: invoice.orderCount,
    siteCount: invoice.siteCount,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    dueAt: invoice.dueAt?.toISOString() ?? null,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    paymentReference: invoice.paymentReference,
    // Computed rather than stored: a flag would need a nightly job to flip it,
    // and an invoice that only became overdue at 3am is not a thing.
    overdue: invoice.status === 'ISSUED' && invoice.dueAt !== null && invoice.dueAt < new Date(),
    voidReason: invoice.voidReason,
    notes: invoice.notes,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
    ...(detailed
      ? { lines: detailed.lines.map(toInvoiceLineView), sites: groupBySite(detailed) }
      : {}),
  };
}

function toInvoiceLineView(line: FullInvoice['lines'][number]): InvoiceLineView {
  return {
    id: line.id,
    orderId: line.orderId,
    orderNumber: line.orderNumber,
    orderedAt: line.orderedAt.toISOString(),
    siteId: line.siteId,
    siteCode: line.siteCode,
    siteName: line.siteName,
    costCentre: line.costCentre,
    poNumber: line.poNumber,
    campaignCode: line.campaignCode,
    itemCount: line.itemCount,
    amount: line.amount.toFixed(2),
  };
}

/**
 * The per-branch totals, derived rather than stored.
 *
 * The lines are already frozen, so this cannot drift from them — and storing it
 * would be a second copy of a number that is one reduce away.
 */
function groupBySite(invoice: FullInvoice): InvoiceSiteView[] {
  const sites = new Map<
    string,
    { siteId: string; siteCode: string; siteName: string; orders: number; amount: Prisma.Decimal }
  >();

  for (const line of invoice.lines) {
    const existing = sites.get(line.siteId);
    if (existing) {
      existing.orders += 1;
      existing.amount = existing.amount.plus(line.amount);
    } else {
      sites.set(line.siteId, {
        siteId: line.siteId,
        siteCode: line.siteCode,
        siteName: line.siteName,
        orders: 1,
        amount: new Prisma.Decimal(line.amount),
      });
    }
  }

  return [...sites.values()]
    .map((site) => ({
      siteId: site.siteId,
      siteCode: site.siteCode,
      siteName: site.siteName,
      orders: site.orders,
      amount: site.amount.toFixed(2),
    }))
    .sort((a, b) => a.siteCode.localeCompare(b.siteCode));
}
