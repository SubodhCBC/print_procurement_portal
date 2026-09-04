import type { CartIssue } from '../cart-validation';
import type { CartLineRow, CartValidation, FullCart, ValidatedLine } from '../cart.service';
import type { PurchaseOrderCheck } from '../purchase-order';

/**
 * A basket as the API exposes it.
 *
 * Money is a string throughout, as everywhere else in this codebase: these are
 * NUMERIC columns and integer-cent arithmetic, and a JSON number would be
 * rounded by the client's parser.
 *
 * Line prices are present on the *validated* view and absent from the plain
 * cart view. That is deliberate: a price only means something once the line has
 * been checked and re-priced, and returning one on a bare read would invite the
 * client to cache a number that had not been through the rate card.
 */
export interface CartView {
  readonly id: string;
  readonly status: FullCart['status'];
  readonly site: CartSiteView | null;
  readonly lines: readonly CartLineView[];
  readonly lineCount: number;
  /** Sum of quantities as typed, before any MOQ rounding. */
  readonly itemCount: number;
  readonly poNumber: string | null;
  readonly campaignCode: string | null;
  readonly notes: string | null;
  readonly requestedDeliveryDate: string | null;
  readonly shippingAddressId: string | null;
  readonly billingAddressId: string | null;
  readonly paymentMethod: FullCart['paymentMethod'];
  readonly termsAcceptedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CartSiteView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly monthlyBudget: string | null;
  readonly poRequired: boolean;
  readonly poPrefix: string | null;
  readonly costCentre: string | null;
}

export interface CartLineView {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: CartLineRow['product']['uom'];
  readonly variantId: string | null;
  readonly variantSku: string | null;
  readonly quantity: number;
  readonly moq: number;
  readonly orderMultiple: number;
  readonly packSize: number;
  readonly leadTimeDays: number | null;
  /**
   * The artwork this line was personalised from. Null for a line with none.
   *
   * `available` is false once the template has been unpublished, archived or
   * deleted — validation blocks checkout on it, and the basket says so rather
   * than letting the buyer discover it at the last step.
   */
  readonly template: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly versionId: string;
    readonly version: number;
    readonly available: boolean;
  } | null;
  readonly customisation: unknown;
  readonly notes: string | null;
  readonly addedAt: string;
}

export function toCartView(cart: FullCart): CartView {
  return {
    id: cart.id,
    status: cart.status,
    site: cart.site
      ? {
          id: cart.site.id,
          code: cart.site.code,
          name: cart.site.name,
          monthlyBudget: cart.site.monthlyBudget?.toFixed(2) ?? null,
          poRequired: cart.site.poRequired,
          poPrefix: cart.site.poPrefix,
          costCentre: cart.site.costCentre,
        }
      : null,
    lines: cart.lines.map(toCartLineView),
    lineCount: cart.lines.length,
    itemCount: cart.lines.reduce((total, line) => total + line.quantity, 0),
    poNumber: cart.poNumber,
    campaignCode: cart.campaignCode,
    notes: cart.notes,
    requestedDeliveryDate: cart.requestedDeliveryDate?.toISOString() ?? null,
    shippingAddressId: cart.shippingAddressId,
    billingAddressId: cart.billingAddressId,
    paymentMethod: cart.paymentMethod,
    termsAcceptedAt: cart.termsAcceptedAt?.toISOString() ?? null,
    createdAt: cart.createdAt.toISOString(),
    updatedAt: cart.updatedAt.toISOString(),
  };
}

function toCartLineView(line: CartLineRow): CartLineView {
  return {
    id: line.id,
    productId: line.productId,
    sku: line.product.sku,
    name: line.product.name,
    uom: line.product.uom,
    variantId: line.variantId,
    variantSku: line.variant?.sku ?? null,
    quantity: line.quantity,
    moq: line.product.moq,
    orderMultiple: line.product.orderMultiple,
    packSize: line.product.packSize,
    leadTimeDays: line.product.leadTimeDays,
    template:
      line.template && line.templateVersion
        ? {
            id: line.template.id,
            code: line.template.code,
            name: line.template.name,
            versionId: line.templateVersion.id,
            version: line.templateVersion.version,
            available: line.template.status === 'PUBLISHED' && line.template.deletedAt === null,
          }
        : null,
    customisation: line.customisation ?? null,
    notes: line.notes,
    addedAt: line.createdAt.toISOString(),
  };
}

/** The validated basket: every problem, every price, and what it would cost. */
export interface CartValidationView {
  readonly cart: CartView;
  readonly valid: boolean;
  readonly issues: readonly CartIssue[];
  readonly warnings: readonly CartIssue[];
  readonly lines: readonly ValidatedLineView[];
  readonly purchaseOrder: PurchaseOrderView;
  readonly budget: BudgetView;
  readonly billingPeriod: string;
  readonly subtotal: string;
  /** The same basket with no rate card applied, for the "you save" line. */
  readonly catalogSubtotal: string;
  readonly saving: string;
}

export interface ValidatedLineView {
  readonly lineId: string;
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  /** As typed by the buyer. */
  readonly quantity: number;
  /** What will actually be ordered once the MOQ and multiple are applied. */
  readonly orderableQuantity: number;
  readonly quantityAdjusted: boolean;
  /** Null when the product is gone or no longer visible to this account. */
  readonly unitPrice: string | null;
  readonly lineTotal: string | null;
  readonly catalogUnitPrice: string | null;
  readonly priceSource: string | null;
  readonly rateCardName: string | null;
  readonly issues: readonly CartIssue[];
  readonly warnings: readonly CartIssue[];
}

export interface PurchaseOrderView {
  readonly required: boolean;
  readonly requiredBy: PurchaseOrderCheck['policy']['requiredBy'];
  readonly prefix: string | null;
  readonly prefixFrom: PurchaseOrderCheck['policy']['prefixFrom'];
  readonly provided: string | null;
  readonly valid: boolean;
  readonly problem: PurchaseOrderCheck['problem'];
  readonly message: string | null;
}

export interface BudgetView {
  /** Null means the branch is uncapped. Zero means it may not order at all. */
  readonly cap: string | null;
  readonly spent: string;
  readonly remaining: string | null;
  readonly cartTotal: string;
  readonly projected: string;
  readonly wouldExceed: boolean;
  readonly overage: string;
  readonly utilisationPercent: number | null;
}

export function toCartValidationView(validation: CartValidation): CartValidationView {
  return {
    cart: toCartView(validation.cart),
    valid: validation.valid,
    issues: validation.issues,
    warnings: validation.warnings,
    lines: validation.lines.map(toValidatedLineView),
    purchaseOrder: {
      required: validation.purchaseOrder.policy.required,
      requiredBy: validation.purchaseOrder.policy.requiredBy,
      prefix: validation.purchaseOrder.policy.prefix,
      prefixFrom: validation.purchaseOrder.policy.prefixFrom,
      provided: validation.purchaseOrder.provided,
      valid: validation.purchaseOrder.valid,
      problem: validation.purchaseOrder.problem,
      message: validation.purchaseOrder.message,
    },
    budget: {
      cap: validation.budget.capCents === null ? null : fromCents(validation.budget.capCents),
      spent: fromCents(validation.budget.spentCents),
      remaining:
        validation.budget.remainingCents === null
          ? null
          : fromCents(validation.budget.remainingCents),
      cartTotal: fromCents(validation.budget.cartTotalCents),
      projected: fromCents(validation.budget.projectedCents),
      wouldExceed: validation.budget.wouldExceed,
      overage: fromCents(validation.budget.overageCents),
      utilisationPercent: validation.budget.utilisationPercent,
    },
    billingPeriod: validation.billingPeriod,
    subtotal: fromCents(validation.subtotalCents),
    catalogSubtotal: fromCents(validation.catalogSubtotalCents),
    saving: fromCents(validation.savingCents),
  };
}

function toValidatedLineView(line: ValidatedLine): ValidatedLineView {
  const breakdown = line.quote?.breakdown ?? null;

  return {
    lineId: line.line.id,
    productId: line.line.productId,
    sku: line.line.product.sku,
    name: line.line.product.name,
    quantity: line.check.quantity,
    orderableQuantity: line.check.orderableQuantity,
    quantityAdjusted: line.check.orderableQuantity !== line.check.quantity,
    unitPrice: breakdown ? fromCents(breakdown.unitPriceCents) : null,
    lineTotal: breakdown ? fromCents(breakdown.lineTotalCents) : null,
    catalogUnitPrice: breakdown ? fromCents(breakdown.catalogUnitPriceCents) : null,
    priceSource: breakdown?.source ?? null,
    rateCardName: breakdown?.rateCardName ?? null,
    issues: line.check.issues,
    warnings: line.check.warnings,
  };
}

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
