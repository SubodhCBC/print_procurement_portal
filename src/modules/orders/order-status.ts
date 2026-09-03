import { BusinessRuleError } from '@/common';

/**
 * The order lifecycle, as an explicit state machine (SOW BE-06).
 *
 * Pure and free of Prisma, for the same reason `product-status.ts` is: this is
 * the rule that decides whether an order can move, it is read by BE-07's
 * approval engine and by INT-01/INT-02's inbound webhooks, and every one of
 * those callers must get the same answer.
 *
 * ---------------------------------------------------------------------------
 * Fulfilment only
 * ---------------------------------------------------------------------------
 * Payment is a separate axis — see `PaymentStatus` and the note on the Order
 * model. Nothing here consults it, because on Net 30 terms an order is
 * routinely delivered a month before it is paid, and coupling the two would
 * make that ordinary sequence unrepresentable.
 */

export const OrderStatus = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  APPROVED: 'APPROVED',
  PROCESSING: 'PROCESSING',
  DISPATCHED: 'DISPATCHED',
  DELIVERED: 'DELIVERED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/**
 * Where each status may go next.
 *
 * ```text
 *   DRAFT ──► PENDING_APPROVAL ──► APPROVED ──► PROCESSING ──► DISPATCHED ──► DELIVERED
 *     │            │    ▲             │             │              │
 *     │            │    └─ CHANGES_REQUESTED ◄──────┘              │
 *     │            ▼                                               ▼
 *     └──────► REJECTED                                     (terminal)
 *              CANCELLED ◄── from anything not yet dispatched
 * ```
 *
 * Three rules are worth stating, because each is a decision rather than an
 * obvious consequence:
 *
 * - **DELIVERED, REJECTED and CANCELLED are terminal.** An order that went
 *   wrong after delivery is a credit note or a replacement order, not a status
 *   change — reopening it would silently rewrite a month that has already been
 *   invoiced and reported on.
 * - **Nothing can be cancelled once it is dispatched.** The goods are with a
 *   carrier; cancelling would tell the customer their order is void while a
 *   parcel is on its way to them. That is a returns process, which is BE-12's.
 * - **CHANGES_REQUESTED goes back to PENDING_APPROVAL, not to DRAFT.** The
 *   order keeps its number and its history. Dropping it to DRAFT would suggest
 *   it had never been submitted, and the approver's note would lose its subject.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: [OrderStatus.PENDING_APPROVAL, OrderStatus.APPROVED, OrderStatus.CANCELLED],
  PENDING_APPROVAL: [
    OrderStatus.APPROVED,
    OrderStatus.CHANGES_REQUESTED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
  ],
  CHANGES_REQUESTED: [OrderStatus.PENDING_APPROVAL, OrderStatus.REJECTED, OrderStatus.CANCELLED],
  APPROVED: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  // Back to CHANGES_REQUESTED because production does find problems — a file
  // that will not rip, a stock shortfall — and the buyer has to answer for them.
  PROCESSING: [OrderStatus.DISPATCHED, OrderStatus.CHANGES_REQUESTED, OrderStatus.CANCELLED],
  DISPATCHED: [OrderStatus.DELIVERED],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
};

/** Statuses whose spend counts against a branch's monthly budget. */
export const COMMITTED_STATUSES: readonly OrderStatus[] = [
  // Pending approval counts. Otherwise a branch could queue up ten unapproved
  // orders, each individually within budget, and blow the cap the moment they
  // were approved together.
  OrderStatus.PENDING_APPROVAL,
  OrderStatus.CHANGES_REQUESTED,
  OrderStatus.APPROVED,
  OrderStatus.PROCESSING,
  OrderStatus.DISPATCHED,
  OrderStatus.DELIVERED,
];

/** Statuses a customer may still cancel from. */
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DRAFT,
  OrderStatus.PENDING_APPROVAL,
  OrderStatus.CHANGES_REQUESTED,
  OrderStatus.APPROVED,
  OrderStatus.PROCESSING,
];

/** Statuses that need an approver to act. The BE-07 queue reads this. */
export const AWAITING_APPROVAL_STATUSES: readonly OrderStatus[] = [OrderStatus.PENDING_APPROVAL];

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.REJECTED,
  OrderStatus.CANCELLED,
];

/**
 * Statuses an order is in once it has been submitted and before it is finished.
 *
 * Derived from the machine rather than hand-listed, so a status added to the
 * lifecycle later is counted as open until someone deliberately makes it
 * terminal. DRAFT is excluded: a basket that was never submitted is not work
 * anybody is waiting on.
 *
 * This is the "how many orders are in flight right now" figure a dashboard
 * shows, and it is deliberately not windowed by date — an order placed six
 * weeks ago and still in production is still in flight.
 */
export const OPEN_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus).filter(
  (status) => status !== OrderStatus.DRAFT && !TERMINAL_STATUSES.includes(status),
);

/**
 * The working set of the fulfilment board: approved, not yet with the customer.
 *
 * DELIVERED is the board's last column but is not in here. It is where work
 * *ends*, and counting it would make a queue that is being cleared look busier
 * the better it is being served.
 */
export const IN_FULFILMENT_STATUSES: readonly OrderStatus[] = [
  OrderStatus.APPROVED,
  OrderStatus.PROCESSING,
  OrderStatus.DISPATCHED,
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** True when this status's spend counts against the branch's budget. */
export function isCommitted(status: OrderStatus): boolean {
  return COMMITTED_STATUSES.includes(status);
}

/**
 * Throws unless the move is allowed, naming what *is* allowed.
 *
 * The message matters: this reaches an administrator on a fulfilment screen and
 * an integration partner in an HTTP response, and "invalid transition" tells
 * neither of them what to do instead.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) {
    throw new BusinessRuleError(`This order is already ${to}.`, { details: { status: to } });
  }

  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from];
    throw new BusinessRuleError(
      allowed.length === 0
        ? `A ${from} order is final and cannot be changed.`
        : `A ${from} order cannot become ${to}. Allowed from here: ${allowed.join(', ')}.`,
      { details: { from, to, allowed } },
    );
  }
}

/**
 * Whether an order needs approval before it can be fulfilled.
 *
 * Null means the account approves everything automatically; **zero means every
 * order needs approval**, which is a real configuration and the reason
 * `Account.approvalThreshold` is nullable rather than using 0 as a sentinel.
 *
 * Strictly greater than: an order landing exactly on the threshold is within
 * it. A head office that sets £1,000 means "up to a thousand is fine".
 *
 * BE-07 adds the rest of the triggers the SOW lists — category and role — and
 * the multi-tier routing. This is the total-based one, which is what an order
 * needs to know at placement.
 */
export function requiresApproval(totalCents: number, thresholdCents: number | null): boolean {
  if (thresholdCents === null) return false;
  return totalCents > thresholdCents;
}
