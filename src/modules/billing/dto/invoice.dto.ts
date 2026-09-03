import { z } from 'zod';

/** `YYYY-MM`, the key orders carry and budgets are measured over. */
const BillingPeriod = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a period such as "2026-03"');

export const GenerateInvoiceSchema = z.object({
  billingPeriod: BillingPeriod,
  /** Administrators only; everyone else bills their own account. */
  accountId: z.string().trim().max(64).optional(),
  notes: z.string().trim().max(2000).nullish(),
});

export type GenerateInvoiceDto = z.infer<typeof GenerateInvoiceSchema>;

export const IssueInvoiceSchema = z.object({
  /**
   * Days from issue to the due date. Thirty by default because Net 30 is the
   * default payment method, and a due date is what makes the overdue filter
   * mean anything.
   */
  paymentTermDays: z.coerce.number().int().min(0).max(365).default(30),
});

export type IssueInvoiceDto = z.infer<typeof IssueInvoiceSchema>;

export const MarkInvoicePaidSchema = z.object({
  paymentReference: z.string().trim().max(120).nullish(),
  /**
   * When the money actually arrived, which is rarely when someone got round to
   * recording it. Defaults to now.
   */
  paidAt: z.coerce.date().optional(),
});

export type MarkInvoicePaidDto = z.infer<typeof MarkInvoicePaidSchema>;

export const VoidInvoiceSchema = z.object({
  /** Mandatory, and enforced by the database too: a void with no explanation
   *  is the thing an auditor stops on. */
  reason: z.string().trim().min(1, 'Say why this invoice is being voided').max(500),
});

export type VoidInvoiceDto = z.infer<typeof VoidInvoiceSchema>;

export const ListInvoicesQuerySchema = z.object({
  status: z.enum(['DRAFT', 'ISSUED', 'PAID', 'VOID']).optional(),
  billingPeriod: BillingPeriod.optional(),
  accountId: z.string().trim().max(64).optional(),
  /** Case-insensitive match against the invoice number. */
  search: z.string().trim().max(120).optional(),
  /** Issued, past due, and still unpaid. */
  overdue: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListInvoicesQueryDto = z.infer<typeof ListInvoicesQuerySchema>;
