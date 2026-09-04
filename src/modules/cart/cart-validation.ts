import { isOrderableQuantity, roundToOrderable } from '@/modules/catalog';

/**
 * The rules a basket must satisfy before it can become an order (SOW BE-05).
 *
 * Pure and free of Prisma. The service reads the rows; this decides what is
 * wrong with them, and BE-06 runs the same functions again at submission —
 * because a product can be unpublished, a rate card can expire and stock can
 * run out between validating a cart and paying for it, and the check that
 * matters is the last one.
 *
 * ---------------------------------------------------------------------------
 * Every problem is reported, not the first
 * ---------------------------------------------------------------------------
 * A buyer with four bad lines should see four messages once, not fix one and
 * discover the next. So these return arrays and the caller never short-circuits.
 *
 * Blocking issues and warnings are separated: a quantity that needs rounding up
 * is a warning, because the cart can proceed once the buyer accepts the
 * adjustment, whereas an unpublished product is a hard stop.
 */

export const CartIssueCode = {
  EMPTY_CART: 'EMPTY_CART',
  NO_SITE: 'NO_SITE',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  VARIANT_UNAVAILABLE: 'VARIANT_UNAVAILABLE',
  QUANTITY_BELOW_MOQ: 'QUANTITY_BELOW_MOQ',
  QUANTITY_NOT_MULTIPLE: 'QUANTITY_NOT_MULTIPLE',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  TEMPLATE_UNAVAILABLE: 'TEMPLATE_UNAVAILABLE',
  PO_REQUIRED: 'PO_REQUIRED',
  PO_PREFIX_MISMATCH: 'PO_PREFIX_MISMATCH',
  PO_TOO_SHORT: 'PO_TOO_SHORT',
  PO_INVALID_CHARACTERS: 'PO_INVALID_CHARACTERS',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  NO_SHIPPING_ADDRESS: 'NO_SHIPPING_ADDRESS',
  ADDRESS_NOT_AVAILABLE: 'ADDRESS_NOT_AVAILABLE',
  PAYMENT_METHOD_REQUIRED: 'PAYMENT_METHOD_REQUIRED',
  TERMS_NOT_ACCEPTED: 'TERMS_NOT_ACCEPTED',
  DELIVERY_DATE_IN_PAST: 'DELIVERY_DATE_IN_PAST',
} as const;

export type CartIssueCode = (typeof CartIssueCode)[keyof typeof CartIssueCode];

export interface CartIssue {
  readonly code: CartIssueCode;
  /** Written for the buyer, not for a log. */
  readonly message: string;
  /** The line it belongs to, or null for a cart-wide problem. */
  readonly lineId: string | null;
  readonly details?: Record<string, unknown>;
}

/** What the validator needs to know about a line's product. */
export interface LineProductFacts {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  /** Whether the product is in a status a customer can order. */
  readonly orderable: boolean;
  readonly moq: number;
  readonly orderMultiple: number;
  readonly trackInventory: boolean;
  /**
   * What is still buyable: the shelf count minus what other orders already hold.
   *
   * Named for what it means rather than for the column it comes from. A field
   * called `stockOnHand` that the validator treated as available is exactly the
   * confusion that lets two buyers be promised the same last unit.
   */
  readonly availableStock: number;
  /** Null when the line names no variant. */
  readonly variant: { readonly id: string; readonly sku: string; readonly active: boolean } | null;
}

/**
 * What the validator needs to know about a line's artwork.
 *
 * Null when the line names no template. A line that does name one is only
 * printable while that template is still published: a designer who archives
 * artwork has withdrawn it, and a basket assembled beforehand must not walk
 * past that on the way to a printing press.
 */
export interface LineTemplateFacts {
  readonly templateId: string;
  readonly name: string;
  readonly version: number;
  readonly available: boolean;
}

export interface LineCheck {
  readonly lineId: string;
  readonly quantity: number;
  /** The nearest quantity the product can actually be bought in. */
  readonly orderableQuantity: number;
  readonly issues: readonly CartIssue[];
  readonly warnings: readonly CartIssue[];
}

/**
 * Checks one line.
 *
 * MOQ and order-multiple failures are **warnings**, with the corrected quantity
 * alongside, because the fix is unambiguous and the buyer only has to accept
 * it. Everything else here is blocking: no quantity the buyer can choose makes
 * an unpublished product orderable.
 */
export function checkLine(
  lineId: string,
  quantity: number,
  product: LineProductFacts | null,
  template: LineTemplateFacts | null = null,
): LineCheck {
  const issues: CartIssue[] = [];
  const warnings: CartIssue[] = [];

  // Checked before the product, and blocking. Unlike a quantity, there is
  // nothing the buyer can change to make withdrawn artwork printable — the
  // line has to go back to the customiser or out of the basket.
  if (template && !template.available) {
    issues.push({
      code: CartIssueCode.TEMPLATE_UNAVAILABLE,
      message:
        `The design "${template.name}" is no longer available. ` +
        'Remove this line, or personalise a current template instead.',
      lineId,
      details: { templateId: template.templateId, version: template.version },
    });
  }

  if (!product) {
    // The product is gone, or the buyer may no longer see it. Both are reported
    // the same way: a customer must not learn from a cart message that a SKU
    // exists but is now somebody else's contract line.
    return {
      lineId,
      quantity,
      orderableQuantity: quantity,
      issues: [
        {
          code: CartIssueCode.PRODUCT_UNAVAILABLE,
          message: 'This product is no longer available. Remove the line to continue.',
          lineId,
        },
      ],
      warnings: [],
    };
  }

  if (!product.orderable) {
    issues.push({
      code: CartIssueCode.PRODUCT_UNAVAILABLE,
      message: `"${product.name}" is no longer available to order.`,
      lineId,
      details: { sku: product.sku },
    });
  }

  if (product.variant && !product.variant.active) {
    issues.push({
      code: CartIssueCode.VARIANT_UNAVAILABLE,
      message: `The chosen option for "${product.name}" is no longer available.`,
      lineId,
      details: { variantSku: product.variant.sku },
    });
  }

  const orderableQuantity = roundToOrderable(quantity, product.moq, product.orderMultiple);

  if (!isOrderableQuantity(quantity, product.moq, product.orderMultiple)) {
    if (quantity < product.moq) {
      warnings.push({
        code: CartIssueCode.QUANTITY_BELOW_MOQ,
        message: `"${product.name}" has a minimum order of ${product.moq}. The quantity will be raised to ${orderableQuantity}.`,
        lineId,
        details: { moq: product.moq, requested: quantity, adjustedTo: orderableQuantity },
      });
    } else {
      warnings.push({
        code: CartIssueCode.QUANTITY_NOT_MULTIPLE,
        message: `"${product.name}" is sold in multiples of ${product.orderMultiple} above ${product.moq}. The quantity will be raised to ${orderableQuantity}.`,
        lineId,
        details: {
          orderMultiple: product.orderMultiple,
          moq: product.moq,
          requested: quantity,
          adjustedTo: orderableQuantity,
        },
      });
    }
  }

  // Checked against the quantity that would actually be ordered, not the one
  // typed: rounding 120 up to 500 is what will draw down the shelf, and
  // checking the 120 would let an order through that cannot be filled.
  //
  // Stock is only counted for products that track it. Print-on-demand has no
  // shelf to run out of, and checking it would block every order.
  //
  // Checked against *available* stock, not the shelf count: units already
  // promised to other orders are not buyable, and counting them would put a
  // line in a basket that placement then refuses.
  if (product.trackInventory && orderableQuantity > product.availableStock) {
    issues.push({
      code: CartIssueCode.INSUFFICIENT_STOCK,
      message:
        product.availableStock === 0
          ? `"${product.name}" is out of stock.`
          : `Only ${product.availableStock} of "${product.name}" are available; the line needs ${orderableQuantity}.`,
      lineId,
      details: { available: product.availableStock, required: orderableQuantity },
    });
  }

  return { lineId, quantity, orderableQuantity, issues, warnings };
}

/**
 * The checkout-only requirements: the details the stepper collects.
 *
 * Separate from the line checks because a basket can be perfectly valid as a
 * basket while still missing a delivery address — the cart page should not
 * shout about an address the buyer has not reached the step for yet. The caller
 * runs this only when validating *for checkout*.
 */
export interface CheckoutFacts {
  readonly hasLines: boolean;
  readonly siteId: string | null;
  readonly shippingAddressId: string | null;
  /** Whether that address is one this account and site may actually ship to. */
  readonly shippingAddressUsable: boolean;
  readonly paymentMethod: string | null;
  readonly termsAcceptedAt: Date | null;
  readonly requestedDeliveryDate: Date | null;
  readonly now: Date;
}

export function checkCheckoutDetails(facts: CheckoutFacts): readonly CartIssue[] {
  const issues: CartIssue[] = [];

  if (!facts.hasLines) {
    issues.push({
      code: CartIssueCode.EMPTY_CART,
      message: 'There is nothing in this basket.',
      lineId: null,
    });
  }

  if (!facts.siteId) {
    // The branch decides the budget, the purchase-order rule and where the
    // order ships. Without it none of the other checks mean anything.
    issues.push({
      code: CartIssueCode.NO_SITE,
      message: 'Choose which branch this order is for.',
      lineId: null,
    });
  }

  if (!facts.shippingAddressId) {
    issues.push({
      code: CartIssueCode.NO_SHIPPING_ADDRESS,
      message: 'Choose a delivery address.',
      lineId: null,
    });
  } else if (!facts.shippingAddressUsable) {
    issues.push({
      code: CartIssueCode.ADDRESS_NOT_AVAILABLE,
      message: 'The selected delivery address is no longer available. Choose another.',
      lineId: null,
    });
  }

  if (!facts.paymentMethod) {
    issues.push({
      code: CartIssueCode.PAYMENT_METHOD_REQUIRED,
      message: 'Choose how this order will be paid for.',
      lineId: null,
    });
  }

  if (!facts.termsAcceptedAt) {
    issues.push({
      code: CartIssueCode.TERMS_NOT_ACCEPTED,
      message: 'Accept the terms to place this order.',
      lineId: null,
    });
  }

  if (facts.requestedDeliveryDate && facts.requestedDeliveryDate < startOfUtcDay(facts.now)) {
    // Compared at day granularity: a date picker sends midnight, and comparing
    // against the current instant would reject today.
    issues.push({
      code: CartIssueCode.DELIVERY_DATE_IN_PAST,
      message: 'The requested delivery date is in the past.',
      lineId: null,
      details: { requested: facts.requestedDeliveryDate.toISOString() },
    });
  }

  return issues;
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
