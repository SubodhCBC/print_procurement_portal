import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BusinessRuleError,
  createId,
  ForbiddenError,
  NotFoundError,
  offsetPage,
  Permission,
  Role,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import { PermissionService } from '@/modules/authorization';
import { ApprovalsService } from '@/modules/approvals';
import { StockService } from '@/modules/catalog';
import { CartService, type CartValidation } from '@/modules/cart';
import { MailDispatcher, type OrderSummaryInput } from '@/shared/mailer';
import type {
  ChangeOrderStatusDto,
  ListOrdersQueryDto,
  PlaceOrderDto,
  RecordPaymentDto,
} from './dto/order.dto';
import {
  assertTransition,
  AWAITING_APPROVAL_STATUSES,
  OrderStatus,
  requiresApproval,
} from './order-status';

const FULL_ORDER = Prisma.validator<Prisma.OrderInclude>()({
  site: { select: { id: true, code: true, name: true, costCentre: true } },
  account: { select: { id: true, accountCode: true, name: true } },
  lines: {
    orderBy: { createdAt: 'asc' },
    // The artwork behind a personalised line, joined rather than left as an id.
    // Whoever fulfils this order needs to know *which* template and *which*
    // version — an id alone would send them back to the database, and the
    // version's own name is what makes "Opening Hours A2 v2" readable on a
    // packing sheet.
    include: {
      template: { select: { id: true, code: true, name: true, status: true } },
      templateVersion: { select: { id: true, version: true, label: true, createdAt: true } },
    },
  },
  history: { orderBy: { createdAt: 'asc' } },
});

export type FullOrder = Prisma.OrderGetPayload<{ include: typeof FULL_ORDER }>;

/** The list view: no lines, no history. */
const ORDER_SUMMARY = Prisma.validator<Prisma.OrderInclude>()({
  site: { select: { id: true, code: true, name: true, costCentre: true } },
  account: { select: { id: true, accountCode: true, name: true } },
  _count: { select: { lines: true } },
});

export type OrderSummary = Prisma.OrderGetPayload<{ include: typeof ORDER_SUMMARY }>;

/**
 * Orders (SOW BE-06).
 *
 * ---------------------------------------------------------------------------
 * Placement is one transaction
 * ---------------------------------------------------------------------------
 * Allocating the number, writing the order and its lines, recording the first
 * status event and closing the basket all commit together or not at all. Split
 * across two writes, a failure between them leaves either a basket the customer
 * has already been charged for or an order with no lines — and both are
 * discovered by a person rather than by a monitor.
 *
 * ---------------------------------------------------------------------------
 * Everything is snapshotted
 * ---------------------------------------------------------------------------
 * The cart stores no prices because a rate card can move. An order is the
 * opposite: at placement every number stops moving. Line items carry their own
 * price, the discount that produced it and the rule it came from; the delivery
 * address is copied as JSON as well as referenced; the buyer's name and email
 * are copied too. Re-pricing or re-addressing a historical order is impossible
 * by construction.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly cart: CartService,
    private readonly approvals: ApprovalsService,
    private readonly mail: MailDispatcher,
    private readonly stock: StockService,
  ) {}

  // --- Placing ----------------------------------------------------------------

  /**
   * Turns a validated basket into an order.
   *
   * The validation is the cart's — `checkoutSession()` refuses anything that is
   * not ready — and it is re-run here rather than trusted from an earlier call,
   * because a product can be unpublished, a rate card can expire and a budget
   * can be consumed by a colleague between the buyer seeing the review step and
   * pressing submit. The check that matters is the last one.
   */
  async place(actor: AuthenticatedActor, dto: PlaceOrderDto): Promise<FullOrder> {
    const session = await this.cart.checkoutSession(actor, dto.siteId);
    const { cart } = session;

    if (!cart.siteId) {
      // checkoutSession already refuses this; restated because the rest of this
      // method treats the branch as present and a future change to that
      // validation must not silently produce an unbranched order.
      throw new BusinessRuleError('Choose which branch this order is for.');
    }

    // Captured once, after the guard. TypeScript loses the narrowing across the
    // transaction closure below, and `cart.siteId!` inside it would be an
    // assertion that nothing re-checks if that guard ever moves.
    const siteId = cart.siteId;

    const [account, buyer] = await withTenantScope(this.prisma, actor.accountId, (tx) =>
      Promise.all([
        tx.account.findFirstOrThrow({
          where: { id: actor.accountId },
          select: { approvalThreshold: true },
        }),
        tx.user.findFirstOrThrow({
          where: { id: actor.userId },
          select: { firstName: true, lastName: true, email: true },
        }),
      ]),
    );

    const thresholdCents =
      account.approvalThreshold == null ? null : toCents(account.approvalThreshold);

    const orderId = createId('ord');
    const buyerName = `${buyer.firstName} ${buyer.lastName}`.trim();

    const order = await withTenantScope(this.prisma, actor.accountId, async (tx) => {
      // Allocated inside the transaction but from a sequence, so it does not
      // roll back with it. Gaps are accepted — see the migration.
      const [{ next_order_number: orderNumber }] = await tx.$queryRaw<
        [{ next_order_number: string }]
      >`SELECT next_order_number()`;

      await tx.order.create({
        data: {
          id: orderId,
          orderNumber,
          accountId: actor.accountId,
          siteId,
          placedById: actor.userId,
          placedByName: buyerName,
          placedByEmail: buyer.email,
          cartId: cart.id,
          // Written APPROVED and corrected below if approval turns out to be
          // needed. Both happen in the same transaction, so no reader ever
          // sees the intermediate state — and this way the approval engine
          // reads the order's own rows rather than being handed a second copy
          // of them to keep in step.
          status: OrderStatus.APPROVED,
          paymentMethod: cart.paymentMethod,
          poNumber: session.purchaseOrder.provided,
          campaignCode: cart.campaignCode,
          projectCode: dto.projectCode ?? null,
          requiresApproval: false,
          subtotal: fromCents(session.subtotalCents),
          catalogSubtotal: fromCents(session.catalogSubtotalCents),
          // No tax column yet — see the migration. `total` is the subtotal
          // today, and BE-09 adds tax with the invoice engine rather than this
          // carrying a zero that downstream code starts trusting.
          total: fromCents(session.subtotalCents),
          rateCardId: session.lines[0]?.quote?.breakdown.rateCardId ?? null,
          rateCardName: session.lines[0]?.quote?.breakdown.rateCardName ?? null,
          billingPeriod: session.billingPeriod,
          shippingAddressId: cart.shippingAddressId,
          shippingSnapshot: addressSnapshot(cart.shippingAddress),
          recipientName: dto.recipientName ?? null,
          recipientPhone: dto.recipientPhone ?? null,
          recipientEmail: dto.recipientEmail ?? null,
          requestedDeliveryDate: cart.requestedDeliveryDate,
          notes: cart.notes,
          termsAcceptedAt: cart.termsAcceptedAt,
        },
      });

      await tx.orderLineItem.createMany({
        data: session.lines.map((line) => {
          const breakdown = line.quote?.breakdown;
          if (!breakdown) {
            // Unreachable: checkoutSession refuses a basket with an unpriceable
            // line. Stated because an order line with no price is the one thing
            // that must never reach the database.
            throw new BusinessRuleError('A line in this basket could not be priced.', {
              details: { sku: line.line.product.sku },
            });
          }

          return {
            id: createId('oli'),
            orderId,
            productId: line.line.productId,
            variantId: line.line.variantId,
            sku: line.line.product.sku,
            name: line.line.product.name,
            variantSku: line.line.variant?.sku ?? null,
            uom: line.line.product.uom,
            packSize: line.line.product.packSize,
            quantity: line.check.orderableQuantity,
            unitPrice: fromCents(breakdown.unitPriceCents),
            lineTotal: fromCents(breakdown.lineTotalCents),
            catalogUnitPrice: fromCents(breakdown.catalogUnitPriceCents),
            discountPercent: breakdown.discountPercent.toFixed(2),
            priceSource: breakdown.source,
            // Carried across with the values, and the reason they mean
            // anything: a version is immutable, so a reference to it is as good
            // as a copy of the artwork and costs nothing. Without it an
            // operator reading this order months later has the answers and not
            // the question.
            templateId: line.line.templateId,
            templateVersionId: line.line.templateVersionId,
            customisation: line.line.customisation ?? Prisma.DbNull,
            notes: line.line.notes,
          };
        }),
      });

      // Reserved inside the placement transaction, before anything else can
      // read the order. A reservation left behind by an order that failed to
      // save is inventory nobody can buy and nobody knows to release; a
      // reservation taken after the commit is a window in which two buyers can
      // both be promised the last unit.
      //
      // Reserved even while the order is only PENDING_APPROVAL. The alternative
      // — waiting for approval — means an order can clear its approvers and
      // then turn out to be unfillable, which is the worst moment to find out.
      const reserved = await this.stock.reserve(
        tx,
        session.lines.map((line) => ({
          productId: line.line.productId,
          variantId: line.line.variantId,
          quantity: line.check.orderableQuantity,
          sku: line.line.product.sku,
        })),
      );

      if (reserved) {
        await tx.order.update({
          where: { id: orderId },
          data: { stockState: 'RESERVED' },
        });
      }

      // Configurable rules first (BE-07). They supersede the account
      // threshold entirely: once an account has any, the simple number is
      // not consulted, so the two can never disagree about the same order.
      const categoryIds = await tx.product
        .findMany({
          where: { id: { in: session.lines.map((line) => line.line.productId) } },
          select: { categoryId: true },
        })
        .then((rows) => [...new Set(rows.map((row) => row.categoryId))]);

      const routed = await this.approvals.raiseFor(tx, {
        id: orderId,
        accountId: actor.accountId,
        siteId,
        totalCents: session.subtotalCents,
        placedById: actor.userId,
        requesterRole: actor.role,
        categoryIds,
      });

      const needsApproval =
        routed ||
        (!(await this.accountHasRules(tx, actor.accountId)) &&
          requiresApproval(session.subtotalCents, thresholdCents));

      const initialStatus = needsApproval ? OrderStatus.PENDING_APPROVAL : OrderStatus.APPROVED;

      if (needsApproval) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: initialStatus, requiresApproval: true },
        });
      }

      await tx.orderStatusEvent.create({
        data: {
          id: createId('ose'),
          orderId,
          fromStatus: null,
          toStatus: initialStatus,
          actorId: actor.userId,
          actorName: buyerName,
          actorRole: actor.role,
          comment: needsApproval
            ? routed
              ? 'Submitted for approval'
              : 'Submitted for approval (over the account threshold)'
            : 'Placed and approved automatically',
        },
      });

      // The basket becomes history rather than being deleted, so the buyer can
      // see what they submitted and support can trace a question back to it.
      await tx.cart.update({
        where: { id: cart.id },
        data: { status: 'CHECKED_OUT', checkedOutAt: new Date() },
      });

      return tx.order.findFirstOrThrow({ where: { id: orderId }, include: FULL_ORDER });
    });

    await this.audit.record({
      action: AuditAction.ORDER_PLACED,
      entityType: 'ORDER',
      entityId: order.id,
      entityName: order.orderNumber,
      accountId: actor.accountId,
      details: {
        siteId: order.siteId,
        total: order.total.toFixed(2),
        lineCount: order.lines.length,
        requiresApproval: order.requiresApproval,
        poNumber: order.poNumber,
      },
    });

    // After the commit and after the audit entry, never inside the
    // transaction: a message announcing an order that then failed to save is
    // not retractable, and the queue's own retry is what makes delivery
    // reliable rather than the database's.
    await this.notify(() =>
      this.mail.sendOrderPlaced({
        to: buyer.email,
        firstName: buyer.firstName,
        order: summarise(order),
        awaitingApproval: order.status === OrderStatus.PENDING_APPROVAL,
      }),
    );

    if (order.status === OrderStatus.PENDING_APPROVAL) {
      await this.approvals.notifyPendingApprovers(order.id);
    }

    this.logger.log(
      `Order ${order.orderNumber} placed by ${actor.userId} (${order.lines.length} lines, ${order.status}).`,
    );
    return order;
  }

  // --- Reading ----------------------------------------------------------------

  async list(
    actor: AuthenticatedActor,
    query: ListOrdersQueryDto,
  ): Promise<OffsetPage<OrderSummary>> {
    const accountId = actor.role === Role.ADMIN ? (query.accountId ?? null) : actor.accountId;

    const clauses: Prisma.OrderWhereInput[] = [await this.visibilityFilter(actor)];

    if (accountId) clauses.push({ accountId });
    if (query.status) clauses.push({ status: query.status });
    if (query.siteId) clauses.push({ siteId: query.siteId });
    if (query.billingPeriod) clauses.push({ billingPeriod: query.billingPeriod });
    if (query.awaitingApproval) clauses.push({ status: { in: [...AWAITING_APPROVAL_STATUSES] } });
    if (query.from || query.to) {
      clauses.push({
        createdAt: {
          ...(query.from ? { gte: query.from } : {}),
          ...(query.to ? { lte: query.to } : {}),
        },
      });
    }
    if (query.search) {
      clauses.push({
        OR: [
          { orderNumber: { contains: query.search, mode: 'insensitive' } },
          { poNumber: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.OrderWhereInput = { AND: clauses };
    const { skip, take } = toSkipTake(query);

    const read = async (client: Prisma.TransactionClient | PrismaService) =>
      Promise.all([
        client.order.findMany({
          where,
          include: ORDER_SUMMARY,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take,
        }),
        client.order.count({ where }),
      ]);

    const [items, total] = accountId
      ? await withTenantScope(this.prisma, accountId, read)
      : await read(this.prisma);

    return offsetPage(items, total, query);
  }

  async findById(actor: AuthenticatedActor, orderId: string): Promise<FullOrder> {
    const accountId = await this.requireReadableAccount(actor, orderId);

    const order = await withTenantScope(this.prisma, accountId, async (tx) =>
      tx.order.findFirst({
        where: { AND: [{ id: orderId }, await this.visibilityFilter(actor)] },
        include: FULL_ORDER,
      }),
    );

    // 404, not 403: telling a buyer that an order exists but is a colleague's
    // leaks what other branches are spending on.
    if (!order) throw new NotFoundError('Order');
    return order;
  }

  // --- Lifecycle --------------------------------------------------------------

  async changeStatus(
    actor: AuthenticatedActor,
    orderId: string,
    dto: ChangeOrderStatusDto,
  ): Promise<FullOrder> {
    const before = await this.findById(actor, orderId);
    const from = before.status;
    const to = dto.status;

    assertTransition(from, to);
    await this.assertMayMakeTransition(actor, before, to);

    const now = new Date();
    const actorName = await this.actorName(actor);

    const order = await withTenantScope(this.prisma, before.accountId, async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: to,
          ...(to === OrderStatus.APPROVED
            ? { approvedById: actor.userId, approvedAt: now, changeRequestNote: null }
            : {}),
          ...(to === OrderStatus.REJECTED ? { rejectionReason: dto.reason ?? null } : {}),
          ...(to === OrderStatus.CHANGES_REQUESTED
            ? { changeRequestNote: dto.reason ?? null }
            : {}),
          ...(to === OrderStatus.DISPATCHED
            ? {
                dispatchedAt: now,
                ...(dto.carrier ? { carrier: dto.carrier } : {}),
                ...(dto.trackingNumber ? { trackingNumber: dto.trackingNumber } : {}),
              }
            : {}),
          ...(to === OrderStatus.DELIVERED ? { deliveredAt: now } : {}),
          ...(to === OrderStatus.CANCELLED ? { cancelledAt: now } : {}),
        },
      });

      // The shelf moves in the same transaction as the status. A dispatched
      // order whose stock was not consumed would be counted twice for as long
      // as it took anyone to notice.
      if (before.stockState === 'RESERVED') {
        if (to === OrderStatus.DISPATCHED) {
          await this.stock.consume(tx, stockLines(before));
          await tx.order.update({ where: { id: orderId }, data: { stockState: 'CONSUMED' } });
        } else if (to === OrderStatus.REJECTED || to === OrderStatus.CANCELLED) {
          await this.stock.release(tx, stockLines(before));
          await tx.order.update({ where: { id: orderId }, data: { stockState: 'RELEASED' } });
        }
      }

      await tx.orderStatusEvent.create({
        data: {
          id: createId('ose'),
          orderId,
          fromStatus: from,
          toStatus: to,
          actorId: actor.userId,
          actorName,
          actorRole: actor.role,
          comment: dto.reason ?? null,
        },
      });

      return tx.order.findFirstOrThrow({ where: { id: orderId }, include: FULL_ORDER });
    });

    await this.audit.record({
      action: AuditAction.ORDER_STATUS_CHANGED,
      entityType: 'ORDER',
      entityId: orderId,
      entityName: order.orderNumber,
      accountId: order.accountId,
      details: { from, to, reason: dto.reason ?? null },
    });

    if (to === OrderStatus.DISPATCHED) {
      await this.notify(() =>
        this.mail.sendOrderDispatched({
          to: order.placedByEmail,
          firstName: order.placedByName.split(' ')[0] ?? order.placedByName,
          order: summarise(order),
          carrier: order.carrier,
          trackingNumber: order.trackingNumber,
        }),
      );
    }

    this.logger.log(`Order ${order.orderNumber}: ${from} -> ${to} by ${actor.userId}.`);
    return order;
  }

  /**
   * Payment moves on its own axis, so it has its own endpoint.
   *
   * Recording a payment never touches `status`: an order can be DELIVERED and
   * UNPAID on Net 30 terms, and PAID while still PROCESSING on a P-Card.
   */
  async recordPayment(
    actor: AuthenticatedActor,
    orderId: string,
    dto: RecordPaymentDto,
  ): Promise<FullOrder> {
    const before = await this.findById(actor, orderId);

    if (!(await this.permissions.can(actor, Permission.BILLING_MANAGE))) {
      throw new ForbiddenError('Recording a payment needs BILLING_MANAGE.');
    }

    const order = await withTenantScope(this.prisma, before.accountId, (tx) =>
      tx.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: dto.paymentStatus,
          paymentReference: dto.paymentReference ?? null,
          paidAt: dto.paymentStatus === 'PAID' ? new Date() : null,
        },
        include: FULL_ORDER,
      }),
    );

    await this.audit.record({
      action: AuditAction.ORDER_PAYMENT_RECORDED,
      entityType: 'ORDER',
      entityId: orderId,
      entityName: order.orderNumber,
      accountId: order.accountId,
      details: {
        from: before.paymentStatus,
        to: dto.paymentStatus,
        reference: dto.paymentReference ?? null,
      },
    });

    return order;
  }

  // --- Internals --------------------------------------------------------------

  /**
   * Which orders this actor may see.
   *
   * Three permissions, widest wins: ORDER_VIEW_ACCOUNT sees the whole tenant,
   * ORDER_VIEW_SITE sees their branch and any branch they have been granted,
   * ORDER_VIEW_OWN sees only what they placed. An actor with none of them sees
   * nothing rather than everything — the filter fails closed.
   *
   * This is the boundary RLS cannot draw: the tenant scope carries an account,
   * not a user, so "my orders" has to be decided here. It is one function for
   * the same reason the catalogue's visibility is.
   */
  private async visibilityFilter(actor: AuthenticatedActor): Promise<Prisma.OrderWhereInput> {
    if (actor.role === Role.ADMIN) return {};

    const effective = await this.permissions.resolve(actor);

    if (effective.has(Permission.ORDER_VIEW_ACCOUNT)) return {};

    if (effective.has(Permission.ORDER_VIEW_SITE)) {
      const extraSites = await withTenantScope(this.prisma, actor.accountId, (tx) =>
        tx.userSiteAccess.findMany({ where: { userId: actor.userId }, select: { siteId: true } }),
      );
      const siteIds = [
        ...new Set([...(actor.siteId ? [actor.siteId] : []), ...extraSites.map((s) => s.siteId)]),
      ];

      // A site user with no branch at all would otherwise match every order.
      return siteIds.length > 0
        ? { OR: [{ siteId: { in: siteIds } }, { placedById: actor.userId }] }
        : { placedById: actor.userId };
    }

    if (effective.has(Permission.ORDER_VIEW_OWN)) return { placedById: actor.userId };

    // Fail closed. An impossible id rather than `{}`, so a caller that forgets
    // to check the permission gets an empty page and not the whole tenant.
    return { id: '__no_orders_visible__' };
  }

  /**
   * Reads the order outside any scope, only to learn which account owns it.
   *
   * Deliberately narrow — never the money — because this is the one read here
   * that RLS does not cover, and it exists to decide which scope to open next.
   */
  private async requireReadableAccount(
    actor: AuthenticatedActor,
    orderId: string,
  ): Promise<string> {
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

  /**
   * Who may make a particular move.
   *
   * The state machine says what is *possible*; this says who is *allowed*.
   * Approval decisions need APPROVAL_ACT, fulfilment moves need ORDER_MANAGE,
   * and a buyer may cancel their own order — which is the one transition a
   * customer can make without either.
   */
  private async assertMayMakeTransition(
    actor: AuthenticatedActor,
    order: FullOrder,
    to: OrderStatus,
  ): Promise<void> {
    const effective = await this.permissions.resolve(actor);

    const isApprovalDecision =
      to === OrderStatus.APPROVED ||
      to === OrderStatus.REJECTED ||
      to === OrderStatus.CHANGES_REQUESTED;

    if (isApprovalDecision) {
      if (!effective.has(Permission.APPROVAL_ACT)) {
        throw new ForbiddenError('Deciding on an order needs APPROVAL_ACT.');
      }
      // An approver approving their own order defeats the control the threshold
      // exists to impose. BE-07 adds the routing that makes this rare; the rule
      // belongs here because it must hold whatever routing decides.
      if (order.placedById === actor.userId && actor.role !== Role.ADMIN) {
        throw new ForbiddenError('An order cannot be approved by the person who placed it.');
      }
      return;
    }

    // Resubmitting after an approver asked for changes is the buyer's move, not
    // the operator's. Without this a CHANGES_REQUESTED order is stuck forever:
    // the one person who has to act on it is the one person with no permission
    // to, and the only way out would be to cancel and re-key the whole basket.
    if (to === OrderStatus.PENDING_APPROVAL) {
      if (order.placedById === actor.userId || effective.has(Permission.ORDER_CREATE)) return;
      throw new ForbiddenError('Submitting an order for approval needs ORDER_CREATE.');
    }

    if (to === OrderStatus.CANCELLED) {
      const ownOrder = order.placedById === actor.userId;
      if (ownOrder || effective.has(Permission.ORDER_CANCEL)) return;
      throw new ForbiddenError("Cancelling someone else's order needs ORDER_CANCEL.");
    }

    // PROCESSING, DISPATCHED, DELIVERED — the fulfilment side, which is the
    // platform operator's and later the integrations'.
    if (!effective.has(Permission.ORDER_MANAGE)) {
      throw new ForbiddenError(`Moving an order to ${to} needs ORDER_MANAGE.`);
    }
  }

  /**
   * Whether the account routes approvals by rule.
   *
   * When it does, `Account.approvalThreshold` is ignored entirely.
   * Consulting both would let a customer configure rules that say one thing
   * and a threshold that says another, with no way to tell afterwards which
   * had applied to a given order.
   */
  private async accountHasRules(tx: Prisma.TransactionClient, accountId: string): Promise<boolean> {
    const count = await tx.approvalRule.count({
      where: { accountId, active: true, deletedAt: null },
    });
    return count > 0;
  }

  /**
   * Sends a notification without letting it fail the request.
   *
   * The order is already committed by the time any of these run. Failing the
   * HTTP response now would tell the buyer their order did not go through when
   * it did — and they would place it again. A queue that is briefly unreachable
   * costs a missing email; a retried order costs a duplicate print run.
   */
  private async notify(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.error(
        `Could not queue an order notification: ${error instanceof Error ? error.message : String(error)}`,
      );
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

/**
 * The delivery address, frozen.
 *
 * An address the customer later corrects must not rewrite where a past order
 * went — the row is referenced for the UI to link to, this copy is what
 * shipped.
 */
function addressSnapshot(
  address: CartValidation['cart']['shippingAddress'],
): Prisma.InputJsonValue {
  if (!address) return {};
  return {
    label: address.label,
    recipientName: address.recipientName,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postcode: address.postcode,
    country: address.country,
    phone: address.phone,
  };
}

/** An order's lines in the shape StockService works in. */
function stockLines(order: FullOrder) {
  return order.lines.map((line) => ({
    productId: line.productId,
    variantId: line.variantId,
    quantity: line.quantity,
    sku: line.sku,
  }));
}

/** The order facts every notification repeats back to its reader. */
function summarise(order: FullOrder): OrderSummaryInput {
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    total: order.total.toFixed(2),
    siteName: order.site.name,
    placedByName: order.placedByName,
    poNumber: order.poNumber,
    lineCount: order.lines.length,
  };
}

function toCents(value: { toFixed(digits: number): string }): number {
  return Math.round(Number(value.toFixed(2)) * 100);
}

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
