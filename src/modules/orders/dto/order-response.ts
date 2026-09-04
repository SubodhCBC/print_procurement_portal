import type { FullOrder, OrderSummary } from '../orders.service';

/**
 * An order as the API exposes it.
 *
 * Matches the reference portal's `Order` shape, with money as strings for the
 * reason it is everywhere else in this codebase: these are NUMERIC columns and
 * a JSON number would be rounded by the client's parser.
 *
 * Every snapshotted field is returned from the snapshot, never from a join —
 * `sku`, `name`, `unitPrice` and the delivery address all come from the order's
 * own copy, so what the customer sees is what they bought.
 */
export interface OrderView {
  readonly id: string;
  readonly orderNumber: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly costCentre: string | null;
  readonly placedById: string;
  readonly placedByName: string;
  readonly placedByEmail: string;
  readonly status: FullOrder['status'];
  readonly paymentStatus: FullOrder['paymentStatus'];
  /**
   * Whether this order is holding warehouse stock, has consumed it, or has let
   * it go. The fulfilment screen needs it: an order showing APPROVED with
   * nothing reserved is one that will not ship.
   */
  readonly stockState: FullOrder['stockState'];
  readonly paymentMethod: FullOrder['paymentMethod'];
  readonly paymentReference: string | null;
  readonly paidAt: string | null;
  readonly poNumber: string | null;
  readonly campaignCode: string | null;
  readonly projectCode: string | null;
  readonly requiresApproval: boolean;
  readonly approvedById: string | null;
  readonly approvedAt: string | null;
  readonly rejectionReason: string | null;
  readonly changeRequestNote: string | null;
  readonly subtotal: string;
  /** The same order at catalogue prices, for the "you saved" figure. */
  readonly catalogSubtotal: string;
  readonly saving: string;
  readonly total: string;
  readonly rateCardId: string | null;
  readonly rateCardName: string | null;
  readonly billingPeriod: string;
  readonly itemCount: number;
  readonly lineCount: number;
  readonly shippingAddressId: string | null;
  /** What actually shipped, frozen at placement. */
  readonly shippingAddress: unknown;
  readonly recipientName: string | null;
  readonly recipientPhone: string | null;
  readonly recipientEmail: string | null;
  readonly requestedDeliveryDate: string | null;
  readonly carrier: string | null;
  readonly trackingNumber: string | null;
  readonly deliveryNotes: string | null;
  readonly dispatchedAt: string | null;
  readonly deliveredAt: string | null;
  readonly cancelledAt: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Present only on the single-order read. */
  readonly lines?: readonly OrderLineView[];
  readonly history?: readonly OrderEventView[];
}

export interface OrderLineView {
  readonly id: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly sku: string;
  readonly name: string;
  readonly variantSku: string | null;
  readonly uom: FullOrder['lines'][number]['uom'];
  readonly packSize: number;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly catalogUnitPrice: string;
  readonly discountPercent: string;
  /** Which pricing rule produced the unit price. */
  readonly priceSource: string;
  /**
   * The artwork this line was personalised from, when it was.
   *
   * Null for a line with no template — a box of envelopes. Present, it is what
   * lets an operator reconstruct what to print: the version is immutable, so
   * `templateVersion.version` names artwork that cannot have moved since the
   * order was placed.
   */
  readonly template: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly status: string;
    readonly versionId: string;
    readonly version: number;
    readonly versionLabel: string | null;
    readonly publishedAt: string;
  } | null;
  readonly customisation: unknown;
  readonly notes: string | null;
}

export interface OrderEventView {
  readonly fromStatus: FullOrder['status'] | null;
  readonly toStatus: FullOrder['status'];
  readonly actorId: string | null;
  readonly actorName: string;
  readonly actorRole: FullOrder['history'][number]['actorRole'];
  readonly comment: string | null;
  readonly at: string;
}

export function toOrderView(order: FullOrder | OrderSummary): OrderView {
  const detailed = 'lines' in order ? order : null;
  const lineCount = detailed ? detailed.lines.length : (order as OrderSummary)._count.lines;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    accountId: order.accountId,
    accountName: order.account.name,
    siteId: order.siteId,
    siteCode: order.site.code,
    siteName: order.site.name,
    costCentre: order.site.costCentre,
    placedById: order.placedById,
    placedByName: order.placedByName,
    placedByEmail: order.placedByEmail,
    status: order.status,
    paymentStatus: order.paymentStatus,
    stockState: order.stockState,
    paymentMethod: order.paymentMethod,
    paymentReference: order.paymentReference,
    paidAt: order.paidAt?.toISOString() ?? null,
    poNumber: order.poNumber,
    campaignCode: order.campaignCode,
    projectCode: order.projectCode,
    requiresApproval: order.requiresApproval,
    approvedById: order.approvedById,
    approvedAt: order.approvedAt?.toISOString() ?? null,
    rejectionReason: order.rejectionReason,
    changeRequestNote: order.changeRequestNote,
    subtotal: order.subtotal.toFixed(2),
    catalogSubtotal: order.catalogSubtotal.toFixed(2),
    saving: order.catalogSubtotal.minus(order.subtotal).toFixed(2),
    total: order.total.toFixed(2),
    rateCardId: order.rateCardId,
    rateCardName: order.rateCardName,
    billingPeriod: order.billingPeriod,
    itemCount: detailed ? detailed.lines.reduce((sum, line) => sum + line.quantity, 0) : lineCount,
    lineCount,
    shippingAddressId: order.shippingAddressId,
    shippingAddress: order.shippingSnapshot,
    recipientName: order.recipientName,
    recipientPhone: order.recipientPhone,
    recipientEmail: order.recipientEmail,
    requestedDeliveryDate: order.requestedDeliveryDate?.toISOString() ?? null,
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    deliveryNotes: order.deliveryNotes,
    dispatchedAt: order.dispatchedAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    notes: order.notes,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    ...(detailed
      ? {
          lines: detailed.lines.map(toOrderLineView),
          history: detailed.history.map(toOrderEventView),
        }
      : {}),
  };
}

function toOrderLineView(line: FullOrder['lines'][number]): OrderLineView {
  return {
    id: line.id,
    productId: line.productId,
    variantId: line.variantId,
    sku: line.sku,
    name: line.name,
    variantSku: line.variantSku,
    uom: line.uom,
    packSize: line.packSize,
    quantity: line.quantity,
    unitPrice: line.unitPrice.toFixed(2),
    lineTotal: line.lineTotal.toFixed(2),
    catalogUnitPrice: line.catalogUnitPrice.toFixed(2),
    discountPercent: line.discountPercent.toFixed(2),
    priceSource: line.priceSource,
    template:
      line.template && line.templateVersion
        ? {
            id: line.template.id,
            code: line.template.code,
            name: line.template.name,
            status: line.template.status,
            versionId: line.templateVersion.id,
            version: line.templateVersion.version,
            versionLabel: line.templateVersion.label,
            publishedAt: line.templateVersion.createdAt.toISOString(),
          }
        : null,
    customisation: line.customisation ?? null,
    notes: line.notes,
  };
}

function toOrderEventView(event: FullOrder['history'][number]): OrderEventView {
  return {
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actorId: event.actorId,
    actorName: event.actorName,
    actorRole: event.actorRole,
    comment: event.comment,
    at: event.createdAt.toISOString(),
  };
}
