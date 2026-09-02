import { describe, expect, it } from 'vitest';
import {
  assertStepOpen,
  canDecideStep,
  evaluateProgress,
  planApproval,
  ruleMatches,
  type ApprovalRuleSpec,
  type OrderFacts,
  type StepState,
} from './approval-engine';

/**
 * SOW QA-01 names "approval routing thresholds" as a unit-test target. This is
 * the logic that decides whether a customer's spending controls actually hold:
 * a bug either strands orders nobody can approve, or lets a large one through
 * unnoticed — and the second is found by a finance team at month end.
 *
 * Totals are in cents: 100_000 is £1,000.00.
 */

function rule(overrides: Partial<ApprovalRuleSpec> = {}): ApprovalRuleSpec {
  return {
    id: 'apr_1',
    name: 'Test rule',
    tier: 1,
    minTotalCents: null,
    categoryId: null,
    requesterRole: null,
    siteId: null,
    approverRole: 'HEAD_OFFICE',
    approverUserId: null,
    ...overrides,
  };
}

function facts(overrides: Partial<OrderFacts> = {}): OrderFacts {
  return {
    totalCents: 50_000,
    siteId: 'sit_1',
    requesterRole: 'SITE_USER',
    requesterId: 'usr_buyer',
    categoryIds: ['cat_flyers'],
    ...overrides,
  };
}

describe('ruleMatches', () => {
  it('a rule with no conditions catches every order', () => {
    // How "everything needs head-office sign-off" is written — and why an
    // accidentally blank rule fails loudly rather than silently.
    expect(ruleMatches(rule(), facts())).toBe(true);
  });

  it('matches at the threshold, not just above it', () => {
    // Inclusive, unlike Account.approvalThreshold. A rule that says "$1,000 and
    // above" catches an order of exactly $1,000; a threshold that reads "up to
    // $1,000 is fine" does not. The two are worded differently by the people
    // who set them, so they behave differently on purpose.
    expect(ruleMatches(rule({ minTotalCents: 100_000 }), facts({ totalCents: 100_000 }))).toBe(
      true,
    );
    expect(ruleMatches(rule({ minTotalCents: 100_000 }), facts({ totalCents: 99_999 }))).toBe(
      false,
    );
  });

  it('matches a category on any line, not on all of them', () => {
    const branded = rule({ categoryId: 'cat_branded' });

    expect(ruleMatches(branded, facts({ categoryIds: ['cat_flyers', 'cat_branded'] }))).toBe(true);
    expect(ruleMatches(branded, facts({ categoryIds: ['cat_flyers'] }))).toBe(false);
  });

  it('can be scoped to one branch', () => {
    const vic = rule({ siteId: 'sit_vic' });

    expect(ruleMatches(vic, facts({ siteId: 'sit_vic' }))).toBe(true);
    expect(ruleMatches(vic, facts({ siteId: 'sit_nsw' }))).toBe(false);
  });

  it('can be scoped to who raised it', () => {
    const siteUsersOnly = rule({ requesterRole: 'SITE_USER' });

    expect(ruleMatches(siteUsersOnly, facts({ requesterRole: 'SITE_USER' }))).toBe(true);
    expect(ruleMatches(siteUsersOnly, facts({ requesterRole: 'HEAD_OFFICE' }))).toBe(false);
  });

  it('requires every stated condition together', () => {
    const both = rule({ minTotalCents: 100_000, categoryId: 'cat_branded' });

    expect(ruleMatches(both, facts({ totalCents: 200_000, categoryIds: ['cat_branded'] }))).toBe(
      true,
    );
    // Big enough, wrong category.
    expect(ruleMatches(both, facts({ totalCents: 200_000, categoryIds: ['cat_flyers'] }))).toBe(
      false,
    );
    // Right category, too small.
    expect(ruleMatches(both, facts({ totalCents: 50_000, categoryIds: ['cat_branded'] }))).toBe(
      false,
    );
  });
});

describe('planApproval', () => {
  it('needs nobody when no rule matches', () => {
    // The ordinary case in a well-configured account, and not an error.
    const plan = planApproval([rule({ minTotalCents: 999_999 })], facts());
    expect(plan).toEqual([]);
  });

  it('orders steps by tier', () => {
    const plan = planApproval(
      [
        rule({ id: 'r3', tier: 3, approverRole: 'ADMIN' }),
        rule({ id: 'r1', tier: 1 }),
        rule({ id: 'r2', tier: 2, approverUserId: 'usr_cfo' }),
      ],
      facts(),
    );

    expect(plan.map((step) => step.tier)).toEqual([1, 2, 3]);
  });

  it('does not ask the same person twice in one tier', () => {
    // Two rules routing to the same manager are one signature. Asking twice
    // makes the queue look broken.
    const plan = planApproval(
      [
        rule({ id: 'r1', name: 'Over $500', minTotalCents: 50_000, approverUserId: 'usr_boss' }),
        rule({
          id: 'r2',
          name: 'Branded stock',
          categoryId: 'cat_flyers',
          approverUserId: 'usr_boss',
        }),
      ],
      facts(),
    );

    expect(plan).toHaveLength(1);
  });

  it('does ask the same person again at a different tier', () => {
    // A long chain can legitimately return to the same manager for a second,
    // higher-value signature.
    const plan = planApproval(
      [
        rule({ id: 'r1', tier: 1, approverUserId: 'usr_boss' }),
        rule({ id: 'r2', tier: 3, approverUserId: 'usr_boss' }),
      ],
      facts(),
    );

    expect(plan.map((step) => step.tier)).toEqual([1, 3]);
  });

  it('keeps a role step and a named-person step apart', () => {
    const plan = planApproval(
      [
        rule({ id: 'r1', approverRole: 'HEAD_OFFICE', approverUserId: null }),
        rule({ id: 'r2', approverRole: null, approverUserId: 'usr_cfo' }),
      ],
      facts(),
    );

    expect(plan).toHaveLength(2);
  });
});

describe('canDecideStep', () => {
  const roleStep = { approverRole: 'HEAD_OFFICE' as const, approverUserId: null };
  const namedStep = { approverRole: null, approverUserId: 'usr_cfo' };

  it('lets anyone in the named role decide', () => {
    // What makes a rota work when someone is on leave.
    expect(canDecideStep(roleStep, { userId: 'usr_a', role: 'HEAD_OFFICE' }, 'usr_buyer')).toBe(
      true,
    );
    expect(canDecideStep(roleStep, { userId: 'usr_b', role: 'HEAD_OFFICE' }, 'usr_buyer')).toBe(
      true,
    );
  });

  it('refuses someone in the wrong role', () => {
    expect(canDecideStep(roleStep, { userId: 'usr_c', role: 'SITE_USER' }, 'usr_buyer')).toBe(
      false,
    );
  });

  it('lets an administrator stand in on a role step', () => {
    expect(canDecideStep(roleStep, { userId: 'usr_admin', role: 'ADMIN' }, 'usr_buyer')).toBe(true);
  });

  it('a named step belongs to that person alone, even for an administrator', () => {
    expect(canDecideStep(namedStep, { userId: 'usr_cfo', role: 'HEAD_OFFICE' }, 'usr_buyer')).toBe(
      true,
    );
    expect(canDecideStep(namedStep, { userId: 'usr_admin', role: 'ADMIN' }, 'usr_buyer')).toBe(
      false,
    );
  });

  it('never lets the requester decide their own order', () => {
    // Not even an administrator. A control its subject can satisfy is not a
    // control, and "the admin also placed it" is exactly what an auditor asks.
    expect(canDecideStep(roleStep, { userId: 'usr_buyer', role: 'HEAD_OFFICE' }, 'usr_buyer')).toBe(
      false,
    );
    expect(canDecideStep(roleStep, { userId: 'usr_buyer', role: 'ADMIN' }, 'usr_buyer')).toBe(
      false,
    );
    expect(canDecideStep(namedStep, { userId: 'usr_cfo', role: 'HEAD_OFFICE' }, 'usr_cfo')).toBe(
      false,
    );
  });
});

describe('evaluateProgress', () => {
  const step = (tier: number, status: StepState['status']): StepState => ({ tier, status });

  it('waits while the first tier is undecided', () => {
    const progress = evaluateProgress([step(1, 'PENDING'), step(2, 'PENDING')]);

    expect(progress.outcome).toBe('PENDING');
    expect(progress.currentTier).toBe(1);
  });

  it('opens tier two only once tier one is fully approved', () => {
    const partial = evaluateProgress([step(1, 'APPROVED'), step(1, 'PENDING'), step(2, 'PENDING')]);
    expect(partial.currentTier).toBe(1);

    const advanced = evaluateProgress([
      step(1, 'APPROVED'),
      step(1, 'APPROVED'),
      step(2, 'PENDING'),
    ]);
    expect(advanced.currentTier).toBe(2);
    expect(advanced.outcome).toBe('PENDING');
  });

  it('completes when the last tier clears', () => {
    const progress = evaluateProgress([step(1, 'APPROVED'), step(2, 'APPROVED')]);

    expect(progress.outcome).toBe('APPROVED');
  });

  it('ends immediately on a rejection, whatever else is pending', () => {
    // Waiting for the others to agree would only delay the same answer.
    const progress = evaluateProgress([
      step(1, 'REJECTED'),
      step(1, 'PENDING'),
      step(2, 'PENDING'),
    ]);

    expect(progress.outcome).toBe('REJECTED');
    expect(progress.skipTiersAbove).toBe(1);
  });

  it('pauses on a change request rather than letting others decide', () => {
    // A second approver deciding now would be deciding on an order that is
    // about to change.
    const progress = evaluateProgress([step(1, 'CHANGES_REQUESTED'), step(1, 'PENDING')]);

    expect(progress.outcome).toBe('CHANGES_REQUESTED');
  });

  it('treats a rejection as final even after an earlier approval', () => {
    const progress = evaluateProgress([step(1, 'APPROVED'), step(2, 'REJECTED')]);

    expect(progress.outcome).toBe('REJECTED');
    expect(progress.skipTiersAbove).toBe(2);
  });

  it('does not let a skipped step hold a tier open', () => {
    // A step whose rule was retired mid-flight must not strand the order.
    const progress = evaluateProgress([step(1, 'SKIPPED'), step(2, 'APPROVED')]);

    expect(progress.outcome).toBe('APPROVED');
  });

  it('treats an empty plan as satisfied', () => {
    expect(evaluateProgress([]).outcome).toBe('APPROVED');
  });

  it('handles non-contiguous tiers', () => {
    // An administrator can number tiers 1, 5, 10 to leave room to insert
    // rounds later. Nothing here assumes they are consecutive.
    const progress = evaluateProgress([
      step(1, 'APPROVED'),
      step(5, 'PENDING'),
      step(10, 'PENDING'),
    ]);

    expect(progress.currentTier).toBe(5);
  });
});

describe('assertStepOpen', () => {
  it('permits a pending step at the open tier', () => {
    expect(() => assertStepOpen({ status: 'PENDING', tier: 1 }, 1)).not.toThrow();
  });

  it('refuses a step somebody has already decided', () => {
    // Two people opening the queue and both pressing Approve is ordinary. The
    // second gets this rather than silently overwriting the first decision.
    expect(() => assertStepOpen({ status: 'APPROVED', tier: 1 }, 1)).toThrow(
      /already been decided/,
    );
  });

  it('refuses a step whose tier has not opened, and says why', () => {
    expect(() => assertStepOpen({ status: 'PENDING', tier: 2 }, 1)).toThrow(/still with tier 1/);
  });
});
