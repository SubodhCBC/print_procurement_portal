import { BusinessRuleError } from '@/common';
import { applyDiscount, priceLine, selectTier, type VolumeTier } from '@/modules/catalog';

/**
 * Contract pricing: what one account actually pays, once its rate card is
 * applied to the catalogue price.
 *
 * Pure, and free of Prisma, for the same reasons `product-pricing.ts` is: this
 * is the arithmetic SOW QA-01 names first ("rate card discount precedence"),
 * and BE-05 (cart) and BE-06 (order line snapshots) both call it. Money stays
 * in integer cents throughout.
 *
 * ---------------------------------------------------------------------------
 * Precedence — first match wins, and nothing compounds
 * ---------------------------------------------------------------------------
 *
 *   1. Contract fixed price      the price, at every quantity. Ladders ignored.
 *   2. Contract volume tier      the card's own ladder for this product.
 *   3. Contract item discount    % off base, for this product.
 *   4. Card default discount     % off base, for anything the card does not name.
 *   5. Catalogue volume tier     the public ladder.
 *   6. Catalogue base price      list.
 *
 * **Discounts never stack.** A contract that says "15% off list" and a public
 * ladder that says "10% off at 1,000" do not combine into 23.5%: the contract
 * replaces the ladder. Compounding is how a negotiated discount quietly becomes
 * a different, larger one at exactly the volumes that matter to margin, and no
 * one reading the signed contract would predict the number that comes out.
 *
 * The cost of that rule is that a contract customer can be quoted *more* than a
 * walk-up customer would pay at high volume, when the public ladder is deeper
 * than the negotiated rate. That is a real thing to get wrong, so it is
 * reported rather than silently corrected: every breakdown carries the
 * catalogue price alongside the contract one and sets `aboveCatalogPrice`. The
 * admin preview surfaces it, so a badly-shaped contract is visible while it is
 * being written instead of after it has been invoiced.
 *
 * Overriding it here — quietly giving the customer the better of the two —
 * would be a pricing policy invented by the pricing engine, and neither the
 * SOW nor a contract says that. It is a decision for whoever signs the deal.
 */

/** One product's terms under a rate card. */
export interface RateCardRule {
  /**
   * The contract price for one sellable unit, in cents. When set, it is the
   * price at every quantity and every ladder is ignored.
   */
  readonly fixedPriceCents: number | null;
  /** Percentage off the base price for this product. Overrides the card default. */
  readonly discountPercent: number | null;
  /**
   * The contract's own volume ladder. Replaces the catalogue ladder outright
   * when non-empty; below its first threshold, the item or card discount
   * applies.
   */
  readonly tiers: readonly VolumeTier[];
}

export interface ResolvedRateCard {
  readonly id: string;
  readonly name: string;
  /** Applied to any product the card does not name explicitly. */
  readonly defaultDiscountPercent: number;
  /** The terms for the product being priced, or null when it is not named. */
  readonly item: RateCardRule | null;
}

export interface ContractPriceInput {
  readonly baseUnitPriceCents: number;
  readonly quantity: number;
  /** The public ladder from the product. */
  readonly catalogTiers: readonly VolumeTier[];
  /** The account's card in force at the moment of the quote, or null. */
  readonly card: ResolvedRateCard | null;
}

/**
 * Which of the six rules above produced the price.
 *
 * Returned on every breakdown and worth keeping: "why is this line 1.08?" is
 * the single most common pricing question, and the alternative is reconstructing
 * the answer from four nullable fields on the client.
 */
export type PriceSource =
  | 'CATALOG_BASE'
  | 'CATALOG_VOLUME_TIER'
  | 'CONTRACT_FIXED_PRICE'
  | 'CONTRACT_VOLUME_TIER'
  | 'CONTRACT_ITEM_DISCOUNT'
  | 'CONTRACT_DEFAULT_DISCOUNT';

export interface ContractPriceBreakdown {
  readonly quantity: number;
  readonly baseUnitPriceCents: number;
  readonly source: PriceSource;
  /**
   * The effective percentage off the base price, whatever produced it. Derived
   * for a fixed price so the UI has one number to show in a "discount" column;
   * two decimal places, because that is what a NUMERIC(5,2) can hold.
   */
  readonly discountPercent: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
  /** The tier that applied, from whichever ladder was in play. */
  readonly appliedTier: VolumeTier | null;
  /** The rate card that produced this, or null when none applied. */
  readonly rateCardId: string | null;
  readonly rateCardName: string | null;
  /** What this line would have cost with no rate card at all. */
  readonly catalogUnitPriceCents: number;
  readonly catalogLineTotalCents: number;
  /** Contract against catalogue. Negative when the contract is the worse deal. */
  readonly savingCents: number;
  /** True when the contract prices this line above the public catalogue price. */
  readonly aboveCatalogPrice: boolean;
}

/**
 * Prices one line for one account.
 *
 * `card` being null — no contract, or none in force today — gives exactly the
 * catalogue answer, so a caller never needs to branch on whether the customer
 * has a rate card.
 */
export function priceForContract(input: ContractPriceInput): ContractPriceBreakdown {
  assertPositiveInteger(input.quantity, 'quantity');
  assertNonNegativeInteger(input.baseUnitPriceCents, 'baseUnitPriceCents');

  // The counterfactual, computed first and always: it is what `savingCents` is
  // measured against and what `aboveCatalogPrice` compares to.
  const catalog = priceLine({
    baseUnitPriceCents: input.baseUnitPriceCents,
    quantity: input.quantity,
    tiers: input.catalogTiers,
  });

  const contract = resolveContract(input);
  const unitPriceCents = contract?.unitPriceCents ?? catalog.unitPriceCents;
  const lineTotalCents = unitPriceCents * input.quantity;

  return {
    quantity: input.quantity,
    baseUnitPriceCents: input.baseUnitPriceCents,
    source: contract?.source ?? (catalog.appliedTier ? 'CATALOG_VOLUME_TIER' : 'CATALOG_BASE'),
    discountPercent: contract
      ? effectiveDiscountPercent(input.baseUnitPriceCents, unitPriceCents)
      : catalog.discountPercent,
    unitPriceCents,
    lineTotalCents,
    appliedTier: contract ? contract.appliedTier : catalog.appliedTier,
    rateCardId: contract ? (input.card?.id ?? null) : null,
    rateCardName: contract ? (input.card?.name ?? null) : null,
    catalogUnitPriceCents: catalog.unitPriceCents,
    catalogLineTotalCents: catalog.lineTotalCents,
    savingCents: catalog.lineTotalCents - lineTotalCents,
    aboveCatalogPrice: unitPriceCents > catalog.unitPriceCents,
  };
}

/**
 * The whole ladder priced out for one account, for the volume table on the
 * product page and for the rate-card preview.
 *
 * The rows are the union of both ladders' thresholds plus the MOQ, because a
 * customer whose contract has a tier at 5,000 and whose product has a public
 * tier at 1,000 needs to see both rows — showing only one ladder would hide
 * whichever break actually applies to them.
 */
export function priceLadderForContract(
  input: Omit<ContractPriceInput, 'quantity'> & { readonly moq: number },
): readonly ContractPriceBreakdown[] {
  const thresholds = new Set<number>([Math.max(1, input.moq)]);
  for (const tier of input.catalogTiers) thresholds.add(tier.minQuantity);
  for (const tier of input.card?.item?.tiers ?? []) thresholds.add(tier.minQuantity);

  return [...thresholds]
    .filter((quantity) => quantity >= input.moq)
    .sort((a, b) => a - b)
    .map((quantity) => priceForContract({ ...input, quantity }));
}

/** What the rate card produces, or null when it has nothing to say. */
function resolveContract(input: ContractPriceInput): {
  unitPriceCents: number;
  source: PriceSource;
  appliedTier: VolumeTier | null;
} | null {
  const card = input.card;
  if (!card) return null;

  const item = card.item;

  // 1. A fixed contract price is the price. Not a floor, not a starting point
  //    for a ladder — the number in the contract, at every quantity.
  if (item?.fixedPriceCents != null) {
    return {
      unitPriceCents: item.fixedPriceCents,
      source: 'CONTRACT_FIXED_PRICE',
      appliedTier: null,
    };
  }

  // 2. The contract's own ladder, when it has one and the quantity reaches it.
  //    Below the first threshold this falls through to the flat discounts,
  //    which is how "15% off, 22% at 5,000" is normally written.
  if (item && item.tiers.length > 0) {
    const tier = selectTier(input.quantity, item.tiers);
    if (tier) {
      return {
        unitPriceCents: applyDiscount(input.baseUnitPriceCents, tier.discountPercent),
        source: 'CONTRACT_VOLUME_TIER',
        appliedTier: tier,
      };
    }
  }

  // 3. A per-product percentage overrides the card default for this product.
  if (item?.discountPercent != null) {
    return {
      unitPriceCents: applyDiscount(input.baseUnitPriceCents, item.discountPercent),
      source: 'CONTRACT_ITEM_DISCOUNT',
      appliedTier: null,
    };
  }

  // 4. The card default, for everything it does not name. A card with a zero
  //    default and no entry for this product says nothing about it, so the
  //    catalogue answers instead — that is the null, not a 0% "contract price".
  if (card.defaultDiscountPercent > 0) {
    return {
      unitPriceCents: applyDiscount(input.baseUnitPriceCents, card.defaultDiscountPercent),
      source: 'CONTRACT_DEFAULT_DISCOUNT',
      appliedTier: null,
    };
  }

  return null;
}

/**
 * The discount a unit price represents, as a percentage of the base.
 *
 * Rounded to two places to match `NUMERIC(5,2)`, and derived rather than stored
 * so a fixed contract price can be shown in the same column as a percentage
 * one. A base price of zero has no meaningful percentage — free is free.
 */
function effectiveDiscountPercent(baseUnitPriceCents: number, unitPriceCents: number): number {
  if (baseUnitPriceCents === 0) return 0;
  const percent = ((baseUnitPriceCents - unitPriceCents) / baseUnitPriceCents) * 100;
  return Math.round(percent * 100) / 100;
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
