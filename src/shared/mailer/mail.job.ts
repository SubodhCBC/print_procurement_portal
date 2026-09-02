import { z } from 'zod';

/**
 * The job names on the `email` queue.
 *
 * A name per message rather than one generic "send" job carrying pre-rendered
 * HTML. Two reasons: the payload stays small enough to sit in Redis without
 * carrying a whole email body, and a single-use invitation token is never
 * persisted in a queue that keeps completed jobs for a day.
 */
export const MailJob = {
  INVITATION: 'invitation',
  PASSWORD_RESET: 'password-reset',
  WELCOME: 'welcome',

  // --- Order notifications (SOW BE-08) --------------------------------------
  ORDER_PLACED: 'order-placed',
  APPROVAL_PENDING: 'approval-pending',
  APPROVAL_DECIDED: 'approval-decided',
  ORDER_DISPATCHED: 'order-dispatched',
  LOW_STOCK: 'low-stock',
} as const;

export type MailJob = (typeof MailJob)[keyof typeof MailJob];

/**
 * Payloads are validated on the way *out* of the queue as well as in.
 *
 * A job that has been sitting in Redis since before the last deploy can carry a
 * shape this build no longer understands. Parsing it in the processor turns
 * that into a clean, non-retryable failure instead of a TypeError halfway
 * through composing a message.
 */
const BaseRecipient = z.object({
  to: z.string().email(),
  firstName: z.string().min(1),
});

export const InvitationJobSchema = BaseRecipient.extend({
  accountName: z.string().min(1),
  inviterName: z.string().optional(),
  /** The single-use token. Never logged, and the queue entry is short-lived. */
  token: z.string().min(1),
  expiresAt: z.coerce.date(),
  isExternal: z.boolean(),
});

export type InvitationJobData = z.infer<typeof InvitationJobSchema>;

export const PasswordResetJobSchema = BaseRecipient.extend({
  token: z.string().min(1),
  expiresAt: z.coerce.date(),
});

export type PasswordResetJobData = z.infer<typeof PasswordResetJobSchema>;

export const WelcomeJobSchema = BaseRecipient.extend({
  accountName: z.string().min(1),
});

export type WelcomeJobData = z.infer<typeof WelcomeJobSchema>;

/**
 * The shape every order notification shares.
 *
 * The order is described by value, not by id: the processor must not have to
 * read the database to compose a message, because a job that runs after the
 * order has been amended would then describe the new one while claiming to
 * announce the old. What was true when the event happened is what gets sent.
 */
const OrderSummary = z.object({
  orderId: z.string().min(1),
  orderNumber: z.string().min(1),
  /** Formatted, not a number — the sender already knows the currency rules. */
  total: z.string().min(1),
  siteName: z.string().min(1),
  placedByName: z.string().min(1),
  poNumber: z.string().nullish(),
  lineCount: z.number().int().min(0),
});

export const OrderPlacedJobSchema = BaseRecipient.extend({
  order: OrderSummary,
  /** True when the order still needs a decision before anything happens. */
  awaitingApproval: z.boolean(),
});

export type OrderPlacedJobData = z.infer<typeof OrderPlacedJobSchema>;

export const ApprovalPendingJobSchema = BaseRecipient.extend({
  order: OrderSummary,
  /** Which round this approver is being asked for. */
  tier: z.number().int().min(1),
});

export type ApprovalPendingJobData = z.infer<typeof ApprovalPendingJobSchema>;

export const ApprovalDecidedJobSchema = BaseRecipient.extend({
  order: OrderSummary,
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  decidedByName: z.string().min(1),
  /** Mandatory for a refusal — the buyer cannot act on "no" alone. */
  comment: z.string().nullish(),
});

export type ApprovalDecidedJobData = z.infer<typeof ApprovalDecidedJobSchema>;

export const OrderDispatchedJobSchema = BaseRecipient.extend({
  order: OrderSummary,
  carrier: z.string().nullish(),
  trackingNumber: z.string().nullish(),
});

export type OrderDispatchedJobData = z.infer<typeof OrderDispatchedJobSchema>;

export const LowStockJobSchema = BaseRecipient.extend({
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        name: z.string().min(1),
        stockOnHand: z.number().int(),
        threshold: z.number().int(),
      }),
    )
    .min(1)
    // Bounded: a digest naming two hundred SKUs is not read, and the payload
    // has to stay small enough to sit in Redis.
    .max(100),
});

export type LowStockJobData = z.infer<typeof LowStockJobSchema>;
