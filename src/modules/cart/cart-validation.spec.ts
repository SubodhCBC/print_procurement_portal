import { describe, expect, it } from 'vitest';
import { checkCheckoutDetails, checkLine, type LineProductFacts } from './cart-validation';

/**
 * SOW QA-01 names "MOQ rounding" as a unit-test target, and lists "zero-stock"
 * and "superseded products" among the edge cases. Every rule here decides
 * whether an order can be filled, so getting one wrong means a customer pays
 * for something that will never ship.
 */

function product(overrides: Partial<LineProductFacts> = {}): LineProductFacts {
  return {
    productId: 'prd_1',
    sku: 'FLY-A5',
    name: 'A5 Flyer',
    orderable: true,
    moq: 1,
    orderMultiple: 1,
    trackInventory: false,
    stockOnHand: 0,
    variant: null,
    ...overrides,
  };
}

describe('checkLine — availability', () => {
  it('passes a plain, orderable line', () => {
    const check = checkLine('crl_1', 10, product());

    expect(check.issues).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.orderableQuantity).toBe(10);
  });

  it('blocks a product that is no longer orderable', () => {
    const check = checkLine('crl_1', 10, product({ orderable: false }));

    expect(check.issues.map((issue) => issue.code)).toEqual(['PRODUCT_UNAVAILABLE']);
  });

  it('reports a product the buyer may no longer see exactly as gone', () => {
    // Identical treatment on purpose: a cart message must not confirm that a
    // SKU exists but has become another customer's contract line.
    const check = checkLine('crl_1', 10, null);

    expect(check.issues.map((issue) => issue.code)).toEqual(['PRODUCT_UNAVAILABLE']);
    expect(check.issues[0]?.message).not.toContain('A5 Flyer');
  });

  it('blocks a variant that has been withdrawn', () => {
    const check = checkLine(
      'crl_1',
      10,
      product({ variant: { id: 'var_1', sku: 'FLY-A5-GLOSS', active: false } }),
    );

    expect(check.issues.map((issue) => issue.code)).toEqual(['VARIANT_UNAVAILABLE']);
  });
});

describe('checkLine — MOQ and order multiples', () => {
  it('warns rather than blocks below the MOQ, with the corrected quantity', () => {
    // A warning because the fix is unambiguous and the buyer only has to accept
    // it. Blocking would make them guess the number themselves.
    const check = checkLine('crl_1', 120, product({ moq: 500, orderMultiple: 500 }));

    expect(check.issues).toEqual([]);
    expect(check.warnings.map((warning) => warning.code)).toEqual(['QUANTITY_BELOW_MOQ']);
    expect(check.orderableQuantity).toBe(500);
    expect(check.warnings[0]?.details).toMatchObject({ requested: 120, adjustedTo: 500 });
  });

  it('counts multiples from the MOQ, not from zero', () => {
    // An MOQ of 100 in multiples of 30 gives 100, 130, 160 — not 120, 150,
    // which is what rounding from zero would produce and no supplier accepts.
    const check = checkLine('crl_1', 115, product({ moq: 100, orderMultiple: 30 }));

    expect(check.orderableQuantity).toBe(130);
    expect(check.warnings.map((warning) => warning.code)).toEqual(['QUANTITY_NOT_MULTIPLE']);
  });

  it('leaves an already-orderable quantity alone', () => {
    const check = checkLine('crl_1', 1000, product({ moq: 500, orderMultiple: 500 }));

    expect(check.warnings).toEqual([]);
    expect(check.orderableQuantity).toBe(1000);
  });

  it('distinguishes "below the minimum" from "not on a boundary"', () => {
    const below = checkLine('crl_1', 400, product({ moq: 500, orderMultiple: 500 }));
    const offBoundary = checkLine('crl_2', 600, product({ moq: 500, orderMultiple: 500 }));

    expect(below.warnings[0]?.code).toBe('QUANTITY_BELOW_MOQ');
    expect(offBoundary.warnings[0]?.code).toBe('QUANTITY_NOT_MULTIPLE');
  });
});

describe('checkLine — stock', () => {
  it('ignores stock for print-on-demand', () => {
    // There is no shelf to run out of; checking would block every order.
    const check = checkLine('crl_1', 10_000, product({ trackInventory: false, stockOnHand: 0 }));

    expect(check.issues).toEqual([]);
  });

  it('blocks when the shelf cannot cover the line', () => {
    const check = checkLine('crl_1', 50, product({ trackInventory: true, stockOnHand: 20 }));

    expect(check.issues.map((issue) => issue.code)).toEqual(['INSUFFICIENT_STOCK']);
    expect(check.issues[0]?.details).toMatchObject({ available: 20, required: 50 });
  });

  it('says "out of stock" rather than "only 0 available"', () => {
    const check = checkLine('crl_1', 5, product({ trackInventory: true, stockOnHand: 0 }));

    expect(check.issues[0]?.message).toContain('out of stock');
  });

  it('checks stock against the rounded quantity, not the typed one', () => {
    // 120 rounds to 500, and 500 is what will draw down the shelf. Checking the
    // 120 would let through an order that cannot be filled.
    const check = checkLine(
      'crl_1',
      120,
      product({ moq: 500, orderMultiple: 500, trackInventory: true, stockOnHand: 300 }),
    );

    expect(check.issues.map((issue) => issue.code)).toEqual(['INSUFFICIENT_STOCK']);
    expect(check.issues[0]?.details).toMatchObject({ available: 300, required: 500 });
  });

  it('allows a line that exactly empties the shelf', () => {
    const check = checkLine('crl_1', 20, product({ trackInventory: true, stockOnHand: 20 }));

    expect(check.issues).toEqual([]);
  });
});

describe('checkLine — every problem at once', () => {
  it('reports an unavailable product and a stock shortfall together', () => {
    // A buyer with several problems should see them all, not fix one and
    // discover the next.
    const check = checkLine(
      'crl_1',
      50,
      product({ orderable: false, trackInventory: true, stockOnHand: 10 }),
    );

    expect(check.issues.map((issue) => issue.code).sort()).toEqual([
      'INSUFFICIENT_STOCK',
      'PRODUCT_UNAVAILABLE',
    ]);
  });
});

describe('checkCheckoutDetails', () => {
  const ready = {
    hasLines: true,
    siteId: 'sit_1',
    shippingAddressId: 'adr_1',
    shippingAddressUsable: true,
    paymentMethod: 'NET_30_INVOICE',
    termsAcceptedAt: new Date('2026-09-01T10:00:00.000Z'),
    requestedDeliveryDate: null,
    now: new Date('2026-09-02T09:00:00.000Z'),
  };

  it('passes a complete checkout', () => {
    expect(checkCheckoutDetails(ready)).toEqual([]);
  });

  it('lists everything missing at once', () => {
    const issues = checkCheckoutDetails({
      ...ready,
      hasLines: false,
      siteId: null,
      shippingAddressId: null,
      paymentMethod: null,
      termsAcceptedAt: null,
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      'EMPTY_CART',
      'NO_SITE',
      'NO_SHIPPING_ADDRESS',
      'PAYMENT_METHOD_REQUIRED',
      'TERMS_NOT_ACCEPTED',
    ]);
  });

  it('distinguishes an unchosen address from a withdrawn one', () => {
    const issues = checkCheckoutDetails({ ...ready, shippingAddressUsable: false });

    expect(issues.map((issue) => issue.code)).toEqual(['ADDRESS_NOT_AVAILABLE']);
  });

  it('accepts a delivery date of today', () => {
    // A date picker sends midnight. Comparing against the current instant would
    // reject today, which is the most common request there is.
    const issues = checkCheckoutDetails({
      ...ready,
      requestedDeliveryDate: new Date('2026-09-02T00:00:00.000Z'),
    });

    expect(issues).toEqual([]);
  });

  it('refuses a delivery date in the past', () => {
    const issues = checkCheckoutDetails({
      ...ready,
      requestedDeliveryDate: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(issues.map((issue) => issue.code)).toEqual(['DELIVERY_DATE_IN_PAST']);
  });
});
