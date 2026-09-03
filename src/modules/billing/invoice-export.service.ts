import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { FullInvoice } from './billing.service';

/** One branch's share of an invoice. */
interface SiteTotal {
  readonly siteCode: string;
  readonly siteName: string;
  orders: number;
  amount: Prisma.Decimal;
}

/**
 * The three shapes an invoice leaves the system in (SOW BE-09).
 *
 * All three are rendered from the invoice's own frozen rows, so they are
 * reproducible: the same invoice generates a byte-identical CSV today and next
 * year. That is why none of them is stored — a stored PDF would be a second
 * copy of the truth, and the two would eventually disagree.
 *
 * Generated on demand rather than on the render queue. A month's invoice is
 * tens of lines, not a print-resolution artwork, and making finance poll a job
 * to download a CSV would be a worse experience for no gain.
 */
@Injectable()
export class InvoiceExportService {
  /**
   * CSV for an accounting import.
   *
   * One row per order, because that is the level a finance team reconciles at
   * when a customer queries a total. The site breakdown they see on screen is a
   * grouping of these rows, and a pre-grouped file would take that choice away.
   */
  toCsv(invoice: FullInvoice): string {
    const header = [
      'Invoice',
      'Billing period',
      'Order',
      'Ordered at',
      'Site code',
      'Site',
      'Cost centre',
      'Purchase order',
      'Campaign',
      'Items',
      'Amount',
    ];

    const rows = invoice.lines.map((line) => [
      invoice.invoiceNumber ?? 'DRAFT',
      invoice.billingPeriod,
      line.orderNumber,
      line.orderedAt.toISOString().slice(0, 10),
      line.siteCode,
      line.siteName,
      line.costCentre ?? '',
      line.poNumber ?? '',
      line.campaignCode ?? '',
      String(line.itemCount),
      line.amount.toFixed(2),
    ]);

    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  /**
   * XLSX, with the site breakdown on a second sheet.
   *
   * Two sheets rather than one because they answer different questions: the
   * detail sheet is for reconciliation, the summary is what gets pasted into a
   * board pack. Deriving the second from the first in Excel is work nobody
   * should have to repeat every month.
   */
  async toXlsx(invoice: FullInvoice): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Ticket-IT Portal';
    workbook.created = invoice.issuedAt ?? invoice.createdAt;

    const detail = workbook.addWorksheet('Orders');
    detail.columns = [
      { header: 'Order', key: 'order', width: 20 },
      { header: 'Ordered', key: 'orderedAt', width: 12 },
      { header: 'Site code', key: 'siteCode', width: 12 },
      { header: 'Site', key: 'siteName', width: 28 },
      { header: 'Cost centre', key: 'costCentre', width: 14 },
      { header: 'Purchase order', key: 'poNumber', width: 20 },
      { header: 'Campaign', key: 'campaignCode', width: 16 },
      { header: 'Items', key: 'itemCount', width: 8 },
      { header: 'Amount', key: 'amount', width: 14 },
    ];
    detail.getRow(1).font = { bold: true };

    for (const line of invoice.lines) {
      detail.addRow({
        order: line.orderNumber,
        orderedAt: line.orderedAt.toISOString().slice(0, 10),
        siteCode: line.siteCode,
        siteName: line.siteName,
        costCentre: line.costCentre ?? '',
        poNumber: line.poNumber ?? '',
        campaignCode: line.campaignCode ?? '',
        itemCount: line.itemCount,
        // A real number, not a string: this column is summed and filtered in
        // Excel, and a text cell silently breaks both.
        amount: Number(line.amount.toFixed(2)),
      });
    }
    detail.getColumn('amount').numFmt = '#,##0.00';

    const summary = workbook.addWorksheet('By site');
    summary.columns = [
      { header: 'Site code', key: 'siteCode', width: 12 },
      { header: 'Site', key: 'siteName', width: 28 },
      { header: 'Orders', key: 'orders', width: 10 },
      { header: 'Amount', key: 'amount', width: 14 },
    ];
    summary.getRow(1).font = { bold: true };

    for (const site of this.bySite(invoice)) {
      summary.addRow({
        siteCode: site.siteCode,
        siteName: site.siteName,
        orders: site.orders,
        amount: Number(site.amount.toFixed(2)),
      });
    }
    summary.getColumn('amount').numFmt = '#,##0.00';

    const total = summary.addRow({
      siteCode: '',
      siteName: 'Total',
      orders: invoice.orderCount,
      amount: Number(invoice.total.toFixed(2)),
    });
    total.font = { bold: true };

    // ExcelJS types this as its own Buffer-alike; the cast keeps the public
    // signature honest for Fastify, which wants a Node Buffer.
    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }

  /**
   * The PDF the customer receives.
   *
   * Laid out by hand rather than through a template engine: it is one document,
   * it is compiled with the application, and a runtime template would turn a
   * typo into a production failure instead of a build error. The same reasoning
   * as the email bodies.
   */
  async toPdf(invoice: FullInvoice): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];

    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const money = (value: { toFixed(digits: number): string }) => value.toFixed(2);

    // --- Letterhead -----------------------------------------------------------
    doc.fontSize(20).text('Ticket-IT', { continued: false });
    doc.fontSize(9).fillColor('#666666').text('Print procurement portal');
    doc.moveDown(1.5);

    doc
      .fillColor('#000000')
      .fontSize(16)
      .text(invoice.status === 'DRAFT' ? 'Draft invoice' : 'Invoice');
    doc.fontSize(10);
    // A draft is watermarked in words rather than graphics: it must be
    // impossible to mistake for the real thing if it is printed in black and
    // white, which is how these are usually filed.
    if (invoice.status === 'DRAFT') {
      doc
        .fillColor('#b00020')
        .text('NOT AN INVOICE — draft for review, not payable')
        .fillColor('#000000');
    }
    if (invoice.status === 'VOID') {
      doc
        .fillColor('#b00020')
        .text(`VOID — ${invoice.voidReason ?? 'cancelled'}`)
        .fillColor('#000000');
    }
    doc.moveDown(0.5);

    const facts: Array<[string, string]> = [
      ['Invoice number', invoice.invoiceNumber ?? '—'],
      ['Billing period', invoice.billingPeriod],
      ['Issued', invoice.issuedAt ? invoice.issuedAt.toISOString().slice(0, 10) : '—'],
      ['Due', invoice.dueAt ? invoice.dueAt.toISOString().slice(0, 10) : '—'],
      ['Account', `${invoice.account.name} (${invoice.account.accountCode})`],
    ];
    for (const [label, value] of facts) {
      doc.fillColor('#666666').text(`${label}: `, { continued: true });
      doc.fillColor('#000000').text(value);
    }

    // --- Site breakdown -------------------------------------------------------
    doc.moveDown(1).fontSize(12).text('By branch');
    doc.moveDown(0.3).fontSize(9);
    for (const site of this.bySite(invoice)) {
      doc.text(
        `${site.siteCode}  ${site.siteName}`.padEnd(46).slice(0, 46) +
          `${String(site.orders).padStart(6)}` +
          `${money(site.amount).padStart(14)}`,
      );
    }

    // --- Orders ---------------------------------------------------------------
    doc.moveDown(1).fontSize(12).text('Orders');
    doc.moveDown(0.3).fontSize(8);
    for (const line of invoice.lines) {
      doc.text(
        `${line.orderNumber.padEnd(18)}` +
          `${line.orderedAt.toISOString().slice(0, 10).padEnd(12)}` +
          `${line.siteCode.padEnd(10)}` +
          `${(line.poNumber ?? '').padEnd(18).slice(0, 18)}` +
          `${money(line.amount).padStart(12)}`,
      );
    }

    // --- Totals ---------------------------------------------------------------
    doc.moveDown(1).fontSize(10);
    doc.text(`Subtotal${money(invoice.subtotal).padStart(40)}`);
    // Printed even at zero, so the customer can see it was considered rather
    // than omitted — and so the layout does not shift when it stops being zero.
    doc.text(`Tax${money(invoice.tax).padStart(45)}`);
    doc.fontSize(12).text(`Total${money(invoice.total).padStart(38)}`);

    if (invoice.notes) {
      doc.moveDown(1).fontSize(9).fillColor('#666666').text(invoice.notes);
    }

    doc.end();
    return finished;
  }

  /** The per-branch grouping every export shows. */
  private bySite(invoice: FullInvoice): SiteTotal[] {
    const sites = new Map<string, SiteTotal>();

    for (const line of invoice.lines) {
      const existing = sites.get(line.siteId);
      if (existing) {
        existing.orders += 1;
        existing.amount = existing.amount.plus(line.amount);
      } else {
        sites.set(line.siteId, {
          siteCode: line.siteCode,
          siteName: line.siteName,
          orders: 1,
          // Copied rather than referenced: Decimal is immutable, but `plus`
          // returning a new instance is the only reason this is safe, and
          // relying on that silently would break the day it is not.
          amount: new Prisma.Decimal(line.amount),
        });
      }
    }

    return [...sites.values()].sort((a, b) => a.siteCode.localeCompare(b.siteCode));
  }
}

/**
 * Quotes a CSV cell.
 *
 * The leading apostrophe on anything starting with `=`, `+`, `-` or `@` is
 * deliberate: those are formula prefixes, and a purchase-order reference of
 * `=cmd|...` is a real spreadsheet injection that Excel will execute on open.
 * An invoice export is opened by a finance team on a machine with access to the
 * ledger, which is the worst possible place for it.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
