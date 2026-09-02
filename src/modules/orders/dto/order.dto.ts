import { z } from 'zod';

const OrderStatusEnum = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PROCESSING',
  'DISPATCHED',
  'DELIVERED',
  'REJECTED',
  'CANCELLED',
]);

/**
 * Placing an order takes almost nothing: the basket already holds the purchase
 * order, the address, the payment method and the accepted terms, all validated
 * by `POST /cart/checkout-session`.
 *
 * The recipient is the exception. It belongs to this delivery rather than to the
 * branch — a campaign drop goes to a venue contact, not to the store manager —
 * so it is captured here rather than stored on the site.
 */
export const PlaceOrderSchema = z.object({
  /** Which branch's basket to submit. A site user's own is the default. */
  siteId: z.string().trim().max(64).optional(),
  recipientName: z.string().trim().max(200).nullish(),
  recipientPhone: z.string().trim().max(40).nullish(),
  recipientEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
  /**
   * A second attribution axis alongside the cart's campaign code. Finance uses
   * one for marketing spend and the other for capital projects, and collapsing
   * them would make the ERP export ambiguous.
   */
  projectCode: z.string().trim().max(64).nullish(),
});

export type PlaceOrderDto = z.infer<typeof PlaceOrderSchema>;

/**
 * A status change, with the note the target status demands.
 *
 * `reason` is required for REJECTED — SOW BE-07 is explicit, and the database
 * enforces it too, so no path can produce a rejected order that does not say
 * why. CHANGES_REQUESTED is not forced to carry one, but a change request with
 * no note is useless to the buyer, so it is strongly encouraged in the docs and
 * checked in the service.
 */
export const ChangeOrderStatusSchema = z
  .object({
    status: OrderStatusEnum,
    reason: z.string().trim().max(2000).optional(),
    /** Carrier details, when moving to DISPATCHED. */
    carrier: z.string().trim().max(120).optional(),
    trackingNumber: z.string().trim().max(120).optional(),
  })
  .refine(
    (value) => value.status !== 'REJECTED' || (value.reason?.length ?? 0) > 0,
    'A rejection must say why',
  )
  .refine(
    (value) => value.status !== 'CHANGES_REQUESTED' || (value.reason?.length ?? 0) > 0,
    'Say what needs to change',
  );

export type ChangeOrderStatusDto = z.infer<typeof ChangeOrderStatusSchema>;

/**
 * Payment is its own axis — an order can be delivered and unpaid on Net 30
 * terms — so it moves through its own endpoint rather than through the
 * lifecycle one.
 */
export const RecordPaymentSchema = z.object({
  paymentStatus: z.enum(['UNPAID', 'PAYMENT_PENDING', 'PAID', 'REFUNDED']),
  /** The customer's or the gateway's reference, for reconciliation. */
  paymentReference: z.string().trim().max(120).nullish(),
});

export type RecordPaymentDto = z.infer<typeof RecordPaymentSchema>;

export const ListOrdersQuerySchema = z.object({
  status: OrderStatusEnum.optional(),
  siteId: z.string().trim().max(64).optional(),
  /** Administrators only; everyone else is pinned to their own account. */
  accountId: z.string().trim().max(64).optional(),
  /** `YYYY-MM`. The same key BE-09 invoices by. */
  billingPeriod: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a period such as "2026-03"')
    .optional(),
  /** Case-insensitive match against the order number or purchase order. */
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Only orders waiting on an approver — the BE-07 queue. */
  awaitingApproval: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListOrdersQueryDto = z.infer<typeof ListOrdersQuerySchema>;
