import { describe, expect, it } from 'vitest';
import { billingPeriodOf, billingPeriodRange, evaluateBudget } from './budget';

/**
 * SOW QA-01 names "budget cap calculations" as a unit-test target. Getting this
 * wrong either blocks a branch that has budget left, or lets one spend past a
 * ceiling its head office set — and the second is found at invoicing.
 *
 * Amounts are in cents: 100_000 is £1,000.00.
 */

describe('evaluateBudget', () => {
  it('never blocks an uncapped branch', () => {
    const status = evaluateBudget({ capCents: null, spentCents: 0, cartTotalCents: 5_000_000 });

    expect(status.wouldExceed).toBe(false);
    expect(status.remainingCents).toBeNull();
    expect(status.utilisationPercent).toBeNull();
  });

  it('blocks every order for a branch capped at zero', () => {
    // Zero is a spending freeze, not an absence of a cap. The schema keeps the
    // two apart deliberately and this is the behaviour that depends on it.
    const status = evaluateBudget({ capCents: 0, spentCents: 0, cartTotalCents: 100 });

    expect(status.wouldExceed).toBe(true);
    expect(status.remainingCents).toBe(0);
  });

  it('allows a basket that lands exactly on the cap', () => {
    // Strictly greater. A branch with £1,000 left may spend £1,000.
    const status = evaluateBudget({
      capCents: 100_000,
      spentCents: 40_000,
      cartTotalCents: 60_000,
    });

    expect(status.wouldExceed).toBe(false);
    expect(status.projectedCents).toBe(100_000);
    expect(status.remainingCents).toBe(60_000);
  });

  it('blocks a basket one cent over', () => {
    const status = evaluateBudget({
      capCents: 100_000,
      spentCents: 40_000,
      cartTotalCents: 60_001,
    });

    expect(status.wouldExceed).toBe(true);
    expect(status.overageCents).toBe(1);
  });

  it('reports how far over, so the buyer knows what to remove', () => {
    const status = evaluateBudget({
      capCents: 100_000,
      spentCents: 90_000,
      cartTotalCents: 25_000,
    });

    expect(status.overageCents).toBe(15_000);
    expect(status.remainingCents).toBe(10_000);
  });

  it('floors the remaining balance at zero for a branch already over', () => {
    // A negative "remaining" renders as credit in every UI that shows it.
    const status = evaluateBudget({
      capCents: 100_000,
      spentCents: 130_000,
      cartTotalCents: 1_000,
    });

    expect(status.remainingCents).toBe(0);
    expect(status.wouldExceed).toBe(true);
    expect(status.overageCents).toBe(31_000);
  });

  it('reports utilisation to two decimal places', () => {
    const status = evaluateBudget({
      capCents: 300_000,
      spentCents: 100_000,
      cartTotalCents: 0,
    });

    expect(status.utilisationPercent).toBe(33.33);
  });

  it('has no meaningful utilisation for a zero cap', () => {
    expect(
      evaluateBudget({ capCents: 0, spentCents: 0, cartTotalCents: 0 }).utilisationPercent,
    ).toBeNull();
  });

  it('treats negative recorded spend as zero rather than as credit', () => {
    // Defensive: a refund posted as a negative would otherwise widen the cap.
    const status = evaluateBudget({
      capCents: 100_000,
      spentCents: -50_000,
      cartTotalCents: 100_000,
    });

    expect(status.spentCents).toBe(0);
    expect(status.wouldExceed).toBe(false);
  });

  it('an empty basket against a full budget is not an exceedance', () => {
    const status = evaluateBudget({
      capCents: 100_000,
      spentCents: 100_000,
      cartTotalCents: 0,
    });

    expect(status.wouldExceed).toBe(false);
    expect(status.remainingCents).toBe(0);
  });
});

describe('billingPeriodOf', () => {
  it('formats as YYYY-MM, zero-padded', () => {
    expect(billingPeriodOf(new Date('2026-03-15T10:00:00.000Z'))).toBe('2026-03');
  });

  it('uses UTC, not the server clock', () => {
    // 23:30 on 31 January UTC is still January, wherever the process runs.
    // BE-09 aggregates invoices by exactly this key, so it cannot drift with
    // the deployment's timezone.
    expect(billingPeriodOf(new Date('2026-01-31T23:30:00.000Z'))).toBe('2026-01');
  });

  it('rolls into the next month at the boundary', () => {
    expect(billingPeriodOf(new Date('2026-02-01T00:00:00.000Z'))).toBe('2026-02');
  });
});

describe('billingPeriodRange', () => {
  it('is a half-open window, so no order lands in two periods', () => {
    const { start, end } = billingPeriodRange('2026-03');

    expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls December into the following January', () => {
    const { start, end } = billingPeriodRange('2026-12');

    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('covers a leap February exactly', () => {
    const { end } = billingPeriodRange('2028-02');
    expect(end.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it('refuses anything that is not a period', () => {
    expect(() => billingPeriodRange('2026-13')).toThrow();
    expect(() => billingPeriodRange('2026-00')).toThrow();
    expect(() => billingPeriodRange('March 2026')).toThrow();
  });
});
