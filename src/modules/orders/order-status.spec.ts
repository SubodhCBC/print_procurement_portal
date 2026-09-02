import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  CANCELLABLE_STATUSES,
  COMMITTED_STATUSES,
  isCommitted,
  isTerminal,
  OrderStatus,
  requiresApproval,
  TERMINAL_STATUSES,
} from './order-status';

/**
 * The order lifecycle is the rule BE-07's approval engine and INT-01/INT-02's
 * inbound webhooks all consult. A wrong answer here either strands an order
 * mid-fulfilment or reopens one that has already been invoiced.
 */

describe('canTransition — the happy path', () => {
  it('runs from submission to delivery', () => {
    const path = [
      OrderStatus.DRAFT,
      OrderStatus.PENDING_APPROVAL,
      OrderStatus.APPROVED,
      OrderStatus.PROCESSING,
      OrderStatus.DISPATCHED,
      OrderStatus.DELIVERED,
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it('lets an order that needs no approval skip straight to approved', () => {
    expect(canTransition(OrderStatus.DRAFT, OrderStatus.APPROVED)).toBe(true);
  });

  it('cannot skip production and go straight to dispatched', () => {
    expect(canTransition(OrderStatus.APPROVED, OrderStatus.DISPATCHED)).toBe(false);
  });

  it('never moves backwards through fulfilment', () => {
    expect(canTransition(OrderStatus.DISPATCHED, OrderStatus.PROCESSING)).toBe(false);
    expect(canTransition(OrderStatus.PROCESSING, OrderStatus.APPROVED)).toBe(false);
  });
});

describe('canTransition — approval', () => {
  it('an approver can approve, reject or ask for changes', () => {
    expect(allowedTransitions(OrderStatus.PENDING_APPROVAL)).toEqual([
      OrderStatus.APPROVED,
      OrderStatus.CHANGES_REQUESTED,
      OrderStatus.REJECTED,
      OrderStatus.CANCELLED,
    ]);
  });

  it('changes requested goes back to pending approval, not to draft', () => {
    // The order keeps its number and its history. Dropping it to DRAFT would
    // suggest it had never been submitted and would orphan the approver's note.
    expect(canTransition(OrderStatus.CHANGES_REQUESTED, OrderStatus.PENDING_APPROVAL)).toBe(true);
    expect(canTransition(OrderStatus.CHANGES_REQUESTED, OrderStatus.DRAFT)).toBe(false);
  });

  it('production can send an order back for changes', () => {
    // Production does find problems — a file that will not rip, a shortfall —
    // and the buyer has to answer for them.
    expect(canTransition(OrderStatus.PROCESSING, OrderStatus.CHANGES_REQUESTED)).toBe(true);
  });
});

describe('canTransition — cancellation', () => {
  it('can be cancelled at any point before dispatch', () => {
    for (const status of CANCELLABLE_STATUSES) {
      expect(canTransition(status, OrderStatus.CANCELLED)).toBe(true);
    }
  });

  it('cannot be cancelled once it is with a carrier', () => {
    // Cancelling would tell the customer their order is void while a parcel is
    // on its way to them. That is a returns process, not a status change.
    expect(canTransition(OrderStatus.DISPATCHED, OrderStatus.CANCELLED)).toBe(false);
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toBe(false);
  });
});

describe('isTerminal', () => {
  it('delivered, rejected and cancelled are final', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
      expect(allowedTransitions(status)).toEqual([]);
    }
  });

  it('a delivered order is not reopened', () => {
    // A problem after delivery is a credit note or a replacement order.
    // Reopening would rewrite a month already invoiced and reported on.
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.PROCESSING)).toBe(false);
  });

  it('nothing in flight is terminal', () => {
    expect(isTerminal(OrderStatus.PROCESSING)).toBe(false);
    expect(isTerminal(OrderStatus.PENDING_APPROVAL)).toBe(false);
  });
});

describe('assertTransition', () => {
  it('says so when the order is already there', () => {
    expect(() => assertTransition(OrderStatus.APPROVED, OrderStatus.APPROVED)).toThrow(
      /already APPROVED/,
    );
  });

  it('names what is allowed instead', () => {
    // This message reaches an administrator on a fulfilment screen and an
    // integration partner in an HTTP response. "Invalid transition" helps
    // neither of them.
    expect(() => assertTransition(OrderStatus.APPROVED, OrderStatus.DELIVERED)).toThrow(
      /Allowed from here: PROCESSING, CANCELLED/,
    );
  });

  it('says a terminal order is final rather than listing nothing', () => {
    expect(() => assertTransition(OrderStatus.DELIVERED, OrderStatus.PROCESSING)).toThrow(
      /final and cannot be changed/,
    );
  });

  it('permits an allowed move silently', () => {
    expect(() => assertTransition(OrderStatus.APPROVED, OrderStatus.PROCESSING)).not.toThrow();
  });
});

describe('isCommitted — what counts against a budget', () => {
  it('counts an order still awaiting approval', () => {
    // Otherwise a branch could queue ten unapproved orders, each within budget,
    // and blow the cap the moment they were approved together.
    expect(isCommitted(OrderStatus.PENDING_APPROVAL)).toBe(true);
  });

  it('does not count a draft, a rejection or a cancellation', () => {
    expect(isCommitted(OrderStatus.DRAFT)).toBe(false);
    expect(isCommitted(OrderStatus.REJECTED)).toBe(false);
    expect(isCommitted(OrderStatus.CANCELLED)).toBe(false);
  });

  it('counts everything in or past fulfilment', () => {
    expect(COMMITTED_STATUSES).toEqual([
      OrderStatus.PENDING_APPROVAL,
      OrderStatus.CHANGES_REQUESTED,
      OrderStatus.APPROVED,
      OrderStatus.PROCESSING,
      OrderStatus.DISPATCHED,
      OrderStatus.DELIVERED,
    ]);
  });

  it('covers every status exactly once between committed and not', () => {
    // A status added later must be classified deliberately, not fall through
    // and silently escape the budget.
    const all = Object.values(OrderStatus);
    const uncommitted = all.filter((status) => !isCommitted(status));

    expect([...COMMITTED_STATUSES, ...uncommitted].sort()).toEqual([...all].sort());
  });
});

describe('requiresApproval', () => {
  it('approves everything automatically when no threshold is set', () => {
    expect(requiresApproval(9_999_999, null)).toBe(false);
  });

  it('requires approval for every order when the threshold is zero', () => {
    // Zero is a real configuration — "everything gets checked" — and the reason
    // the column is nullable rather than using 0 as a sentinel.
    expect(requiresApproval(1, 0)).toBe(true);
  });

  it('lets an order landing exactly on the threshold through', () => {
    // A head office that sets £1,000 means "up to a thousand is fine".
    expect(requiresApproval(100_000, 100_000)).toBe(false);
  });

  it('catches an order one cent over', () => {
    expect(requiresApproval(100_001, 100_000)).toBe(true);
  });

  it('does not require approval for a free order under a zero threshold', () => {
    expect(requiresApproval(0, 0)).toBe(false);
  });
});
