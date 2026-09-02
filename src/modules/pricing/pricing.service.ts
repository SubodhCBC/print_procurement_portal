import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotFoundError, Role, type AuthenticatedActor } from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { ProductsService, type PriceableProduct } from '@/modules/catalog';
import type { QuoteDto } from './dto/rate-card.dto';
import {
  priceForContract,
  priceLadderForContract,
  type ContractPriceBreakdown,
  type ResolvedRateCard,
} from './rate-card-pricing';

/** The card in force plus only the items the caller asked about. */
const CARD_FOR_PRICING = Prisma.validator<Prisma.RateCardSelect>()({
  id: true,
  name: true,
  defaultDiscountPercent: true,
  effectiveFrom: true,
  effectiveTo: true,
});

export type PricingRateCard = Prisma.RateCardGetPayload<{ select: typeof CARD_FOR_PRICING }>;

export interface QuotedLine {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: PriceableProduct['uom'];
  readonly moq: number;
  readonly orderMultiple: number;
  readonly breakdown: ContractPriceBreakdown;
  /** The ladder as this account sees it, for the volume table on the tile. */
  readonly ladder: readonly ContractPriceBreakdown[];
}

/**
 * What an account actually pays.
 *
 * The read side of BE-04, and the piece BE-05 and BE-06 will call: the cart
 * prices its lines through `quote()`, and an order snapshots the breakdown it
 * returns so a later base-price change cannot rewrite what was ordered.
 *
 * Kept apart from RateCardsService, which administers the contracts. This one
 * only ever reads them, and it is reachable by every signed-in customer, so the
 * separation is also the permission boundary: PRICING_VIEW here,
 * PRICING_MANAGE there.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  /**
   * The one card in force for an account at an instant, or null.
   *
   * "One" is guaranteed by the EXCLUDE constraint on `rate_cards`, not by the
   * `findFirst` here — which is why this can order by `effectiveFrom` and take
   * the first row without the result being arbitrary. If that constraint were
   * ever dropped, this would quietly start picking a winner, so the ordering is
   * deliberate rather than incidental.
   */
  async activeCardFor(accountId: string, at: Date = new Date()): Promise<PricingRateCard | null> {
    return withTenantScope(this.prisma, accountId, (tx) =>
      tx.rateCard.findFirst({
        where: {
          accountId,
          status: 'ACTIVE',
          deletedAt: null,
          effectiveFrom: { lte: at },
          // Exclusive upper bound, matching the `[)` range in the constraint.
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
        select: CARD_FOR_PRICING,
        orderBy: { effectiveFrom: 'desc' },
      }),
    );
  }

  /**
   * Prices a batch of lines for the actor's account.
   *
   * Batched deliberately: a product grid needs every tile priced, and one
   * request per tile would put the rate-card lookup on the critical path fifty
   * times for a single page. The card is read once for the whole batch.
   *
   * A product the actor may not see is left out of the result rather than
   * raising. The caller gets fewer lines than it sent and can say so per row —
   * failing the whole quote because one SKU was unpublished a second ago would
   * blank an entire page.
   */
  async quote(actor: AuthenticatedActor, dto: QuoteDto): Promise<QuotedLine[]> {
    const accountId = this.resolveAccount(actor, dto.accountId);
    // Only an administrator may price against another instant. A customer
    // choosing `at` could quote themselves against an expired contract, or one
    // that has not been signed yet.
    const at = actor.role === Role.ADMIN ? (dto.at ?? new Date()) : new Date();

    const products = await this.products.findPriceable(
      actor,
      dto.lines.map((line) => line.productId),
    );
    const byId = new Map(products.map((product) => [product.id, product]));

    const card = await this.activeCardFor(accountId, at);
    const rules: Map<string, ResolvedRateCard['item']> = card
      ? await this.itemRules(accountId, card.id, [...byId.keys()])
      : new Map<string, ResolvedRateCard['item']>();

    const quoted: QuotedLine[] = [];

    for (const line of dto.lines) {
      const product = byId.get(line.productId);
      if (!product) continue;

      const resolved = toResolvedCard(card, rules.get(product.id) ?? null);
      const catalogTiers = product.volumeTiers.map((tier) => ({
        minQuantity: tier.minQuantity,
        discountPercent: Number(tier.discountPercent),
      }));

      quoted.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        uom: product.uom,
        moq: product.moq,
        orderMultiple: product.orderMultiple,
        breakdown: priceForContract({
          baseUnitPriceCents: toCents(product.basePrice),
          quantity: line.quantity,
          catalogTiers,
          card: resolved,
        }),
        ladder: priceLadderForContract({
          baseUnitPriceCents: toCents(product.basePrice),
          moq: product.moq,
          catalogTiers,
          card: resolved,
        }),
      });
    }

    return quoted;
  }

  /**
   * The card in force for the calling customer, for the "your pricing" banner.
   *
   * Returns null rather than 404 when there is no contract: having no rate card
   * is the ordinary case, not an error.
   */
  async myActiveCard(
    actor: AuthenticatedActor,
    accountId?: string,
  ): Promise<PricingRateCard | null> {
    return this.activeCardFor(this.resolveAccount(actor, accountId));
  }

  /**
   * The terms a card sets for a set of products, keyed by product id.
   *
   * Only the products being priced are read. A contract with two thousand lines
   * should not be loaded whole to price one tile.
   */
  private async itemRules(
    accountId: string,
    rateCardId: string,
    productIds: readonly string[],
  ): Promise<Map<string, ResolvedRateCard['item']>> {
    if (productIds.length === 0) return new Map();

    const items = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.rateCardItem.findMany({
        where: { rateCardId, productId: { in: [...productIds] } },
        select: {
          productId: true,
          fixedPrice: true,
          discountPercent: true,
          tiers: {
            select: { minQuantity: true, discountPercent: true },
            orderBy: { minQuantity: 'asc' },
          },
        },
      }),
    );

    return new Map(
      items.map((item) => [
        item.productId,
        {
          fixedPriceCents: item.fixedPrice == null ? null : toCents(item.fixedPrice),
          discountPercent: item.discountPercent == null ? null : Number(item.discountPercent),
          tiers: item.tiers.map((tier) => ({
            minQuantity: tier.minQuantity,
            discountPercent: Number(tier.discountPercent),
          })),
        },
      ]),
    );
  }

  /**
   * Which account a quote is for.
   *
   * An administrator may price on behalf of a named customer — that is how the
   * rate-card preview works. Everyone else is pinned to their own account,
   * whatever they sent.
   */
  private resolveAccount(actor: AuthenticatedActor, requested?: string): string {
    if (actor.role === Role.ADMIN && requested) return requested;
    if (!actor.accountId) throw new NotFoundError('Account');
    return actor.accountId;
  }
}

function toResolvedCard(
  card: PricingRateCard | null,
  item: ResolvedRateCard['item'],
): ResolvedRateCard | null {
  if (!card) return null;
  return {
    id: card.id,
    name: card.name,
    defaultDiscountPercent: Number(card.defaultDiscountPercent),
    item,
  };
}

/**
 * Decimal to integer cents, via the string form.
 *
 * The same conversion as product-response.ts, and the same reason: Prisma's
 * Decimal is exact and so is its string form, and routing through a float first
 * is the one step that can lose the cent the whole convention exists to
 * protect.
 */
function toCents(value: Prisma.Decimal): number {
  return Math.round(Number(value.toFixed(2)) * 100);
}
