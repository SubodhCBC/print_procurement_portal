import { BusinessRuleError } from '@/common';

/**
 * Which rules an order trips, and what happens as each decision lands
 * (SOW BE-07).
 *
 * Pure and free of Prisma, for the same reason the pricing and lifecycle rules
 * are: SOW QA-01 names "approval routing thresholds" as a unit-test target, and
 * this decides whether a customer's spending controls actually hold. A bug here
 * either strands orders nobody can approve or lets a large one through
 * unnoticed, and the second is found by a finance team at month end.
 */

export type PortalRole = 'ADMIN' | 'HEAD_OFFICE' | 'SITE_USER';

/** A rule's trigger conditions and its routing, as the engine sees them. */
export interface ApprovalRuleSpec {
  readonly id: string;
  readonly name: string;
  readonly tier: number;
  /** Order total at or above this, in cents. Null does not constrain. */
  readonly minTotalCents: number | null;
  readonly categoryId: string | null;
  readonly requesterRole: PortalRole | null;
  readonly siteId: string | null;
  readonly approverRole: PortalRole | null;
  readonly approverUserId: string | null;
}

/** What the engine is matching rules against. */
export interface OrderFacts {
  readonly totalCents: number;
  readonly siteId: string;
  readonly requesterRole: PortalRole;
  readonly requesterId: string;
  /** Every category the order's lines belong to. */
  readonly categoryIds: readonly string[];
}

/**
 * Whether one rule applies.
 *
 * **Every stated condition must hold, and an unstated one does not constrain.**
 * A rule with none at all therefore matches every order, which is how "all
 * orders need head-office sign-off" is written — and is why an accidentally
 * blank rule is a loud failure rather than a silent one.
 *
 * `minTotal` is inclusive: a rule that says "$1,000 and above" catches an order
 * of exactly $1,000. That is the opposite of `Account.approvalThreshold`, which
 * is exclusive because it reads as "up to $1,000 is fine" — the two are worded
 * differently by the people who set them, so they behave differently on
 * purpose, and both are tested.
 */
export function ruleMatches(rule: ApprovalRuleSpec, facts: OrderFacts): boolean {
  if (rule.minTotalCents !== null && facts.totalCents < rule.minTotalCents) return false;
  if (rule.siteId !== null && rule.siteId !== facts.siteId) return false;
  if (rule.requesterRole !== null && rule.requesterRole !== facts.requesterRole) return false;
  if (rule.categoryId !== null && !facts.categoryIds.includes(rule.categoryId)) return false;
  return true;
}

export interface PlannedStep {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly tier: number;
  readonly approverRole: PortalRole | null;
  readonly approverUserId: string | null;
}

/**
 * The steps an order must clear, in tier order.
 *
 * Returns an empty array when nothing matches, which the caller reads as "no
 * approval needed" — not as an error. Most orders in a well-configured account
 * match nothing.
 *
 * Duplicate approvers within a tier are collapsed. Two rules that both route to
 * the same head-office manager are one signature, not two, and asking the same
 * person twice makes the queue look broken.
 */
export function planApproval(
  rules: readonly ApprovalRuleSpec[],
  facts: OrderFacts,
): readonly PlannedStep[] {
  const matched = rules.filter((rule) => ruleMatches(rule, facts));

  const seen = new Set<string>();
  const steps: PlannedStep[] = [];

  for (const rule of matched) {
    // Keyed on tier *and* approver: the same manager may legitimately be asked
    // at tier 1 and again at tier 3 of a long chain, but never twice in one.
    const key = `${rule.tier}:${rule.approverUserId ?? `role:${rule.approverRole ?? ''}`}`;
    if (seen.has(key)) continue;
    seen.add(key);

    steps.push({
      ruleId: rule.id,
      ruleName: rule.name,
      tier: rule.tier,
      approverRole: rule.approverRole,
      approverUserId: rule.approverUserId,
    });
  }

  return steps.sort((a, b) => a.tier - b.tier || a.ruleId.localeCompare(b.ruleId));
}

/**
 * Whether a person may decide a particular step.
 *
 * A step naming a user is that person's alone. A step naming a role is open to
 * anyone in the account holding it — that is what makes a rota work when
 * someone is on leave.
 *
 * **The requester can never decide their own order**, whatever the rule says
 * and whatever role they hold. An administrator is not exempt: an approval
 * control that its subject can satisfy is not a control, and "the admin also
 * placed it" is exactly the case an auditor asks about.
 */
export function canDecideStep(
  step: { approverRole: PortalRole | null; approverUserId: string | null },
  actor: { userId: string; role: PortalRole },
  requesterId: string,
): boolean {
  if (actor.userId === requesterId) return false;
  if (step.approverUserId) return step.approverUserId === actor.userId;
  if (step.approverRole) return step.approverRole === actor.role || actor.role === 'ADMIN';
  return false;
}

export type StepStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'SKIPPED';
export type RequestOutcome = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';

export interface StepState {
  readonly tier: number;
  readonly status: StepStatus;
}

export interface RequestProgress {
  readonly outcome: RequestOutcome;
  /** The tier now open for decision; unchanged when the request is finished. */
  readonly currentTier: number;
  /** Steps at tiers that will never open, because an earlier one refused. */
  readonly skipTiersAbove: number | null;
}

/**
 * Where a request stands after its steps are read.
 *
 * The rules, in the order they are applied:
 *
 * 1. **Any rejection ends it.** One approver refusing is a refusal; waiting for
 *    the others to agree would only delay the same answer.
 * 2. **Any change request pauses it.** The buyer has to act, and a second
 *    approver deciding in the meantime would be deciding on an order that is
 *    about to change.
 * 3. **A tier opens only when every step below it has been approved.** That is
 *    what "hierarchical" means here — tier two is a second signature on an
 *    order tier one has already accepted, not a parallel opinion.
 * 4. **The request completes when the highest tier is clear.**
 */
export function evaluateProgress(steps: readonly StepState[]): RequestProgress {
  if (steps.length === 0) {
    // Nothing to decide. Callers should not create a request at all in this
    // case, but answering APPROVED is the safe reading — an empty set of
    // conditions has been satisfied.
    return { outcome: 'APPROVED', currentTier: 1, skipTiersAbove: null };
  }

  const rejected = steps.find((step) => step.status === 'REJECTED');
  if (rejected) {
    return { outcome: 'REJECTED', currentTier: rejected.tier, skipTiersAbove: rejected.tier };
  }

  const changes = steps.find((step) => step.status === 'CHANGES_REQUESTED');
  if (changes) {
    return {
      outcome: 'CHANGES_REQUESTED',
      currentTier: changes.tier,
      skipTiersAbove: null,
    };
  }

  const tiers = [...new Set(steps.map((step) => step.tier))].sort((a, b) => a - b);

  for (const tier of tiers) {
    const inTier = steps.filter((step) => step.tier === tier);
    // SKIPPED counts as settled: a step whose rule was retired mid-flight must
    // not hold the tier open forever.
    const settled = inTier.every((step) => step.status === 'APPROVED' || step.status === 'SKIPPED');
    if (!settled) return { outcome: 'PENDING', currentTier: tier, skipTiersAbove: null };
  }

  return {
    outcome: 'APPROVED',
    currentTier: tiers[tiers.length - 1] ?? 1,
    skipTiersAbove: null,
  };
}

/**
 * Guards a decision against a step that is not open.
 *
 * Two people opening the approvals queue and both pressing Approve on the same
 * order is ordinary, not exceptional. The second one gets this rather than
 * silently overwriting the first decision and its timestamp.
 */
export function assertStepOpen(
  step: { status: StepStatus; tier: number },
  currentTier: number,
): void {
  if (step.status !== 'PENDING') {
    throw new BusinessRuleError('This approval has already been decided.', {
      details: { status: step.status },
    });
  }

  if (step.tier !== currentTier) {
    throw new BusinessRuleError(
      `This order is still with tier ${currentTier}. Tier ${step.tier} opens once that round is complete.`,
      { details: { stepTier: step.tier, currentTier } },
    );
  }
}
