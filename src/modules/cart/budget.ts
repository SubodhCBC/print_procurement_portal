/**
 * The monthly budget cap, and whether a basket fits inside what is left of it.
 *
 * Pure and free of Prisma, for the same reasons the pricing arithmetic is: SOW
 * QA-01 names "budget cap calculations" as a unit-test target, and BE-06
 * re-checks the same sum when an order is placed — the balance moves between
 * validating a cart and submitting it, and the check that matters is the one at
 * submission.
 *
 * Money is integer cents throughout, matching product-pricing.ts.
 */

export interface BudgetInput {
  /**
   * The site's cap for one period, in cents. **Null means uncapped; zero means
   * the branch may not order at all.** Those are different states and the
   * schema keeps them apart deliberately — a branch on a spending freeze is a
   * real configuration, not an absence of one.
   */
  readonly capCents: number | null;
  /** Already committed this period, in cents. */
  readonly spentCents: number;
  /** What this basket would add, in cents. */
  readonly cartTotalCents: number;
}

export interface BudgetStatus {
  readonly capCents: number | null;
  readonly spentCents: number;
  /** Cap minus spend, floored at zero. Null when uncapped. */
  readonly remainingCents: number | null;
  readonly cartTotalCents: number;
  /** Spend plus this basket. */
  readonly projectedCents: number;
  readonly wouldExceed: boolean;
  /** How far over, in cents. Zero when it fits. */
  readonly overageCents: number;
  /** Percentage of the cap this basket would consume; null when uncapped. */
  readonly utilisationPercent: number | null;
}

export function evaluateBudget(input: BudgetInput): BudgetStatus {
  const spentCents = Math.max(0, input.spentCents);
  const projectedCents = spentCents + input.cartTotalCents;

  if (input.capCents === null) {
    return {
      capCents: null,
      spentCents,
      remainingCents: null,
      cartTotalCents: input.cartTotalCents,
      projectedCents,
      wouldExceed: false,
      overageCents: 0,
      utilisationPercent: null,
    };
  }

  const cap = Math.max(0, input.capCents);
  // Floored at zero: a branch already over its cap has nothing left, and a
  // negative "remaining" reads as credit in every UI that renders it.
  const remainingCents = Math.max(0, cap - spentCents);
  const overageCents = Math.max(0, projectedCents - cap);

  return {
    capCents: cap,
    spentCents,
    remainingCents,
    cartTotalCents: input.cartTotalCents,
    projectedCents,
    // Strictly greater: a basket that lands exactly on the cap is within it.
    wouldExceed: projectedCents > cap,
    overageCents,
    // A cap of zero has no meaningful percentage — any spend at all is over it.
    utilisationPercent: cap === 0 ? null : Math.round((projectedCents / cap) * 10000) / 100,
  };
}

/**
 * The billing period a moment falls in, as `YYYY-MM`.
 *
 * UTC, deliberately. The alternative — the server's local zone — makes an order
 * placed at 23:30 on the 31st fall in a different month depending on where the
 * process happens to be running, and BE-09 aggregates invoices by exactly this
 * key. A customer in Melbourne will see a period boundary that is not their
 * local midnight; that is a known, stated cost, and the client has to tell us
 * their billing timezone before it can be anything else.
 */
export function billingPeriodOf(at: Date = new Date()): string {
  const year = at.getUTCFullYear();
  const month = `${at.getUTCMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}

/** The half-open UTC window `[start, end)` of a `YYYY-MM` period. */
export function billingPeriodRange(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`Not a billing period: ${period}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Not a billing period: ${period}`);

  // Month 12 rolls into January of the next year on its own — Date.UTC accepts
  // a month index of 12 and normalises it.
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}
