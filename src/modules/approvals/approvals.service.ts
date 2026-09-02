import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BusinessRuleError,
  ConflictError,
  createId,
  ForbiddenError,
  NotFoundError,
  offsetPage,
  Role,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
// The pure lifecycle file, not the orders barrel: that would re-export
// OrdersService, which depends on this service. Same deliberate deep import as
// the cart's, and for the same reason.
import { OrderStatus } from '@/modules/orders/order-status';
import { MailDispatcher } from '@/shared/mailer';
import {
  assertStepOpen,
  canDecideStep,
  evaluateProgress,
  planApproval,
  type ApprovalRuleSpec,
  type OrderFacts,
} from './approval-engine';
import type {
  CreateApprovalRuleDto,
  DecideApprovalDto,
  ListApprovalsQueryDto,
  UpdateApprovalRuleDto,
} from './dto/approval.dto';

const FULL_REQUEST = Prisma.validator<Prisma.ApprovalRequestInclude>()({
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      total: true,
      placedById: true,
      placedByName: true,
      poNumber: true,
      createdAt: true,
      site: { select: { id: true, code: true, name: true } },
      // Counted here rather than in a second query: the approval email states
      // how many items an order has, and "Items: 0" would be worse than not
      // saying it at all.
      _count: { select: { lines: true } },
    },
  },
  steps: { orderBy: [{ tier: 'asc' }, { createdAt: 'asc' }] },
});

export type FullApprovalRequest = Prisma.ApprovalRequestGetPayload<{
  include: typeof FULL_REQUEST;
}>;

export type ApprovalRuleRow = Prisma.ApprovalRuleGetPayload<{
  include: { category: { select: { id: true; code: true; name: true } } };
}>;

/**
 * The approval workflow engine (SOW BE-07).
 *
 * ---------------------------------------------------------------------------
 * Why this writes order rows directly
 * ---------------------------------------------------------------------------
 * A decision and the order status it produces must commit together. If the step
 * were written here and the order moved by a separate call to OrdersService,
 * a failure between them would leave an approved decision on an order still
 * sitting in the queue — visible to the approver as their click having done
 * nothing, and to the buyer as an order stuck forever.
 *
 * So the transition rule is imported from `order-status.ts` (pure, shared) and
 * the write happens in the same transaction as the step. OrdersModule depends
 * on this module; this one does not depend on it, which is what keeps the graph
 * acyclic.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailDispatcher,
  ) {}

  // --- Raising ----------------------------------------------------------------

  /**
   * Plans and records the approval an order needs, if any.
   *
   * Returns true when the order must wait. Called from inside the placement
   * transaction, so the request and the order are one write — an order that is
   * PENDING_APPROVAL with no request would be invisible to every approver.
   */
  async raiseFor(
    tx: Prisma.TransactionClient,
    order: {
      id: string;
      accountId: string;
      siteId: string;
      totalCents: number;
      placedById: string;
      requesterRole: Role;
      categoryIds: readonly string[];
    },
  ): Promise<boolean> {
    const rules = await tx.approvalRule.findMany({
      where: { accountId: order.accountId, active: true, deletedAt: null },
      orderBy: [{ tier: 'asc' }, { id: 'asc' }],
    });

    if (rules.length === 0) return false;

    const facts: OrderFacts = {
      totalCents: order.totalCents,
      siteId: order.siteId,
      requesterRole: order.requesterRole,
      requesterId: order.placedById,
      categoryIds: order.categoryIds,
    };

    const plan = planApproval(rules.map(toRuleSpec), facts);
    if (plan.length === 0) return false;

    const requestId = createId('apq');

    await tx.approvalRequest.create({
      data: {
        id: requestId,
        accountId: order.accountId,
        orderId: order.id,
        status: 'PENDING',
        currentTier: plan[0]!.tier,
        totalAtRequest: (order.totalCents / 100).toFixed(2),
      },
    });

    await tx.approvalStep.createMany({
      data: plan.map((step) => ({
        id: createId('aps'),
        requestId,
        ruleId: step.ruleId,
        tier: step.tier,
        // Copied from the rule, so retiring or editing it later cannot rewrite
        // who this step was addressed to.
        approverRole: step.approverRole,
        approverUserId: step.approverUserId,
        status: 'PENDING' as const,
      })),
    });

    this.logger.log(`Order ${order.id} needs ${plan.length} approval(s) across its tiers.`);
    return true;
  }

  // --- Deciding ---------------------------------------------------------------

  /**
   * Records one decision and moves the order if that completes a round.
   *
   * Everything happens in one transaction: the step, the request's new tier or
   * outcome, the order's status, and the entry on the order's timeline.
   */
  async decide(
    actor: AuthenticatedActor,
    stepId: string,
    dto: DecideApprovalDto,
  ): Promise<FullApprovalRequest> {
    const step = await this.requireStep(actor, stepId);
    const request = step.request;

    if (request.status !== 'PENDING') {
      throw new ConflictError('This order is no longer awaiting a decision.', {
        details: { status: request.status },
      });
    }

    assertStepOpen({ status: step.status, tier: step.tier }, request.currentTier);

    if (
      !canDecideStep(
        { approverRole: step.approverRole, approverUserId: step.approverUserId },
        { userId: actor.userId, role: actor.role },
        request.order.placedById,
      )
    ) {
      throw new ForbiddenError(
        request.order.placedById === actor.userId
          ? 'An order cannot be approved by the person who raised it.'
          : 'This approval is addressed to someone else.',
      );
    }

    const actorName = await this.actorName(actor);
    const now = new Date();

    const updated = await withTenantScope(this.prisma, request.accountId, async (tx) => {
      await tx.approvalStep.update({
        where: { id: stepId },
        data: {
          status: dto.decision,
          decidedById: actor.userId,
          decidedByName: actorName,
          decidedAt: now,
          comment: dto.comment ?? null,
        },
      });

      const steps = await tx.approvalStep.findMany({
        where: { requestId: request.id },
        select: { id: true, tier: true, status: true },
      });

      const progress = evaluateProgress(steps.map((s) => ({ tier: s.tier, status: s.status })));

      // Steps above a refusal are marked SKIPPED rather than left PENDING, so
      // they disappear from their approvers' queues instead of sitting there
      // as work nobody can ever do.
      if (progress.skipTiersAbove !== null) {
        await tx.approvalStep.updateMany({
          where: {
            requestId: request.id,
            tier: { gt: progress.skipTiersAbove },
            status: 'PENDING',
          },
          data: { status: 'SKIPPED' },
        });
      }

      await tx.approvalRequest.update({
        where: { id: request.id },
        data: {
          status: progress.outcome,
          currentTier: progress.currentTier,
          completedAt: progress.outcome === 'PENDING' ? null : now,
        },
      });

      const orderStatus = ORDER_STATUS_FOR[progress.outcome];
      if (orderStatus && orderStatus !== request.order.status) {
        await tx.order.update({
          where: { id: request.orderId },
          data: {
            status: orderStatus,
            ...(orderStatus === OrderStatus.APPROVED
              ? { approvedById: actor.userId, approvedAt: now, changeRequestNote: null }
              : {}),
            ...(orderStatus === OrderStatus.REJECTED
              ? { rejectionReason: dto.comment ?? 'Rejected in approval' }
              : {}),
            ...(orderStatus === OrderStatus.CHANGES_REQUESTED
              ? { changeRequestNote: dto.comment ?? null }
              : {}),
          },
        });

        // The order's own timeline, not just the approval's — a buyer reading
        // their order should see the decision without opening a second screen.
        await tx.orderStatusEvent.create({
          data: {
            id: createId('ose'),
            orderId: request.orderId,
            fromStatus: request.order.status,
            toStatus: orderStatus,
            actorId: actor.userId,
            actorName,
            actorRole: actor.role,
            comment: dto.comment ?? null,
          },
        });
      }

      return tx.approvalRequest.findFirstOrThrow({
        where: { id: request.id },
        include: FULL_REQUEST,
      });
    });

    await this.audit.record({
      action: AuditAction.APPROVAL_DECIDED,
      entityType: 'ORDER',
      entityId: request.orderId,
      entityName: request.order.orderNumber,
      accountId: request.accountId,
      details: {
        decision: dto.decision,
        tier: step.tier,
        comment: dto.comment ?? null,
        outcome: updated.status,
      },
    });

    // Told to the buyer only once the round has actually resolved. A two-tier
    // order that has cleared tier one is not "approved" yet, and emailing that
    // it was would be wrong twice — once now and once when tier two refuses.
    if (updated.status !== 'PENDING') {
      await this.notifyRequester(updated, dto.decision, actorName, dto.comment ?? null);
    } else {
      // Otherwise the next round's approvers need to know it has reached them.
      await this.notifyPendingApprovers(request.orderId);
    }

    this.logger.log(
      `Approval ${stepId} on order ${request.order.orderNumber}: ${dto.decision} by ${actor.userId} (request now ${updated.status}).`,
    );
    return updated;
  }

  // --- Reading ----------------------------------------------------------------

  /**
   * The approvals queue.
   *
   * `mine=true` narrows to steps this actor can actually act on right now:
   * open, at the current tier, and addressed to them by name or by role. That
   * is the query the hub screen makes, and doing it here rather than in the
   * client keeps "who may decide" in one place.
   */
  async list(
    actor: AuthenticatedActor,
    query: ListApprovalsQueryDto,
  ): Promise<OffsetPage<FullApprovalRequest>> {
    const accountId = actor.role === Role.ADMIN ? (query.accountId ?? null) : actor.accountId;

    const clauses: Prisma.ApprovalRequestWhereInput[] = [];
    if (accountId) clauses.push({ accountId });
    if (query.status) clauses.push({ status: query.status });

    if (query.mine) {
      clauses.push({
        status: 'PENDING',
        // Never your own order, whatever role you hold.
        order: { placedById: { not: actor.userId } },
        steps: {
          some: {
            status: 'PENDING',
            OR: [
              { approverUserId: actor.userId },
              ...(actor.role === Role.ADMIN
                ? [{ approverRole: { not: null } }]
                : [{ approverRole: actor.role }]),
            ],
          },
        },
      });
    }

    const where: Prisma.ApprovalRequestWhereInput = clauses.length > 0 ? { AND: clauses } : {};
    const { skip, take } = toSkipTake(query);

    const read = async (client: Prisma.TransactionClient | PrismaService) =>
      Promise.all([
        client.approvalRequest.findMany({
          where,
          include: FULL_REQUEST,
          orderBy: [{ createdAt: 'asc' }],
          skip,
          take,
        }),
        client.approvalRequest.count({ where }),
      ]);

    const [items, total] = accountId
      ? await withTenantScope(this.prisma, accountId, read)
      : await read(this.prisma);

    // The tier filter is applied after the read: it depends on each request's
    // own currentTier, which no single WHERE clause can compare a step against.
    const filtered = query.mine
      ? items.filter((request) =>
          request.steps.some(
            (step) => step.status === 'PENDING' && step.tier === request.currentTier,
          ),
        )
      : items;

    return offsetPage(filtered, query.mine ? filtered.length : total, query);
  }

  async findByOrder(actor: AuthenticatedActor, orderId: string): Promise<FullApprovalRequest> {
    const accountId = await this.accountOfOrder(actor, orderId);

    const request = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.approvalRequest.findFirst({ where: { orderId }, include: FULL_REQUEST }),
    );

    if (!request) throw new NotFoundError('Approval request');
    return request;
  }

  // --- Rules ------------------------------------------------------------------

  async listRules(actor: AuthenticatedActor, accountId?: string): Promise<ApprovalRuleRow[]> {
    const scope = actor.role === Role.ADMIN ? (accountId ?? actor.accountId) : actor.accountId;

    return withTenantScope(this.prisma, scope, (tx) =>
      tx.approvalRule.findMany({
        where: { deletedAt: null },
        include: { category: { select: { id: true, code: true, name: true } } },
        orderBy: [{ tier: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async createRule(
    actor: AuthenticatedActor,
    dto: CreateApprovalRuleDto,
  ): Promise<ApprovalRuleRow> {
    const accountId =
      actor.role === Role.ADMIN ? (dto.accountId ?? actor.accountId) : actor.accountId;
    await this.assertRuleTargetsExist(accountId, dto);

    const rule = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.approvalRule.create({
        data: {
          id: createId('apr'),
          accountId,
          name: dto.name,
          description: dto.description ?? null,
          active: dto.active,
          minTotal: dto.minTotal ?? null,
          categoryId: dto.categoryId ?? null,
          requesterRole: dto.requesterRole ?? null,
          siteId: dto.siteId ?? null,
          tier: dto.tier,
          approverRole: dto.approverRole ?? null,
          approverUserId: dto.approverUserId ?? null,
        },
        include: { category: { select: { id: true, code: true, name: true } } },
      }),
    );

    await this.audit.record({
      action: AuditAction.APPROVAL_RULE_CREATED,
      entityType: 'ACCOUNT',
      entityId: accountId,
      entityName: rule.name,
      accountId,
      details: {
        tier: rule.tier,
        minTotal: rule.minTotal?.toFixed(2) ?? null,
        categoryId: rule.categoryId,
        approverRole: rule.approverRole,
        approverUserId: rule.approverUserId,
      },
    });

    return rule;
  }

  async updateRule(
    actor: AuthenticatedActor,
    ruleId: string,
    dto: UpdateApprovalRuleDto,
  ): Promise<ApprovalRuleRow> {
    const accountId = await this.accountOfRule(actor, ruleId);

    const rule = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.approvalRule.update({
        where: { id: ruleId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.minTotal !== undefined ? { minTotal: dto.minTotal } : {}),
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.requesterRole !== undefined ? { requesterRole: dto.requesterRole } : {}),
          ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
          ...(dto.tier !== undefined ? { tier: dto.tier } : {}),
          ...(dto.approverRole !== undefined ? { approverRole: dto.approverRole } : {}),
          ...(dto.approverUserId !== undefined ? { approverUserId: dto.approverUserId } : {}),
        },
        include: { category: { select: { id: true, code: true, name: true } } },
      }),
    );

    await this.audit.record({
      action: AuditAction.APPROVAL_RULE_UPDATED,
      entityType: 'ACCOUNT',
      entityId: accountId,
      entityName: rule.name,
      accountId,
    });

    return rule;
  }

  /**
   * Soft delete.
   *
   * Requests already in flight keep their steps, because `ApprovalStep.ruleId`
   * is nullable and the approver was snapshotted onto the step. Retiring a rule
   * never strands an order that is halfway through it.
   */
  async removeRule(actor: AuthenticatedActor, ruleId: string): Promise<void> {
    const accountId = await this.accountOfRule(actor, ruleId);

    const rule = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.approvalRule.update({
        where: { id: ruleId },
        data: { active: false, deletedAt: new Date() },
      }),
    );

    await this.audit.record({
      action: AuditAction.APPROVAL_RULE_DELETED,
      entityType: 'ACCOUNT',
      entityId: accountId,
      entityName: rule.name,
      accountId,
    });
  }

  // --- Internals --------------------------------------------------------------

  /**
   * Emails whoever can act on an order's current round.
   *
   * Role steps fan out to every active holder of that role in the account —
   * that is what makes a rota work, and sending to only one of them would leave
   * an order waiting on whoever happened to be picked.
   *
   * Called from OrdersService at placement as well as from `decide()`, which is
   * why it takes an order id rather than a request: at placement the caller has
   * the order and not the request that was just raised for it.
   */
  async notifyPendingApprovers(orderId: string): Promise<void> {
    const request = await this.prisma.approvalRequest.findFirst({
      where: { orderId, status: 'PENDING' },
      include: FULL_REQUEST,
    });
    if (!request) return;

    const open = request.steps.filter(
      (step) => step.status === 'PENDING' && step.tier === request.currentTier,
    );
    if (open.length === 0) return;

    const named = open.map((step) => step.approverUserId).filter((id): id is string => id !== null);
    const roles = open.map((step) => step.approverRole).filter((role) => role !== null);

    const recipients = await withTenantScope(this.prisma, request.accountId, (tx) =>
      tx.user.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          // Never the person who raised it — they cannot decide it, so asking
          // them to would be noise they learn to ignore.
          id: { not: request.order.placedById },
          OR: [
            ...(named.length > 0 ? [{ id: { in: named } }] : []),
            ...(roles.length > 0 ? [{ role: { in: roles } }] : []),
          ],
        },
        select: { email: true, firstName: true },
      }),
    );

    for (const recipient of recipients) {
      await this.notify(() =>
        this.mail.sendApprovalPending({
          to: recipient.email,
          firstName: recipient.firstName,
          order: summariseOrder(request),
          tier: request.currentTier,
        }),
      );
    }
  }

  /** Tells the buyer what was decided, once the whole request has resolved. */
  private async notifyRequester(
    request: FullApprovalRequest,
    decision: DecideApprovalDto['decision'],
    decidedByName: string,
    comment: string | null,
  ): Promise<void> {
    const requester = await withTenantScope(this.prisma, request.accountId, (tx) =>
      tx.user.findFirst({
        where: { id: request.order.placedById },
        select: { email: true, firstName: true },
      }),
    );
    if (!requester) return;

    await this.notify(() =>
      this.mail.sendApprovalDecided({
        to: requester.email,
        firstName: requester.firstName,
        order: summariseOrder(request),
        decision,
        decidedByName,
        comment,
      }),
    );
  }

  /**
   * A notification must never fail the decision that produced it.
   *
   * The step and the order status are already committed. Failing the response
   * now would show the approver an error for work that succeeded, and they
   * would click again — deciding a step that is no longer open.
   */
  private async notify(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.error(
        `Could not queue an approval notification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async requireStep(actor: AuthenticatedActor, stepId: string) {
    const step = await this.prisma.approvalStep.findFirst({
      where: { id: stepId },
      include: { request: { include: FULL_REQUEST } },
    });

    if (!step) throw new NotFoundError('Approval');
    if (actor.role !== Role.ADMIN && step.request.accountId !== actor.accountId) {
      throw new NotFoundError('Approval');
    }
    return step;
  }

  private async accountOfOrder(actor: AuthenticatedActor, orderId: string): Promise<string> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId },
      select: { accountId: true },
    });
    if (!order) throw new NotFoundError('Order');
    if (actor.role !== Role.ADMIN && order.accountId !== actor.accountId) {
      throw new NotFoundError('Order');
    }
    return order.accountId;
  }

  private async accountOfRule(actor: AuthenticatedActor, ruleId: string): Promise<string> {
    const rule = await this.prisma.approvalRule.findFirst({
      where: { id: ruleId, deletedAt: null },
      select: { accountId: true },
    });
    if (!rule) throw new NotFoundError('Approval rule');
    if (actor.role !== Role.ADMIN && rule.accountId !== actor.accountId) {
      throw new NotFoundError('Approval rule');
    }
    return rule.accountId;
  }

  /**
   * A rule that points at a category, branch or person that does not exist
   * would match nothing, or route to nobody, and give no sign of either.
   */
  private async assertRuleTargetsExist(
    accountId: string,
    dto: CreateApprovalRuleDto,
  ): Promise<void> {
    if (dto.categoryId) {
      const category = await this.prisma.productCategory.findFirst({
        where: { id: dto.categoryId, deletedAt: null },
        select: { id: true },
      });
      if (!category) throw new NotFoundError('Category');
    }

    if (dto.siteId || dto.approverUserId) {
      await withTenantScope(this.prisma, accountId, async (tx) => {
        if (dto.siteId) {
          const site = await tx.site.findFirst({
            where: { id: dto.siteId, deletedAt: null },
            select: { id: true },
          });
          if (!site) throw new NotFoundError('Site');
        }
        if (dto.approverUserId) {
          const user = await tx.user.findFirst({
            where: { id: dto.approverUserId, deletedAt: null, status: 'ACTIVE' },
            select: { id: true },
          });
          // An approver who has left would strand every order the rule matched.
          if (!user) {
            throw new BusinessRuleError('That approver is not an active user of this account.', {
              details: { approverUserId: dto.approverUserId },
            });
          }
        }
      });
    }
  }

  private async actorName(actor: AuthenticatedActor): Promise<string> {
    const user = await this.prisma.user.findFirst({
      where: { id: actor.userId },
      select: { firstName: true, lastName: true },
    });
    return user ? `${user.firstName} ${user.lastName}`.trim() : actor.email;
  }
}

/** The order facts the notification templates repeat back to the reader. */
function summariseOrder(request: FullApprovalRequest) {
  return {
    orderId: request.order.id,
    orderNumber: request.order.orderNumber,
    total: request.order.total.toFixed(2),
    siteName: request.order.site.name,
    placedByName: request.order.placedByName,
    poNumber: request.order.poNumber,
    lineCount: request.order._count.lines,
  };
}

/** What each request outcome means for the order it is deciding on. */
const ORDER_STATUS_FOR: Readonly<Record<string, OrderStatus | null>> = {
  PENDING: null,
  APPROVED: OrderStatus.APPROVED,
  REJECTED: OrderStatus.REJECTED,
  CHANGES_REQUESTED: OrderStatus.CHANGES_REQUESTED,
  CANCELLED: null,
};

function toRuleSpec(rule: {
  id: string;
  name: string;
  tier: number;
  minTotal: Prisma.Decimal | null;
  categoryId: string | null;
  requesterRole: Role | null;
  siteId: string | null;
  approverRole: Role | null;
  approverUserId: string | null;
}): ApprovalRuleSpec {
  return {
    id: rule.id,
    name: rule.name,
    tier: rule.tier,
    minTotalCents:
      rule.minTotal == null ? null : Math.round(Number(rule.minTotal.toFixed(2)) * 100),
    categoryId: rule.categoryId,
    requesterRole: rule.requesterRole,
    siteId: rule.siteId,
    approverRole: rule.approverRole,
    approverUserId: rule.approverUserId,
  };
}
