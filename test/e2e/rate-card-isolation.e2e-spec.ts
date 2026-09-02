import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService, withTenantScope } from '@/database';

/**
 * The two guarantees rate cards rest on that live in the database rather than
 * in TypeScript, and that no unit test can reach.
 *
 * 1. `rate_card_items` and `rate_card_tiers` carry no `accountId`. They are
 *    policied through an EXISTS on their parent, and that indirection is the
 *    part worth proving: if the subquery were wrong, one customer would read
 *    another's negotiated prices while the parent table still looked isolated.
 *
 * 2. At most one ACTIVE card per account per instant, enforced by an EXCLUDE
 *    constraint rather than by a check in the service. A read-then-write check
 *    passes for both of two administrators activating at the same moment.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('rate card isolation and overlap (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const categoryId = createId('cat');
  const productId = createId('prd');
  const cardA = createId('rc');
  const cardB = createId('rc');
  const itemA = createId('rci');
  const itemB = createId('rci');
  const tierA = createId('rct');

  const january = new Date('2030-01-01T00:00:00.000Z');
  const july = new Date('2030-07-01T00:00:00.000Z');
  const nextJanuary = new Date('2031-01-01T00:00:00.000Z');

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    // Seeded through the unscoped client, which connects as the table owner and
    // is exempt from the policies — the same exemption the login path relies on.
    await prisma.account.createMany({
      data: [
        { id: accountA, slug: `rc-a-${suffix}`, accountCode: `RC-A-${suffix}`, name: 'RC A' },
        { id: accountB, slug: `rc-b-${suffix}`, accountCode: `RC-B-${suffix}`, name: 'RC B' },
      ],
    });

    await prisma.productCategory.create({
      data: { id: categoryId, code: `RC-${suffix}`, name: 'Rate card fixtures' },
    });

    await prisma.product.create({
      data: {
        id: productId,
        sku: `RC-SKU-${suffix}`,
        name: 'Rate card fixture',
        categoryId,
        basePrice: '100.00',
      },
    });

    await prisma.rateCard.createMany({
      data: [
        {
          id: cardA,
          accountId: accountA,
          name: 'A contract',
          status: 'ACTIVE',
          effectiveFrom: january,
          effectiveTo: july,
        },
        {
          id: cardB,
          accountId: accountB,
          name: 'B contract',
          status: 'DRAFT',
          effectiveFrom: january,
        },
      ],
    });

    await prisma.rateCardItem.createMany({
      data: [
        { id: itemA, rateCardId: cardA, productId, fixedPrice: '11.00' },
        { id: itemB, rateCardId: cardB, productId, fixedPrice: '22.00' },
      ],
    });

    await prisma.rateCardTier.create({
      data: { id: tierA, rateCardItemId: itemA, minQuantity: 100, discountPercent: '10' },
    });
  });

  afterAll(async () => {
    await prisma?.rateCard.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.product.deleteMany({ where: { id: productId } });
    await prisma?.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma?.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await prisma?.$disconnect();
  });

  it("hides another account's rate card", async () => {
    const cards = await withTenantScope(prisma, accountA, (tx) =>
      tx.rateCard.findMany({ select: { id: true } }),
    );

    expect(cards.map((card) => card.id)).toEqual([cardA]);
  });

  it("hides another account's items, which carry no accountId of their own", async () => {
    // The assertion the EXISTS policy exists for. An unfiltered read of every
    // rate card item in the database must return only this tenant's.
    const items = await withTenantScope(prisma, accountA, (tx) =>
      tx.rateCardItem.findMany({ select: { id: true, fixedPrice: true } }),
    );

    expect(items.map((item) => item.id)).toEqual([itemA]);
  });

  it("hides another account's item from a lookup by primary key", async () => {
    const item = await withTenantScope(prisma, accountA, (tx) =>
      tx.rateCardItem.findUnique({ where: { id: itemB } }),
    );

    expect(item).toBeNull();
  });

  it("hides another account's tiers, two levels from the tenant column", async () => {
    const tiers = await withTenantScope(prisma, accountB, (tx) =>
      tx.rateCardTier.findMany({ select: { id: true } }),
    );

    expect(tiers).toEqual([]);
  });

  it("refuses to attach an item to another account's card", async () => {
    // The WITH CHECK half. Without it the policy would block reads while
    // leaving the more damaging direction — writing a price into someone
    // else's contract — wide open.
    await expect(
      withTenantScope(prisma, accountA, (tx) =>
        tx.rateCardItem.create({
          data: { id: createId('rci'), rateCardId: cardB, productId, fixedPrice: '1.00' },
        }),
      ),
    ).rejects.toThrow();
  });

  it("cannot update another account's item", async () => {
    const result = await withTenantScope(prisma, accountA, (tx) =>
      tx.rateCardItem.updateMany({ where: { id: itemB }, data: { fixedPrice: '0.01' } }),
    );

    expect(result.count).toBe(0);

    const untouched = await prisma.rateCardItem.findUniqueOrThrow({ where: { id: itemB } });
    expect(untouched.fixedPrice?.toFixed(2)).toBe('22.00');
  });

  it('refuses a second active card overlapping the first', async () => {
    await expect(
      prisma.rateCard.create({
        data: {
          id: createId('rc'),
          accountId: accountA,
          name: 'Overlapping',
          status: 'ACTIVE',
          // Starts inside the January–July window already active.
          effectiveFrom: new Date('2030-03-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
  });

  it('allows a card that starts exactly when the other ends', async () => {
    // The upper bound is exclusive, so July 1st belongs to the successor alone.
    // If it were inclusive, no contract could ever be renewed without a gap.
    const successor = createId('rc');

    await expect(
      prisma.rateCard.create({
        data: {
          id: successor,
          accountId: accountA,
          name: 'Successor',
          status: 'ACTIVE',
          effectiveFrom: july,
          effectiveTo: nextJanuary,
        },
      }),
    ).resolves.toMatchObject({ id: successor });
  });

  it('allows several drafts to overlap, because only one may be live', async () => {
    const draft = createId('rc');

    await expect(
      prisma.rateCard.create({
        data: {
          id: draft,
          accountId: accountA,
          name: 'Under negotiation',
          status: 'DRAFT',
          effectiveFrom: january,
          effectiveTo: july,
        },
      }),
    ).resolves.toMatchObject({ id: draft });
  });

  it('lets another account hold its own card over the same period', async () => {
    // The constraint is per account. Every customer having a contract for the
    // same year is the normal case, not a collision.
    await expect(
      prisma.rateCard.update({ where: { id: cardB }, data: { status: 'ACTIVE' } }),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
  });
});
