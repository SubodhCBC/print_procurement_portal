import { describe, expect, it } from 'vitest';
import {
  priceForContract,
  priceLadderForContract,
  type ResolvedRateCard,
} from './rate-card-pricing';

/**
 * The precedence rules from the top of rate-card-pricing.ts, asserted one at a
 * time. SOW QA-01 names "rate card discount precedence" first, and this is the
 * arithmetic behind every invoice the system will ever produce.
 *
 * Prices are in cents throughout: 14500 is £145.00.
 */

const CATALOG_LADDER = [
  { minQuantity: 100, discountPercent: 5 },
  { minQuantity: 1000, discountPercent: 10 },
  { minQuantity: 10000, discountPercent: 25 },
];

function card(partial: Partial<ResolvedRateCard> = {}): ResolvedRateCard {
  return {
    id: 'rc_1',
    name: 'Test contract',
    defaultDiscountPercent: 0,
    item: null,
    ...partial,
  };
}

describe('priceForContract — no rate card', () => {
  it('falls through to the catalogue base price', () => {
    const result = priceForContract({
      baseUnitPriceCents: 14500,
      quantity: 1,
      catalogTiers: CATALOG_LADDER,
      card: null,
    });

    expect(result.source).toBe('CATALOG_BASE');
    expect(result.unitPriceCents).toBe(14500);
    expect(result.rateCardId).toBeNull();
    expect(result.savingCents).toBe(0);
  });

  it('applies the public volume ladder', () => {
    const result = priceForContract({
      baseUnitPriceCents: 14500,
      quantity: 1000,
      catalogTiers: CATALOG_LADDER,
      card: null,
    });

    expect(result.source).toBe('CATALOG_VOLUME_TIER');
    expect(result.unitPriceCents).toBe(13050);
    expect(result.discountPercent).toBe(10);
  });

  it('treats a card with nothing to say as no card at all', () => {
    // A card with a zero default and no entry for this product says nothing
    // about it. It must not report itself as the source of a "0% contract
    // price", or every product page would claim a discount that is not there.
    const result = priceForContract({
      baseUnitPriceCents: 14500,
      quantity: 1,
      catalogTiers: [],
      card: card(),
    });

    expect(result.source).toBe('CATALOG_BASE');
    expect(result.rateCardId).toBeNull();
  });
});

describe('priceForContract — precedence', () => {
  it('a fixed contract price wins over everything', () => {
    const result = priceForContract({
      baseUnitPriceCents: 14500,
      quantity: 20000,
      catalogTiers: CATALOG_LADDER,
      card: card({
        defaultDiscountPercent: 15,
        item: { fixedPriceCents: 12000, discountPercent: null, tiers: [] },
      }),
    });

    expect(result.source).toBe('CONTRACT_FIXED_PRICE');
    expect(result.unitPriceCents).toBe(12000);
    // Even at 20,000, where the public ladder gives 25% off.
    expect(result.catalogUnitPriceCents).toBe(10875);
  });

  it('a contract tier beats the item discount and the card default', () => {
    const result = priceForContract({
      baseUnitPriceCents: 14500,
      quantity: 5000,
      catalogTiers: CATALOG_LADDER,
      card: card({
        defaultDiscountPercent: 15,
        item: {
          fixedPriceCents: null,
          discountPercent: 18,
          tiers: [{ minQuantity: 5000, discountPercent: 22 }],
        },
      }),
    });

    expect(result.source).toBe('CONTRACT_VOLUME_TIER');
    expect(result.unitPriceCents).toBe(11310);
    expect(result.appliedTier).toEqual({ minQuantity: 5000, discountPercent: 22 });
  });

  it('falls back to the item discount below the contract ladder', () => {
    // "18% off, 22% at 5,000" is how these are written; at 4,999 the flat rate
    // is what applies.
    const result = priceForContract({
      baseUnitPriceCents: 14500,
      quantity: 4999,
      catalogTiers: CATALOG_LADDER,
      card: card({
        defaultDiscountPercent: 15,
        item: {
          fixedPriceCents: null,
          discountPercent: 18,
          tiers: [{ minQuantity: 5000, discountPercent: 22 }],
        },
      }),
    });

    expect(result.source).toBe('CONTRACT_ITEM_DISCOUNT');
    expect(result.unitPriceCents).toBe(11890);
  });

  it('an item discount overrides the card default', () => {
    const result = priceForContract({
      baseUnitPriceCents: 10000,
      quantity: 1,
      catalogTiers: [],
      card: card({
        defaultDiscountPercent: 15,
        item: { fixedPriceCents: null, discountPercent: 25, tiers: [] },
      }),
    });

    expect(result.source).toBe('CONTRACT_ITEM_DISCOUNT');
    expect(result.unitPriceCents).toBe(7500);
  });

  it('the card default covers products the card does not name', () => {
    const result = priceForContract({
      baseUnitPriceCents: 10000,
      quantity: 1,
      catalogTiers: [],
      card: card({ defaultDiscountPercent: 15 }),
    });

    expect(result.source).toBe('CONTRACT_DEFAULT_DISCOUNT');
    expect(result.unitPriceCents).toBe(8500);
    expect(result.rateCardName).toBe('Test contract');
  });

  it('an item row with no rule of its own still takes the card default', () => {
    const result = priceForContract({
      baseUnitPriceCents: 10000,
      quantity: 1,
      catalogTiers: [],
      card: card({
        defaultDiscountPercent: 15,
        item: { fixedPriceCents: null, discountPercent: null, tiers: [] },
      }),
    });

    expect(result.source).toBe('CONTRACT_DEFAULT_DISCOUNT');
    expect(result.unitPriceCents).toBe(8500);
  });
});

describe('priceForContract — discounts never stack', () => {
  it('a contract discount replaces the public ladder rather than compounding', () => {
    const result = priceForContract({
      baseUnitPriceCents: 10000,
      quantity: 1000,
      catalogTiers: CATALOG_LADDER,
      card: card({ defaultDiscountPercent: 15 }),
    });

    // 15% off, not 15% then a further 10% (which would be 7650).
    expect(result.unitPriceCents).toBe(8500);
    expect(result.catalogUnitPriceCents).toBe(9000);
  });

  it('a contract tier replaces the public tier at the same quantity', () => {
    const result = priceForContract({
      baseUnitPriceCents: 10000,
      quantity: 10000,
      catalogTiers: CATALOG_LADDER,
      card: card({
        item: {
          fixedPriceCents: null,
          discountPercent: null,
          tiers: [{ minQuantity: 10000, discountPercent: 30 }],
        },
      }),
    });

    // 30%, not 30% on top of the public 25%.
    expect(result.unitPriceCents).toBe(7000);
    expect(result.catalogUnitPriceCents).toBe(7500);
  });
});

describe('priceForContract — the contract can be the worse deal', () => {
  it('reports a contract price above the catalogue price rather than correcting it', () => {
    // The cost of "no stacking": at 10,000 the public ladder gives 25% off but
    // the contract only 15%. The engine does not invent a policy of quietly
    // giving the customer the better of the two — it makes the situation
    // visible so whoever signed the deal can decide.
    const result = priceForContract({
      baseUnitPriceCents: 10000,
      quantity: 10000,
      catalogTiers: CATALOG_LADDER,
      card: card({ defaultDiscountPercent: 15 }),
    });

    expect(result.unitPriceCents).toBe(8500);
    expect(result.catalogUnitPriceCents).toBe(7500);
    expect(result.aboveCatalogPrice).toBe(true);
    // Signed, not clamped: the size of the problem is the useful part.
    expect(result.savingCents).toBe(-10_000_000);
  });

  it('is not flagged when the contract matches the catalogue exactly', () => {
    const result = priceForContract({
      baseUnitPriceCents: 10000,
      quantity: 1000,
      catalogTiers: CATALOG_LADDER,
      card: card({ defaultDiscountPercent: 10 }),
    });

    expect(result.unitPriceCents).toBe(result.catalogUnitPriceCents);
    expect(result.aboveCatalogPrice).toBe(false);
  });
});

describe('priceForContract — rounding and reported percentages', () => {
  it('rounds the unit price half-up, then multiplies', () => {
    // 145 * 0.825 = 119.625 -> 120 cents per unit, 12000 for 100.
    const result = priceForContract({
      baseUnitPriceCents: 145,
      quantity: 100,
      catalogTiers: [],
      card: card({ defaultDiscountPercent: 17.5 }),
    });

    expect(result.unitPriceCents).toBe(120);
    expect(result.lineTotalCents).toBe(12000);
  });

  it('derives the percentage a fixed price represents', () => {
    const result = priceForContract({
      baseUnitPriceCents: 14500,
      quantity: 1,
      catalogTiers: [],
      card: card({ item: { fixedPriceCents: 12000, discountPercent: null, tiers: [] } }),
    });

    // (145 - 120) / 145 = 17.2413…%, to two places.
    expect(result.discountPercent).toBe(17.24);
  });

  it('reports no discount on a free product rather than dividing by zero', () => {
    const result = priceForContract({
      baseUnitPriceCents: 0,
      quantity: 10,
      catalogTiers: [],
      card: card({ defaultDiscountPercent: 15 }),
    });

    expect(result.discountPercent).toBe(0);
    expect(result.unitPriceCents).toBe(0);
  });

  it('rejects a fractional quantity', () => {
    expect(() =>
      priceForContract({ baseUnitPriceCents: 100, quantity: 1.5, catalogTiers: [], card: null }),
    ).toThrow(/quantity/);
  });
});

describe('priceLadderForContract', () => {
  it('merges both ladders so every break the customer can reach is shown', () => {
    const rows = priceLadderForContract({
      baseUnitPriceCents: 10000,
      moq: 1,
      catalogTiers: [{ minQuantity: 1000, discountPercent: 10 }],
      card: card({
        defaultDiscountPercent: 15,
        item: {
          fixedPriceCents: null,
          discountPercent: null,
          tiers: [{ minQuantity: 5000, discountPercent: 22 }],
        },
      }),
    });

    expect(rows.map((row) => row.quantity)).toEqual([1, 1000, 5000]);
    // The public break at 1,000 is shown, but the contract still prices it.
    expect(rows.map((row) => [row.source, row.unitPriceCents])).toEqual([
      ['CONTRACT_DEFAULT_DISCOUNT', 8500],
      ['CONTRACT_DEFAULT_DISCOUNT', 8500],
      ['CONTRACT_VOLUME_TIER', 7800],
    ]);
  });

  it('starts at the MOQ and drops breaks below it', () => {
    // A product sold in 500s cannot be bought at 100, so a 100+ row would be a
    // price nobody can order at.
    const rows = priceLadderForContract({
      baseUnitPriceCents: 10000,
      moq: 500,
      catalogTiers: [
        { minQuantity: 100, discountPercent: 5 },
        { minQuantity: 1000, discountPercent: 10 },
      ],
      card: null,
    });

    // At the MOQ the 100+ tier is still what applies — it is dropped as a
    // *row*, not as a rule.
    expect(rows.map((row) => [row.quantity, row.unitPriceCents])).toEqual([
      [500, 9500],
      [1000, 9000],
    ]);
  });

  it('gives a single row when there are no tiers anywhere', () => {
    const rows = priceLadderForContract({
      baseUnitPriceCents: 10000,
      moq: 1,
      catalogTiers: [],
      card: null,
    });

    expect(rows.map((row) => [row.quantity, row.source])).toEqual([[1, 'CATALOG_BASE']]);
  });
});
