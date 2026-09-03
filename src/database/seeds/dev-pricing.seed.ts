import type { PrismaClient } from '@prisma/client';
import { createId } from '@/common';
import { loadConfig } from '@/config';

/**
 * A live contract for the demo tenant.
 *
 * One ACTIVE card so the shop quotes something other than list price, and one
 * DRAFT so the admin screen has both states to render — a card list where every
 * row says ACTIVE tells you nothing about whether the status column works.
 *
 * The item terms deliberately cover all three rules the pricing engine
 * arbitrates between (see `rate-card-pricing.ts`): a fixed price that ignores
 * every ladder, a per-product discount that overrides the card default, and a
 * contract volume ladder. Anything the card does not name falls to
 * `defaultDiscountPercent`.
 *
 * Idempotent: the card is keyed on account + name, and its items are replaced.
 */

const ACCOUNT_SLUG = 'apex-healthcare-group';

const ACTIVE_CARD = {
  name: 'Apex 2026 Enterprise Tier A',
  notes: 'Group agreement, renewed annually. 12% off list with negotiated print lines.',
  defaultDiscountPercent: '12.00',
};

const DRAFT_CARD = {
  name: 'Apex 2027 Renewal (in negotiation)',
  notes: 'Draft terms for the 2027 renewal. Prices nothing until activated.',
  defaultDiscountPercent: '15.00',
};

interface SeedItem {
  readonly sku: string;
  /** Absolute contract price, ignoring every ladder. */
  readonly fixedPrice?: string;
  /** Percentage off list, overriding the card default for this product. */
  readonly discountPercent?: string;
  readonly tiers?: readonly { minQuantity: number; discountPercent: string }[];
}

const ACTIVE_ITEMS: readonly SeedItem[] = [
  // A negotiated flat rate: £58.00 a pack whatever the quantity.
  { sku: 'SGN-YARD-CORO-1824', fixedPrice: '58.00' },
  // A better-than-default discount, with its own contract ladder on top.
  {
    sku: 'BAN-ROLLUP-3380',
    discountPercent: '18.00',
    tiers: [
      { minQuantity: 5, discountPercent: '22.00' },
      { minQuantity: 20, discountPercent: '28.00' },
    ],
  },
  // Discount only — the catalogue ladder does not apply once a contract does.
  { sku: 'CRD-SOFT-TOUCH-500', discountPercent: '20.00' },
  // A ladder with no headline discount: list price until the volume is met.
  {
    sku: 'FLY-TRI-FOLD-1000',
    tiers: [
      { minQuantity: 4, discountPercent: '15.00' },
      { minQuantity: 12, discountPercent: '25.00' },
    ],
  },
];

export async function seedDevPricing(prisma: PrismaClient): Promise<void> {
  if (loadConfig().app.isProduction) {
    throw new Error('The development seed refuses to run against a production configuration.');
  }

  const account = await prisma.account.findUnique({ where: { slug: ACCOUNT_SLUG } });
  if (!account) {
    console.log('[seed] pricing: demo account missing — run the user seed first. Skipped.');
    return;
  }

  const admin = await prisma.user.findUnique({ where: { login: 'dev.admin' } });

  // Runs from the start of last month so the card is unambiguously in force,
  // and open-ended so it never quietly expires while someone is demoing.
  const effectiveFrom = new Date();
  effectiveFrom.setUTCMonth(effectiveFrom.getUTCMonth() - 1, 1);
  effectiveFrom.setUTCHours(0, 0, 0, 0);

  const activeId = await upsertCard(prisma, {
    accountId: account.id,
    createdById: admin?.id ?? null,
    ...ACTIVE_CARD,
    status: 'ACTIVE',
    effectiveFrom,
  });

  // The renewal starts where an open-ended card would otherwise overlap it.
  // It is a DRAFT, so the overlap constraint does not arbitrate between them —
  // activating it is what would force the current card to be closed off first.
  const renewalFrom = new Date(Date.UTC(effectiveFrom.getUTCFullYear() + 1, 0, 1));
  await upsertCard(prisma, {
    accountId: account.id,
    createdById: admin?.id ?? null,
    ...DRAFT_CARD,
    status: 'DRAFT',
    effectiveFrom: renewalFrom,
  });

  await replaceItems(prisma, activeId, ACTIVE_ITEMS);

  console.log(
    `[seed] pricing: 1 active card (${ACTIVE_CARD.name}) with ${ACTIVE_ITEMS.length} ` +
      `negotiated lines, 1 draft renewal`,
  );
}

async function upsertCard(
  prisma: PrismaClient,
  card: {
    accountId: string;
    createdById: string | null;
    name: string;
    notes: string;
    status: 'DRAFT' | 'ACTIVE';
    effectiveFrom: Date;
    defaultDiscountPercent: string;
  },
): Promise<string> {
  const existing = await prisma.rateCard.findFirst({
    where: { accountId: card.accountId, name: card.name, deletedAt: null },
    select: { id: true },
  });

  const fields = {
    name: card.name,
    notes: card.notes,
    status: card.status,
    effectiveFrom: card.effectiveFrom,
    effectiveTo: null,
    defaultDiscountPercent: card.defaultDiscountPercent,
    createdById: card.createdById,
    deletedAt: null,
  };

  if (existing) {
    await prisma.rateCard.update({ where: { id: existing.id }, data: fields });
    return existing.id;
  }

  const created = await prisma.rateCard.create({
    data: { id: createId('rct'), accountId: card.accountId, ...fields },
  });
  return created.id;
}

async function replaceItems(
  prisma: PrismaClient,
  rateCardId: string,
  items: readonly SeedItem[],
): Promise<void> {
  // Cascades to the tiers. Replaced wholesale so a line removed from this seed
  // does not linger on a card that was seeded by an earlier version of it.
  await prisma.rateCardItem.deleteMany({ where: { rateCardId } });

  for (const item of items) {
    const product = await prisma.product.findUnique({
      where: { sku: item.sku },
      select: { id: true },
    });
    if (!product) continue;

    const row = await prisma.rateCardItem.create({
      data: {
        id: createId('rci'),
        rateCardId,
        productId: product.id,
        fixedPrice: item.fixedPrice ?? null,
        discountPercent: item.discountPercent ?? null,
      },
    });

    if (item.tiers?.length) {
      await prisma.rateCardTier.createMany({
        data: item.tiers.map((tier) => ({
          id: createId('rtr'),
          rateCardItemId: row.id,
          minQuantity: tier.minQuantity,
          discountPercent: tier.discountPercent,
        })),
      });
    }
  }
}
