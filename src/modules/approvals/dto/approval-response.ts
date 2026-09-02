import type { ApprovalRuleRow, FullApprovalRequest } from '../approvals.service';

/**
 * An approval request as the approvals hub sees it.
 *
 * Carries enough of the order — number, total, who raised it, which branch, the
 * purchase order — that the queue renders without a second call per row. FE-06
 * shows exactly these fields on its cards.
 */
export interface ApprovalRequestView {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderStatus: FullApprovalRequest['order']['status'];
  readonly orderTotal: string;
  readonly poNumber: string | null;
  readonly requestedById: string;
  readonly requestedByName: string;
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly status: FullApprovalRequest['status'];
  readonly currentTier: number;
  /** The total when this round was raised — a resubmitted order can differ. */
  readonly totalAtRequest: string;
  readonly steps: readonly ApprovalStepView[];
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface ApprovalStepView {
  readonly id: string;
  readonly tier: number;
  readonly ruleId: string | null;
  readonly approverRole: FullApprovalRequest['steps'][number]['approverRole'];
  readonly approverUserId: string | null;
  readonly status: FullApprovalRequest['steps'][number]['status'];
  readonly decidedById: string | null;
  readonly decidedByName: string | null;
  readonly decidedAt: string | null;
  readonly comment: string | null;
  /** True when this step is open for a decision now. */
  readonly isOpen: boolean;
}

export function toApprovalRequestView(request: FullApprovalRequest): ApprovalRequestView {
  return {
    id: request.id,
    orderId: request.orderId,
    orderNumber: request.order.orderNumber,
    orderStatus: request.order.status,
    orderTotal: request.order.total.toFixed(2),
    poNumber: request.order.poNumber,
    requestedById: request.order.placedById,
    requestedByName: request.order.placedByName,
    siteId: request.order.site.id,
    siteCode: request.order.site.code,
    siteName: request.order.site.name,
    status: request.status,
    currentTier: request.currentTier,
    totalAtRequest: request.totalAtRequest.toFixed(2),
    steps: request.steps.map((step) => ({
      id: step.id,
      tier: step.tier,
      ruleId: step.ruleId,
      approverRole: step.approverRole,
      approverUserId: step.approverUserId,
      status: step.status,
      decidedById: step.decidedById,
      decidedByName: step.decidedByName,
      decidedAt: step.decidedAt?.toISOString() ?? null,
      comment: step.comment,
      isOpen:
        request.status === 'PENDING' &&
        step.status === 'PENDING' &&
        step.tier === request.currentTier,
    })),
    createdAt: request.createdAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
  };
}

export interface ApprovalRuleView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly tier: number;
  readonly minTotal: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly requesterRole: ApprovalRuleRow['requesterRole'];
  readonly siteId: string | null;
  readonly approverRole: ApprovalRuleRow['approverRole'];
  readonly approverUserId: string | null;
  /** True when the rule states no conditions and therefore catches everything. */
  readonly matchesEverything: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toApprovalRuleView(rule: ApprovalRuleRow): ApprovalRuleView {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    active: rule.active,
    tier: rule.tier,
    minTotal: rule.minTotal?.toFixed(2) ?? null,
    categoryId: rule.categoryId,
    categoryName: rule.category?.name ?? null,
    requesterRole: rule.requesterRole,
    siteId: rule.siteId,
    approverRole: rule.approverRole,
    approverUserId: rule.approverUserId,
    // Surfaced rather than left for the administrator to work out: a rule that
    // catches every order is a legitimate configuration and also the most
    // common way to create one by accident.
    matchesEverything:
      rule.minTotal == null &&
      rule.categoryId == null &&
      rule.requesterRole == null &&
      rule.siteId == null,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}
