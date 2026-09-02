import { BusinessRuleError } from '@/common';

/**
 * Catalogue-level pricing: the base price and the volume ladder, before any
 * rate card is applied.
 *
 * Deliberately pure and free of Prisma, for two reasons. It is the arithmetic
 * SOW QA-01 asks to be unit-tested ("rate card discount precedence, MOQ
 * rounding, volume discount math"), and BE-04 and BE-05 both need to call it —
 * the rate card engine to show an effective price against the base one, and
 * checkout to price a cart line.
 *
 * Money is handled in integer cents throughout. A unit price of 0.145 at
 * quantity 300 is not representable as a float, and `0.1 + 0.2` arithmetic in
 * an invoice total is the kind of bug that is found by a customer rather than
 * by a test.
 */

export interface VolumeTier {
  readonly minQuantity: number;
  /** Percentage off the base price, 0–100, at most two decimal places. */
  readonly discountPercent: number;
}

export interface PriceInput {
  /** Base price for one sellable unit, in cents. */
  readonly baseUnitPriceCents: number;
  readonly quantity: number;
  readonly tiers: readonly VolumeTier[];
}

export interface PriceBreakdown {
  readonly quantity: number;
  readonly baseUnitPriceCents: number;
  /** The tier that applied, or null when the quantity reached none of them. */
  readonly appliedTier: VolumeTier | null;
  readonly discountPercent: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
  /** What the line would have cost at the base price. */
  readonly savingCents: number;
}

/**
 * The tier that applies to a quantity: the highest `minQuantity` the quantity
 * reaches.
 *
 * Ties cannot happen — `@@unique([productId, minQuantity])` forbids two tiers
 * at the same threshold — but the input here is an array that a caller could
 * have built badly, so the reduce is written to be order-independent rather
 * than assuming the rows arrived sorted.
 */
export function selectTier(quantity: number, tiers: readonly VolumeTier[]): VolumeTier | null {
  let best: VolumeTier | null = null;

  for (const tier of tiers) {
    if (quantity < tier.minQuantity) continue;
    if (best === null || tier.minQuantity > best.minQuantity) best = tier;
  }

  return best;
}

/**
 * Applies a percentage discount to a unit price.
 *
 * Rounded half-up at the *unit* price, before multiplying by quantity. The
 * alternative — discounting the line total — produces a unit price that does
 * not multiply back to the total, and every invoice, ERP export and customer
 * spreadsheet then disagrees with us by a cent.
 */
export function applyDiscount(unitPriceCents: number, discountPercent: number): number {
  if (discountPercent <= 0) return unitPriceCents;

  const discounted = (unitPriceCents * (100 - discountPercent)) / 100;
  // Half-up rather than Math.round, which rounds -0.5 towards zero. Prices are
  // never negative here, but the helper is used by BE-04 for credits later.
  return Math.floor(discounted + 0.5);
}

export function priceLine(input: PriceInput): PriceBreakdown {
  assertPositiveInteger(input.quantity, 'quantity');
  assertNonNegativeInteger(input.baseUnitPriceCents, 'baseUnitPriceCents');

  const appliedTier = selectTier(input.quantity, input.tiers);
  const discountPercent = appliedTier?.discountPercent ?? 0;
  const unitPriceCents = applyDiscount(input.baseUnitPriceCents, discountPercent);

  return {
    quantity: input.quantity,
    baseUnitPriceCents: input.baseUnitPriceCents,
    appliedTier,
    discountPercent,
    unitPriceCents,
    lineTotalCents: unitPriceCents * input.quantity,
    savingCents: (input.baseUnitPriceCents - unitPriceCents) * input.quantity,
  };
}

/**
 * The whole ladder priced out, for the "volume discount pricing" table on the
 * product detail page (FE-03).
 *
 * Each row is priced at its own threshold quantity, which is what the table
 * shows: "100+ … $1.35 each".
 */
export function priceLadder(
  baseUnitPriceCents: number,
  tiers: readonly VolumeTier[],
): readonly PriceBreakdown[] {
  return [...tiers]
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .map((tier) => priceLine({ baseUnitPriceCents, quantity: tier.minQuantity, tiers }));
}

/**
 * Rounds a requested quantity up to something the product can actually be
 * ordered in: at least the MOQ, and on a multiple boundary above it.
 *
 * Rounds *up*, never down. A customer who asked for 120 of something sold in
 * fifties needs 150, not 100 — silently shipping less than they asked for is
 * the worse of the two failures, and BE-05 surfaces the adjustment in the cart
 * rather than applying it invisibly.
 */
export function roundToOrderable(quantity: number, moq: number, orderMultiple: number): number {
  assertPositiveInteger(moq, 'moq');
  assertPositiveInteger(orderMultiple, 'orderMultiple');

  const atLeastMoq = Math.max(quantity, moq);
  if (orderMultiple <= 1) return atLeastMoq;

  // Steps are counted from the MOQ, not from zero: an MOQ of 100 in multiples
  // of 30 gives 100, 130, 160 — not 120, 150, which is what rounding from zero
  // would produce and which no supplier would accept.
  const stepsAbove = Math.ceil((atLeastMoq - moq) / orderMultiple);
  return moq + stepsAbove * orderMultiple;
}

/** Whether a quantity is already orderable without adjustment. */
export function isOrderableQuantity(quantity: number, moq: number, orderMultiple: number): boolean {
  return quantity === roundToOrderable(quantity, moq, orderMultiple);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new BusinessRuleError(`${field} must be a whole number of at least 1`, {
      details: { [field]: value },
    });
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BusinessRuleError(`${field} must be a whole number of at least 0`, {
      details: { [field]: value },
    });
  }
}
