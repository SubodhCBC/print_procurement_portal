import { BusinessRuleError } from '@/common';

/**
 * The date arithmetic every report shares (SOW BE-10).
 *
 * Pure and free of Prisma, for the usual reason: this decides which orders a
 * number is computed from, and a bug here moves revenue between months rather
 * than producing an obviously wrong figure. That is the kind of error a board
 * pack carries for a quarter before anyone notices.
 *
 * UTC throughout, matching `billingPeriod` on orders and invoices. A report
 * that bucketed by the server's local midnight would disagree with the invoice
 * for every order placed in the last hours of a month.
 */

export type Granularity = 'day' | 'week' | 'month';

export interface DateRange {
  readonly from: Date;
  /** Exclusive, so no order can land in two buckets. */
  readonly to: Date;
}

/**
 * The window a report covers, defaulted to the last 30 days.
 *
 * Thirty rather than "this month": an executive opening a dashboard on the 2nd
 * wants the last month of trading, not two days of it.
 */
export function resolveRange(from?: Date, to?: Date, now: Date = new Date()): DateRange {
  const end = to ?? startOfNextUtcDay(now);
  const start = from ?? new Date(end.getTime() - 30 * 86_400_000);

  if (start >= end) {
    throw new BusinessRuleError('The report range must start before it ends.', {
      details: { from: start.toISOString(), to: end.toISOString() },
    });
  }

  return { from: start, to: end };
}

/**
 * The equivalent window immediately before this one, for a like-for-like
 * comparison.
 *
 * The same *length*, not the same calendar month. Comparing a 31-day January
 * against a 28-day February makes every February look like a downturn, and the
 * first question anyone asks of a dashboard is "against what?".
 */
export function previousRange(range: DateRange): DateRange {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from };
}

/**
 * Percentage change, to one decimal place.
 *
 * Null when there is nothing to compare against — a month that follows a month
 * of zero has not grown by infinity, and rendering "∞%" or "100%" would both be
 * inventing a number. The caller shows "no comparison" instead.
 */
export function growthPercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * The bucket a moment belongs to, as an ISO date string.
 *
 * Weeks start on Monday, which is what every business calendar in the
 * customer's world uses; the JavaScript default of Sunday would split a trading
 * week across two buckets.
 */
export function bucketOf(at: Date, granularity: Granularity): string {
  switch (granularity) {
    case 'day':
      return at.toISOString().slice(0, 10);

    case 'week': {
      const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
      // getUTCDay: 0 is Sunday, so Sunday moves back six days rather than none.
      const shift = (monday.getUTCDay() + 6) % 7;
      monday.setUTCDate(monday.getUTCDate() - shift);
      return monday.toISOString().slice(0, 10);
    }

    case 'month':
      return `${at.toISOString().slice(0, 7)}-01`;
  }
}

/**
 * Every bucket in the range, including the empty ones.
 *
 * A chart that omits days with no orders draws a straight line through them and
 * silently overstates a quiet week. The zeroes have to be in the data.
 */
export function bucketsIn(range: DateRange, granularity: Granularity): string[] {
  const buckets: string[] = [];

  // The cursor walks bucket *boundaries*, not fixed offsets from the range's
  // start. Stepping seven days from an arbitrary Thursday lands on Thursdays,
  // and the final partial week — which does contain orders — gets skipped.
  let cursor = startOfBucket(range.from, granularity);

  // Guard against a range so wide it would build a million-element array. A
  // decade of days is fine; a bad `from` of 1970 is not a chart anyone wants.
  const limit = 1_000;

  while (cursor < range.to && buckets.length < limit) {
    buckets.push(bucketOf(cursor, granularity));
    cursor = nextBucket(cursor, granularity);
  }

  return buckets;
}

/** The first instant of the bucket a moment falls in. */
function startOfBucket(at: Date, granularity: Granularity): Date {
  return new Date(`${bucketOf(at, granularity)}T00:00:00.000Z`);
}

function nextBucket(bucketStart: Date, granularity: Granularity): Date {
  const next = new Date(bucketStart);
  if (granularity === 'month') next.setUTCMonth(next.getUTCMonth() + 1, 1);
  else next.setUTCDate(next.getUTCDate() + (granularity === 'week' ? 7 : 1));
  return next;
}

/**
 * A sensible granularity for a range, when the caller has not chosen one.
 *
 * Daily up to two months, weekly up to a year, monthly beyond. The thresholds
 * are about what a chart can actually render: 400 daily points on a dashboard
 * card is a smear rather than a trend.
 */
export function defaultGranularity(range: DateRange): Granularity {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  if (days <= 62) return 'day';
  if (days <= 366) return 'week';
  return 'month';
}

function startOfNextUtcDay(at: Date): Date {
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
