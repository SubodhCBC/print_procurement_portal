import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  bucketsIn,
  defaultGranularity,
  growthPercent,
  previousRange,
  resolveRange,
} from './report-periods';

/**
 * This decides which orders a reported number is computed from. A bug here does
 * not produce an obviously wrong figure — it moves revenue between months, and
 * a board pack carries that for a quarter before anyone notices.
 */

const at = (iso: string) => new Date(iso);

describe('resolveRange', () => {
  it('defaults to the last thirty days, ending at the end of today', () => {
    // Not "this month": an executive opening a dashboard on the 2nd wants the
    // last month of trading, not two days of it.
    const range = resolveRange(undefined, undefined, at('2026-09-03T14:00:00.000Z'));

    expect(range.to.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    expect(range.from.toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });

  it('includes everything ordered today', () => {
    // The upper bound is the start of tomorrow, so an order placed at 23:59
    // still lands in the report.
    const range = resolveRange(undefined, undefined, at('2026-09-03T23:59:59.000Z'));

    expect(range.to.toISOString()).toBe('2026-09-04T00:00:00.000Z');
  });

  it('honours an explicit window', () => {
    const range = resolveRange(at('2026-01-01T00:00:00.000Z'), at('2026-02-01T00:00:00.000Z'));

    expect(range.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('refuses a window that ends before it starts', () => {
    expect(() =>
      resolveRange(at('2026-02-01T00:00:00.000Z'), at('2026-01-01T00:00:00.000Z')),
    ).toThrow(/start before it ends/);
  });

  it('refuses a zero-length window', () => {
    const instant = at('2026-01-01T00:00:00.000Z');
    expect(() => resolveRange(instant, instant)).toThrow();
  });
});

describe('previousRange', () => {
  it('is the same length, immediately before', () => {
    // The same *length*, not the same calendar month: comparing a 31-day
    // January against a 28-day February makes every February look like a
    // downturn.
    const range = {
      from: at('2026-03-01T00:00:00.000Z'),
      to: at('2026-04-01T00:00:00.000Z'),
    };
    const previous = previousRange(range);

    expect(previous.to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(previous.from.toISOString()).toBe('2026-01-29T00:00:00.000Z');
    expect(previous.to.getTime() - previous.from.getTime()).toBe(
      range.to.getTime() - range.from.getTime(),
    );
  });

  it('meets the current range exactly, so nothing is counted twice or missed', () => {
    const range = { from: at('2026-09-01T00:00:00.000Z'), to: at('2026-09-08T00:00:00.000Z') };

    expect(previousRange(range).to.getTime()).toBe(range.from.getTime());
  });
});

describe('growthPercent', () => {
  it('reports growth to one decimal place', () => {
    expect(growthPercent(1200, 1000)).toBe(20);
    expect(growthPercent(1333, 1000)).toBe(33.3);
  });

  it('reports a decline as negative', () => {
    expect(growthPercent(800, 1000)).toBe(-20);
  });

  it('has no answer when there is nothing to compare against', () => {
    // A month following a month of zero has not grown by infinity, and "100%"
    // would be inventing a number. The UI shows "no comparison".
    expect(growthPercent(500, 0)).toBeNull();
  });

  it('reports zero when nothing changed', () => {
    expect(growthPercent(1000, 1000)).toBe(0);
  });

  it('handles a fall to nothing', () => {
    expect(growthPercent(0, 1000)).toBe(-100);
  });
});

describe('bucketOf', () => {
  it('buckets by UTC day', () => {
    expect(bucketOf(at('2026-09-03T23:30:00.000Z'), 'day')).toBe('2026-09-03');
  });

  it('starts weeks on Monday', () => {
    // Every business calendar in the customer's world does; the JavaScript
    // default of Sunday would split a trading week across two buckets.
    expect(bucketOf(at('2026-09-03T12:00:00.000Z'), 'week')).toBe('2026-08-31'); // Thu -> Mon
    expect(bucketOf(at('2026-08-31T00:00:00.000Z'), 'week')).toBe('2026-08-31'); // Mon itself
  });

  it('puts Sunday in the week that just ended, not the one starting', () => {
    // The case the naive `getUTCDay()` subtraction gets wrong.
    expect(bucketOf(at('2026-09-06T12:00:00.000Z'), 'week')).toBe('2026-08-31');
    expect(bucketOf(at('2026-09-07T12:00:00.000Z'), 'week')).toBe('2026-09-07');
  });

  it('buckets by month', () => {
    expect(bucketOf(at('2026-09-30T23:59:59.000Z'), 'month')).toBe('2026-09-01');
  });

  it('uses UTC, not the server clock', () => {
    // An order at 23:30 on the 31st belongs to that month wherever the process
    // is running — the same rule `billingPeriod` follows.
    expect(bucketOf(at('2026-01-31T23:30:00.000Z'), 'month')).toBe('2026-01-01');
  });
});

describe('bucketsIn', () => {
  it('includes the empty buckets', () => {
    // A chart that omits days with no orders draws a straight line through them
    // and silently overstates a quiet week.
    const buckets = bucketsIn(
      { from: at('2026-09-01T00:00:00.000Z'), to: at('2026-09-05T00:00:00.000Z') },
      'day',
    );

    expect(buckets).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  });

  it('does not run past the exclusive end', () => {
    const buckets = bucketsIn(
      { from: at('2026-09-01T00:00:00.000Z'), to: at('2026-09-02T00:00:00.000Z') },
      'day',
    );

    expect(buckets).toEqual(['2026-09-01']);
  });

  it('walks months by calendar, not by 30 days', () => {
    const buckets = bucketsIn(
      { from: at('2026-01-15T00:00:00.000Z'), to: at('2026-04-01T00:00:00.000Z') },
      'month',
    );

    expect(buckets).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('walks weeks from the first Monday on or before the start', () => {
    const buckets = bucketsIn(
      { from: at('2026-09-03T00:00:00.000Z'), to: at('2026-09-17T00:00:00.000Z') },
      'week',
    );

    expect(buckets).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
  });

  it('caps a range too wide to chart', () => {
    // A bad `from` of 1970 with daily granularity is not a chart anyone wants.
    const buckets = bucketsIn(
      { from: at('1970-01-01T00:00:00.000Z'), to: at('2026-01-01T00:00:00.000Z') },
      'day',
    );

    expect(buckets).toHaveLength(1000);
  });
});

describe('defaultGranularity', () => {
  it('is daily for a month', () => {
    expect(
      defaultGranularity({
        from: at('2026-09-01T00:00:00.000Z'),
        to: at('2026-10-01T00:00:00.000Z'),
      }),
    ).toBe('day');
  });

  it('is weekly for a quarter', () => {
    expect(
      defaultGranularity({
        from: at('2026-01-01T00:00:00.000Z'),
        to: at('2026-07-01T00:00:00.000Z'),
      }),
    ).toBe('week');
  });

  it('is monthly beyond a year', () => {
    // 400 daily points on a dashboard card is a smear rather than a trend.
    expect(
      defaultGranularity({
        from: at('2024-01-01T00:00:00.000Z'),
        to: at('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe('month');
  });
});
