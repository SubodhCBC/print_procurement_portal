import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor, type OffsetPage } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { OrdersService } from './orders.service';
import {
  ChangeOrderStatusSchema,
  ListOrdersQuerySchema,
  PlaceOrderSchema,
  RecordPaymentSchema,
  type ChangeOrderStatusDto,
  type ListOrdersQueryDto,
  type PlaceOrderDto,
  type RecordPaymentDto,
} from './dto/order.dto';
import { toOrderView, type OrderView } from './dto/order-response';

/**
 * Orders (SOW BE-06).
 *
 * Reads are gated by `ORDER_VIEW_OWN`, which every ordering role holds; *which*
 * orders come back is decided by the widest view permission the actor has —
 * own, site or account — inside the service. Putting the narrowest permission
 * on the route and the widening inside is deliberate: a single decorator cannot
 * express "any of these three", and a route guarded by the widest would lock
 * out the site users who legitimately see their own orders.
 */
@ApiTags('orders')
@ApiBearerAuth('access-token')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @RequirePermissions(Permission.ORDER_CREATE)
  @ApiOperation({
    summary: 'Place the basket as an order',
    description:
      'Re-runs the full checkout validation and refuses with 422 if anything has changed since ' +
      'the review step — a product unpublished, a rate card expired, a colleague consuming the ' +
      "branch's budget. The check that matters is the last one.\n\n" +
      'Allocating the number, writing the order and its lines, recording the first status event ' +
      'and closing the basket all commit together or not at all.\n\n' +
      'Lands as PENDING_APPROVAL when the total is above the account threshold, APPROVED when ' +
      'it is not. An order exactly on the threshold is within it.',
  })
  @ApiZodBody(PlaceOrderSchema, {
    example: {
      recipientName: 'Store Manager',
      recipientPhone: '+61 3 9000 0000',
      projectCode: 'CAPEX-2026-04',
    },
  })
  async place(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(PlaceOrderSchema)) body: PlaceOrderDto,
  ): Promise<OrderView> {
    return toOrderView(await this.orders.place(actor, body));
  }

  @Get()
  @RequirePermissions(Permission.ORDER_VIEW_OWN)
  @ApiOperation({
    summary: 'Order history',
    description:
      "Scoped to what the caller may see: their own orders, their branches', or the whole " +
      'account. `awaitingApproval=true` is the approvals queue. `billingPeriod` takes a ' +
      '`YYYY-MM` and is the same key the monthly invoice aggregates by.',
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListOrdersQuerySchema)) query: ListOrdersQueryDto,
  ): Promise<OffsetPage<OrderView>> {
    const page = await this.orders.list(actor, query);
    return { ...page, items: page.items.map(toOrderView) };
  }

  @Get(':orderId')
  @RequirePermissions(Permission.ORDER_VIEW_OWN)
  @ApiOperation({
    summary: 'One order, with its lines and timeline',
    description:
      'An order the caller may not see is reported as missing rather than forbidden: telling a ' +
      "buyer an order exists but is a colleague's leaks what other branches are spending.\n\n" +
      "Every price, name and address comes from the order's own snapshot, not from a join, so " +
      'a product renamed or repriced since cannot alter what this says.',
  })
  async findOne(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('orderId') orderId: string,
  ): Promise<OrderView> {
    return toOrderView(await this.orders.findById(actor, orderId));
  }

  @Post(':orderId/status')
  @RequirePermissions(Permission.ORDER_VIEW_OWN)
  @ApiOperation({
    summary: 'Move an order through its lifecycle',
    description:
      'The state machine says what is possible; permissions say who may do it. Approval ' +
      'decisions need APPROVAL_ACT and cannot be made by whoever placed the order. Fulfilment ' +
      'moves need ORDER_MANAGE. A buyer may always cancel their own order, up until it is ' +
      'dispatched — after that it is a returns process, not a status change.\n\n' +
      'A rejection must carry a reason, and so must a change request.',
  })
  @ApiZodBody(ChangeOrderStatusSchema, {
    example: { status: 'DISPATCHED', carrier: 'StarTrack', trackingNumber: 'ST123456789' },
  })
  async changeStatus(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('orderId') orderId: string,
    @Body(zodBody(ChangeOrderStatusSchema)) body: ChangeOrderStatusDto,
  ): Promise<OrderView> {
    return toOrderView(await this.orders.changeStatus(actor, orderId, body));
  }

  @Post(':orderId/payment')
  @RequirePermissions(Permission.BILLING_VIEW)
  @ApiOperation({
    summary: 'Record a payment',
    description:
      'Payment is a separate axis from fulfilment and never touches `status`: on Net 30 terms ' +
      'an order is routinely delivered a month before it is paid, and on a P-Card it is paid ' +
      'while still in production.\n\n' +
      'Needs BILLING_MANAGE, which is checked in the service — BILLING_VIEW on the route only ' +
      'keeps customers who cannot see billing at all off the endpoint.',
  })
  @ApiZodBody(RecordPaymentSchema, {
    example: { paymentStatus: 'PAID', paymentReference: 'EFT-2026-00841' },
  })
  async recordPayment(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('orderId') orderId: string,
    @Body(zodBody(RecordPaymentSchema)) body: RecordPaymentDto,
  ): Promise<OrderView> {
    return toOrderView(await this.orders.recordPayment(actor, orderId, body));
  }
}
