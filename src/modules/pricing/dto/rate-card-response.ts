import type { PricingRateCard, QuotedLine } from '../pricing.service';
import type { FullRateCard, RateCardItemRow, RateCardSummary } from '../rate-cards.service';
import {
  priceForContract,
  type ContractPriceBreakdown,
  type PriceSource,
} from '../rate-card-pricing';

/**
 * A rate card as the API exposes it.
 *
 * Matches the reference portal's `RateCard` shape — `accountName`, `itemCount`,
 * `defaultDiscountPct` — with the conventions this codebase keeps: money and
 * percentages as strings, because both are NUMERIC columns that a JSON parser
 * would round, and explicit whitelists rather than spreading the row.
 */
export interface RateCardView {
  readonly id: string;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly name: string;
  readonly notes: string | null;
  readonly status: RateCardSummary['status'];
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly defaultDiscountPercent: string;
  /** Whether the card prices anything at the instant it was read. */
  readonly isInForce: boolean;
  readonly itemCount: number;
  readonly createdById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Present only on the single-card read. */
  readonly items?: readonly RateCardItemView[];
}

export interface RateCardItemView {
  readonly id: string;
  readonly productId: string;
  readonly productSku: string;
  readonly productName: string;
  readonly uom: RateCardItemRow['product']['uom'];
  readonly basePrice: string;
  readonly fixedPrice: string | null;
  readonly discountPercent: string | null;
  readonly tiers: readonly RateCardItemTierView[];
  /**
   * The unit price this item produces at the product's minimum order quantity,
   * with the rule that produced it.
   *
   * Priced at the MOQ rather than at 1 because that is the smallest quantity
   * the product can actually be bought in, so it is the first number a buyer
   * will ever see. Quoting at 1 would show a price nobody can order at.
   */
  readonly effectivePrice: string;
  readonly effectiveAtQuantity: number;
  readonly source: PriceSource;
  /**
   * True when this line prices *above* the public catalogue price at the MOQ —
   * a negotiated rate that is worse than list. Surfaced rather than silently
   * corrected; see the note at the top of rate-card-pricing.ts.
   */
  readonly aboveCatalogPrice: boolean;
}

export interface RateCardItemTierView {
  readonly minQuantity: number;
  readonly discountPercent: string;
}

export function toRateCardView(
  card: RateCardSummary | FullRateCard,
  at: Date = new Date(),
): RateCardView {
  const items = 'items' in card ? card.items : undefined;

  return {
    id: card.id,
    accountId: card.accountId,
    accountCode: card.account.accountCode,
    accountName: card.account.name,
    name: card.name,
    notes: card.notes,
    status: card.status,
    effectiveFrom: card.effectiveFrom.toISOString(),
    effectiveTo: card.effectiveTo?.toISOString() ?? null,
    defaultDiscountPercent: card.defaultDiscountPercent.toFixed(2),
    isInForce: isInForce(card, at),
    itemCount: card._count.items,
    createdById: card.createdById,
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
    ...(items ? { items: items.map((item) => toRateCardItemView(item, card)) } : {}),
  };
}

/**
 * Whether a card is pricing anything right now.
 *
 * Computed rather than stored: a stored flag would need a scheduled job to flip
 * it the minute a card expires, and a card that was still marked "in force" for
 * an hour after midnight would keep quoting an expired contract.
 */
function isInForce(card: RateCardSummary | FullRateCard, at: Date): boolean {
  if (card.status !== 'ACTIVE' || card.deletedAt) return false;
  if (card.effectiveFrom > at) return false;
  // Exclusive upper bound, matching the EXCLUDE constraint's `[)` range.
  return card.effectiveTo == null || card.effectiveTo > at;
}

export function toRateCardItemView(
  item: RateCardItemRow,
  card: { defaultDiscountPercent: { toFixed(digits: number): string }; id: string; name: string },
): RateCardItemView {
  const quantity = Math.max(1, item.product.moq ?? 1);
  const breakdown = priceForContract({
    baseUnitPriceCents: toCents(item.product.basePrice),
    quantity,
    // The item view prices the *contract* line. The catalogue ladder is left
    // out on purpose: what this column answers is "what did we negotiate",
    // and the comparison it draws is against list, not against the public
    // volume break — which is a different question the quote endpoint answers.
    catalogTiers: [],
    card: {
      id: card.id,
      name: card.name,
      defaultDiscountPercent: Number(card.defaultDiscountPercent.toFixed(2)),
      item: {
        fixedPriceCents: item.fixedPrice == null ? null : toCents(item.fixedPrice),
        discountPercent: item.discountPercent == null ? null : Number(item.discountPercent),
        tiers: item.tiers.map((tier) => ({
          minQuantity: tier.minQuantity,
          discountPercent: Number(tier.discountPercent),
        })),
      },
    },
  });

  return {
    id: item.id,
    productId: item.productId,
    productSku: item.product.sku,
    productName: item.product.name,
    uom: item.product.uom,
    basePrice: item.product.basePrice.toFixed(2),
    fixedPrice: item.fixedPrice?.toFixed(2) ?? null,
    discountPercent: item.discountPercent?.toFixed(2) ?? null,
    tiers: item.tiers.map((tier) => ({
      minQuantity: tier.minQuantity,
      discountPercent: tier.discountPercent.toFixed(2),
    })),
    effectivePrice: fromCents(breakdown.unitPriceCents),
    effectiveAtQuantity: quantity,
    source: breakdown.source,
    aboveCatalogPrice: breakdown.aboveCatalogPrice,
  };
}

/** One priced line, as the quote endpoint returns it. */
export interface QuotedLineView {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: QuotedLine['uom'];
  readonly moq: number;
  readonly orderMultiple: number;
  readonly quantity: number;
  readonly basePrice: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly discountPercent: string;
  readonly source: PriceSource;
  readonly rateCardId: string | null;
  readonly rateCardName: string | null;
  /** What the line would cost with no rate card, for the "you save" line. */
  readonly catalogUnitPrice: string;
  readonly catalogLineTotal: string;
  readonly saving: string;
  readonly aboveCatalogPrice: boolean;
  readonly appliedMinQuantity: number | null;
  /** The whole ladder as this account sees it, for the volume table. */
  readonly ladder: readonly QuotedTierView[];
}

export interface QuotedTierView {
  readonly minQuantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly discountPercent: string;
  readonly source: PriceSource;
}

export function toQuotedLineView(line: QuotedLine): QuotedLineView {
  const { breakdown } = line;

  return {
    productId: line.productId,
    sku: line.sku,
    name: line.name,
    uom: line.uom,
    moq: line.moq,
    orderMultiple: line.orderMultiple,
    quantity: breakdown.quantity,
    basePrice: fromCents(breakdown.baseUnitPriceCents),
    unitPrice: fromCents(breakdown.unitPriceCents),
    lineTotal: fromCents(breakdown.lineTotalCents),
    discountPercent: breakdown.discountPercent.toFixed(2),
    source: breakdown.source,
    rateCardId: breakdown.rateCardId,
    rateCardName: breakdown.rateCardName,
    catalogUnitPrice: fromCents(breakdown.catalogUnitPriceCents),
    catalogLineTotal: fromCents(breakdown.catalogLineTotalCents),
    // Signed: negative means the contract prices this line above list, which is
    // a number worth being able to see rather than clamping to zero.
    saving: fromCents(breakdown.savingCents),
    aboveCatalogPrice: breakdown.aboveCatalogPrice,
    appliedMinQuantity: breakdown.appliedTier?.minQuantity ?? null,
    ladder: line.ladder.map(toQuotedTierView),
  };
}

function toQuotedTierView(row: ContractPriceBreakdown): QuotedTierView {
  return {
    minQuantity: row.quantity,
    unitPrice: fromCents(row.unitPriceCents),
    lineTotal: fromCents(row.lineTotalCents),
    discountPercent: row.discountPercent.toFixed(2),
    source: row.source,
  };
}

/** The "your pricing" banner: which contract is quoting this customer. */
export interface ActiveRateCardView {
  readonly id: string;
  readonly name: string;
  readonly defaultDiscountPercent: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export function toActiveRateCardView(card: PricingRateCard | null): ActiveRateCardView | null {
  if (!card) return null;
  return {
    id: card.id,
    name: card.name,
    defaultDiscountPercent: card.defaultDiscountPercent.toFixed(2),
    effectiveFrom: card.effectiveFrom.toISOString(),
    effectiveTo: card.effectiveTo?.toISOString() ?? null,
  };
}

function toCents(value: { toFixed(digits: number): string }): number {
  return Math.round(Number(value.toFixed(2)) * 100);
}

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
