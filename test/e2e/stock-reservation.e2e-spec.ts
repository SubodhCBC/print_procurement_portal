import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService } from '@/database';
import { StockService } from '@/modules/catalog';

/**
 * The reservation guarantees, exercised against a real database.
 *
 * These cannot be unit-tested: the whole mechanism is a conditional UPDATE and
 * a CHECK constraint, and an in-memory double would be testing the double.
 *
 * The one that matters most is the race. Two buyers taking the last unit at the
 * same instant is not an exotic case — it is what a promotion looks like — and
 * a read-then-write check passes for both of them.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('stock reservation (e2e)', () => {
  let prisma: PrismaService;
  const stock = new StockService();

  const suffix = Date.now().toString(36);
  const categoryId = createId('cat');
  const tracked = createId('prd');
  const untracked = createId('prd');

  const shelf = async (id: string) =>
    prisma.product.findUniqueOrThrow({
      where: { id },
      select: { stockOnHand: true, stockReserved: true },
    });

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    await prisma.productCategory.create({
      data: { id: categoryId, code: `SR-${suffix}`, name: 'Stock fixtures' },
    });

    await prisma.product.createMany({
      data: [
        {
          id: tracked,
          sku: `SR-TRACKED-${suffix}`,
          name: 'Tracked',
          categoryId,
          basePrice: '10.00',
          trackInventory: true,
          stockOnHand: 3,
        },
        {
          id: untracked,
          sku: `SR-POD-${suffix}`,
          name: 'Made to order',
          categoryId,
          basePrice: '10.00',
          trackInventory: false,
          stockOnHand: 0,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.product.deleteMany({ where: { id: { in: [tracked, untracked] } } });
    await prisma?.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma?.$disconnect();
  });

  const line = (productId: string, quantity: number) => ({
    productId,
    variantId: null,
    quantity,
    sku: 'X',
  });

  it('holds stock and reduces what is available', async () => {
    const held = await prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 2)]));

    expect(held).toBe(true);
    expect(await shelf(tracked)).toEqual({ stockOnHand: 3, stockReserved: 2 });
  });

  it('refuses more than is available, even though the shelf still holds it', async () => {
    // One left, two asked for. The shelf says three, which is exactly the
    // reading that oversells.
    await expect(
      prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 2)])),
    ).rejects.toThrow(/available/);
  });

  it('lets the last unit go to one taker', async () => {
    const held = await prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 1)]));

    expect(held).toBe(true);
    expect(await shelf(tracked)).toEqual({ stockOnHand: 3, stockReserved: 3 });
  });

  it('is now empty', async () => {
    await expect(
      prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 1)])),
    ).rejects.toThrow(/out of stock/);
  });

  it('releases what an order was holding', async () => {
    await prisma.$transaction((tx) => stock.release(tx, [line(tracked, 3)]));

    expect(await shelf(tracked)).toEqual({ stockOnHand: 3, stockReserved: 0 });
  });

  it('takes shipped goods off the shelf and off the reservation together', async () => {
    await prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 2)]));
    await prisma.$transaction((tx) => stock.consume(tx, [line(tracked, 2)]));

    expect(await shelf(tracked)).toEqual({ stockOnHand: 1, stockReserved: 0 });
  });

  it('reserves nothing for a product that does not track stock', async () => {
    const held = await prisma.$transaction((tx) => stock.reserve(tx, [line(untracked, 1_000_000)]));

    expect(held).toBe(false);
    expect(await shelf(untracked)).toEqual({ stockOnHand: 0, stockReserved: 0 });
  });

  it('rolls back every line when one of them cannot be filled', async () => {
    // A partially reserved order is not a state anything downstream knows how
    // to read, so the transaction takes the whole thing back.
    await prisma.product.update({ where: { id: tracked }, data: { stockOnHand: 5 } });

    await expect(
      prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 4), line(tracked, 4)])),
    ).rejects.toThrow();

    expect((await shelf(tracked)).stockReserved).toBe(0);
  });

  it('gives the last unit to exactly one of two simultaneous takers', async () => {
    // The reason this feature exists. Both transactions start before either
    // commits; PostgreSQL serialises them on the row lock, and the conditional
    // UPDATE means the loser's WHERE clause no longer matches.
    await prisma.product.update({
      where: { id: tracked },
      data: { stockOnHand: 1, stockReserved: 0 },
    });

    const attempts = await Promise.allSettled([
      prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 1)])),
      prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 1)])),
    ]);

    const won = attempts.filter((a) => a.status === 'fulfilled').length;
    const lost = attempts.filter((a) => a.status === 'rejected').length;

    expect(won).toBe(1);
    expect(lost).toBe(1);
    expect(await shelf(tracked)).toEqual({ stockOnHand: 1, stockReserved: 1 });
  });

  it('survives ten simultaneous takers over three units', async () => {
    await prisma.product.update({
      where: { id: tracked },
      data: { stockOnHand: 3, stockReserved: 0 },
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        prisma.$transaction((tx) => stock.reserve(tx, [line(tracked, 1)])),
      ),
    );

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(3);
    expect(await shelf(tracked)).toEqual({ stockOnHand: 3, stockReserved: 3 });
  });

  it('refuses to let a reservation exceed the shelf, whatever writes it', async () => {
    // The backstop. If the conditional UPDATE were ever written wrongly, this
    // is what turns an oversell into a loud failure.
    await expect(
      prisma.product.update({ where: { id: tracked }, data: { stockReserved: 99 } }),
    ).rejects.toThrow();
  });

  it('refuses a negative reservation', async () => {
    await expect(
      prisma.product.update({ where: { id: tracked }, data: { stockReserved: -1 } }),
    ).rejects.toThrow();
  });

  it('refuses a stocktake that drops the shelf below what is promised', async () => {
    // Three are promised; writing two would make available negative. The
    // reconciliation endpoint reports this as a variance rather than letting
    // the database refuse it, but the constraint is what makes that safe.
    await expect(
      prisma.product.update({ where: { id: tracked }, data: { stockOnHand: 2 } }),
    ).rejects.toThrow();
  });
});
