import { describe, expect, it } from 'vitest';
import { BusinessRuleError } from '@/common';
import {
  applyDiscount,
  isOrderableQuantity,
  priceLadder,
  priceLine,
  roundToOrderable,
  selectTier,
  type VolumeTier,
} from './product-pricing';

const TIERS: readonly VolumeTier[] = [
  { minQuantity: 100, discountPercent: 5 },
  { minQuantity: 250, discountPercent: 10 },
  { minQuantity: 500, discountPercent: 17.5 },
];

describe('selectTier', () => {
  it('returns nothing below the first threshold', () => {
    expect(selectTier(99, TIERS)).toBeNull();
  });

  it('is inclusive at the threshold', () => {
    expect(selectTier(100, TIERS)?.discountPercent).toBe(5);
  });

  it('takes the highest threshold the quantity reaches', () => {
    expect(selectTier(499, TIERS)?.minQuantity).toBe(250);
    expect(selectTier(500, TIERS)?.minQuantity).toBe(500);
    expect(selectTier(10_000, TIERS)?.minQuantity).toBe(500);
  });

  it('does not depend on the order the tiers arrive in', () => {
    const shuffled = [TIERS[2]!, TIERS[0]!, TIERS[1]!];
    expect(selectTier(300, shuffled)?.minQuantity).toBe(250);
  });

  it('handles an empty ladder', () => {
    expect(selectTier(1000, [])).toBeNull();
  });
});

describe('applyDiscount', () => {
  it('leaves the price alone at zero percent', () => {
    expect(applyDiscount(1999, 0)).toBe(1999);
  });

  it('rounds half up', () => {
    // 1999 * 0.9 = 1799.1 -> 1799; 1995 * 0.9 = 1795.5 -> 1796
    expect(applyDiscount(1999, 10)).toBe(1799);
    expect(applyDiscount(1995, 10)).toBe(1796);
  });

  it('handles a fractional discount percentage', () => {
    // 2000 * 0.825 = 1650
    expect(applyDiscount(2000, 17.5)).toBe(1650);
  });

  it('never produces a fractional cent', () => {
    for (const price of [1, 7, 33, 199, 1999, 123_456]) {
      for (const percent of [1, 3.33, 7.5, 12.25, 17.5]) {
        expect(Number.isInteger(applyDiscount(price, percent))).toBe(true);
      }
    }
  });
});

describe('priceLine', () => {
  it('prices below the ladder at the base price', () => {
    const line = priceLine({ baseUnitPriceCents: 200, quantity: 50, tiers: TIERS });

    expect(line.appliedTier).toBeNull();
    expect(line.unitPriceCents).toBe(200);
    expect(line.lineTotalCents).toBe(10_000);
    expect(line.savingCents).toBe(0);
  });

  it('applies the reached tier and reports the saving', () => {
    const line = priceLine({ baseUnitPriceCents: 200, quantity: 250, tiers: TIERS });

    expect(line.discountPercent).toBe(10);
    expect(line.unitPriceCents).toBe(180);
    expect(line.lineTotalCents).toBe(45_000);
    expect(line.savingCents).toBe(5_000);
  });

  it('keeps unit price times quantity equal to the line total', () => {
    // The property that makes an invoice add up. Discounting the line total
    // instead of the unit price breaks it by a cent at awkward quantities.
    for (const quantity of [1, 7, 99, 100, 137, 250, 501, 999]) {
      const line = priceLine({ baseUnitPriceCents: 1999, quantity, tiers: TIERS });
      expect(line.unitPriceCents * line.quantity).toBe(line.lineTotalCents);
    }
  });

  it('prices a free item without dividing by zero', () => {
    const line = priceLine({ baseUnitPriceCents: 0, quantity: 500, tiers: TIERS });

    expect(line.unitPriceCents).toBe(0);
    expect(line.lineTotalCents).toBe(0);
  });

  it('rejects a zero or fractional quantity', () => {
    expect(() => priceLine({ baseUnitPriceCents: 100, quantity: 0, tiers: [] })).toThrow(
      BusinessRuleError,
    );
    expect(() => priceLine({ baseUnitPriceCents: 100, quantity: 1.5, tiers: [] })).toThrow(
      BusinessRuleError,
    );
  });
});

describe('priceLadder', () => {
  it('prices each tier at its own threshold, in ascending order', () => {
    const rows = priceLadder(200, [TIERS[2]!, TIERS[0]!, TIERS[1]!]);

    expect(rows.map((r) => r.quantity)).toEqual([100, 250, 500]);
    expect(rows.map((r) => r.unitPriceCents)).toEqual([190, 180, 165]);
  });

  it('is empty for a product with no ladder', () => {
    expect(priceLadder(200, [])).toEqual([]);
  });
});

describe('roundToOrderable', () => {
  it('raises a quantity below the MOQ', () => {
    expect(roundToOrderable(10, 100, 1)).toBe(100);
  });

  it('leaves an already-valid quantity alone', () => {
    expect(roundToOrderable(150, 100, 50)).toBe(150);
  });

  it('rounds up, never down', () => {
    // 120 of something sold in fifties is 150. Shipping 100 is the worse
    // failure: the customer gets less than they asked for.
    expect(roundToOrderable(120, 100, 50)).toBe(150);
    expect(roundToOrderable(101, 100, 50)).toBe(150);
  });

  it('counts multiples from the MOQ, not from zero', () => {
    // MOQ 100 in steps of 30 gives 100, 130, 160 — not 120, 150, which is what
    // rounding from zero would produce and which no supplier would accept.
    expect(roundToOrderable(100, 100, 30)).toBe(100);
    expect(roundToOrderable(101, 100, 30)).toBe(130);
    expect(roundToOrderable(130, 100, 30)).toBe(130);
    expect(roundToOrderable(131, 100, 30)).toBe(160);
  });

  it('treats a multiple of one as no constraint', () => {
    expect(roundToOrderable(137, 1, 1)).toBe(137);
  });

  it('rejects a zero MOQ or multiple rather than looping', () => {
    expect(() => roundToOrderable(10, 0, 1)).toThrow(BusinessRuleError);
    expect(() => roundToOrderable(10, 1, 0)).toThrow(BusinessRuleError);
  });
});

describe('isOrderableQuantity', () => {
  it('agrees with roundToOrderable', () => {
    for (const quantity of [1, 99, 100, 101, 130, 150, 160]) {
      const rounded = roundToOrderable(quantity, 100, 30);
      expect(isOrderableQuantity(quantity, 100, 30)).toBe(quantity === rounded);
    }
  });
});
