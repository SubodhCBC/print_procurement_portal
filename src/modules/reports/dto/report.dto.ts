import { z } from 'zod';

/**
 * The window and scope every report shares.
 *
 * `from` and `to` are optional: omitted, the service uses the last thirty days,
 * which is what an executive opening a dashboard actually wants rather than a
 * partial calendar month.
 */
export const ReportRangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  /** Exclusive, so no order can be counted in two windows. */
  to: z.coerce.date().optional(),
  /** Narrow to one branch. */
  siteId: z.string().trim().max(64).optional(),
  /** Administrators only; everyone else reports on their own account. */
  accountId: z.string().trim().max(64).optional(),
  /**
   * Chart resolution. Omitted, the service picks one from the range's length —
   * 400 daily points on a dashboard card is a smear rather than a trend.
   */
  granularity: z.enum(['day', 'week', 'month']).optional(),
});

export type ReportRangeQueryDto = z.infer<typeof ReportRangeQuerySchema>;

export const TopProductsQuerySchema = ReportRangeQuerySchema.extend({
  /** Rank by money or by units. Both are asked for, and they differ. */
  by: z.enum(['spend', 'quantity']).default('spend'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type TopProductsQueryDto = z.infer<typeof TopProductsQuerySchema>;

export const InventoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type InventoryQueryDto = z.infer<typeof InventoryQuerySchema>;

/**
 * The dashboard bundle's query.
 *
 * `scope` decides *whose* numbers these are, and is the reason this endpoint
 * needs a schema of its own. Every other report pins a non-administrator to
 * their own account and leaves an administrator on theirs — which for a
 * platform operator is one customer's numbers, not the platform's. Asking for
 * `platform` is therefore explicit rather than implied by the caller's role,
 * so an administrator drilling into one customer and an administrator looking
 * at the whole estate are two different requests rather than one ambiguous one.
 */
export const DashboardQuerySchema = ReportRangeQuerySchema.extend({
  scope: z.enum(['account', 'platform']).default('account'),
  /** How many branches the "biggest spenders" strip carries. Zero omits it. */
  topSites: z.coerce.number().int().min(0).max(20).default(5),
});

export type DashboardQueryDto = z.infer<typeof DashboardQuerySchema>;
