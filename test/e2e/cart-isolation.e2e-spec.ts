import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService, withTenantScope } from '@/database';

/**
 * The cart guarantees that live in the database rather than in TypeScript.
 *
 * 1. `cart_lines` carries no `accountId` and is policied through its parent,
 *    the same shape as `rate_card_items`. Worth proving separately: if the
 *    EXISTS subquery were wrong, one customer would read another's basket —
 *    including the personalisation on it — while `carts` still looked isolated.
 *
 * 2. One OPEN basket per user per branch, as a partial unique index with
 *    NULLS NOT DISTINCT. A read-then-create check races with itself on a
 *    double-tap, and the second basket silently swallows half the order.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('cart isolation and single-basket rule (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const siteA = createId('sit');
  const userA = createId('usr');
  const userB = createId('usr');
  const categoryId = createId('cat');
  const productId = createId('prd');
  const cartA = createId('crt');
  const cartB = createId('crt');
  const lineA = createId('crl');
  const lineB = createId('crl');

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    await prisma.account.createMany({
      data: [
        { id: accountA, slug: `ct-a-${suffix}`, accountCode: `CT-A-${suffix}`, name: 'Cart A' },
        { id: accountB, slug: `ct-b-${suffix}`, accountCode: `CT-B-${suffix}`, name: 'Cart B' },
      ],
    });

    await prisma.site.create({
      data: { id: siteA, accountId: accountA, code: `A-${suffix}`, name: 'Branch A' },
    });

    await prisma.user.createMany({
      data: [
        {
          id: userA,
          accountId: accountA,
          siteId: siteA,
          userType: 'NEW',
          login: `ct-a-${suffix}`,
          loginDisplay: `ct-a-${suffix}`,
          email: `ct-a-${suffix}@example.test`,
          firstName: 'A',
          lastName: 'Buyer',
          role: 'SITE_USER',
        },
        {
          id: userB,
          accountId: accountB,
          userType: 'NEW',
          login: `ct-b-${suffix}`,
          loginDisplay: `ct-b-${suffix}`,
          email: `ct-b-${suffix}@example.test`,
          firstName: 'B',
          lastName: 'Buyer',
          role: 'SITE_USER',
        },
      ],
    });

    await prisma.productCategory.create({
      data: { id: categoryId, code: `CT-${suffix}`, name: 'Cart fixtures' },
    });
    await prisma.product.create({
      data: {
        id: productId,
        sku: `CT-SKU-${suffix}`,
        name: 'Cart fixture',
        categoryId,
        basePrice: '10.00',
      },
    });

    await prisma.cart.createMany({
      data: [
        { id: cartA, accountId: accountA, userId: userA, siteId: siteA, status: 'OPEN' },
        { id: cartB, accountId: accountB, userId: userB, siteId: null, status: 'OPEN' },
      ],
    });

    await prisma.cartLine.createMany({
      data: [
        { id: lineA, cartId: cartA, productId, quantity: 10 },
        {
          id: lineB,
          cartId: cartB,
          productId,
          quantity: 20,
          customisation: { 'Staff name': 'Confidential' },
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.cart.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.user.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.site.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.product.deleteMany({ where: { id: productId } });
    await prisma?.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma?.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await prisma?.$disconnect();
  });

  it("hides another account's basket", async () => {
    const carts = await withTenantScope(prisma, accountA, (tx) =>
      tx.cart.findMany({ select: { id: true } }),
    );

    expect(carts.map((cart) => cart.id)).toEqual([cartA]);
  });

  it("hides another account's lines, which carry no accountId of their own", async () => {
    const lines = await withTenantScope(prisma, accountA, (tx) =>
      tx.cartLine.findMany({ select: { id: true } }),
    );

    expect(lines.map((line) => line.id)).toEqual([lineA]);
  });

  it("hides another account's personalisation from a lookup by primary key", async () => {
    const line = await withTenantScope(prisma, accountA, (tx) =>
      tx.cartLine.findUnique({ where: { id: lineB } }),
    );

    expect(line).toBeNull();
  });

  it("refuses to add a line to another account's basket", async () => {
    // The WITH CHECK half. Without it the policy would block reads while
    // leaving the more damaging direction — writing into someone else's
    // basket — open.
    await expect(
      withTenantScope(prisma, accountA, (tx) =>
        tx.cartLine.create({
          data: { id: createId('crl'), cartId: cartB, productId, quantity: 1 },
        }),
      ),
    ).rejects.toThrow();
  });

  it("cannot change another account's line", async () => {
    const result = await withTenantScope(prisma, accountA, (tx) =>
      tx.cartLine.updateMany({ where: { id: lineB }, data: { quantity: 999 } }),
    );

    expect(result.count).toBe(0);

    const untouched = await prisma.cartLine.findUniqueOrThrow({ where: { id: lineB } });
    expect(untouched.quantity).toBe(20);
  });

  it('refuses a second open basket for the same user and branch', async () => {
    await expect(
      prisma.cart.create({
        data: { id: createId('crt'), accountId: accountA, userId: userA, siteId: siteA },
      }),
    ).rejects.toThrow();
  });

  it('refuses a second unbranched basket, which NULLS NOT DISTINCT is for', async () => {
    // Without NULLS NOT DISTINCT, PostgreSQL treats every NULL as unique and a
    // head-office user could accumulate unlimited unbranched baskets.
    await expect(
      prisma.cart.create({
        data: { id: createId('crt'), accountId: accountB, userId: userB, siteId: null },
      }),
    ).rejects.toThrow();
  });

  it('allows one basket per branch for the same user', async () => {
    const otherSite = createId('sit');
    const otherCart = createId('crt');
    await prisma.site.create({
      data: { id: otherSite, accountId: accountA, code: `A2-${suffix}`, name: 'Branch A2' },
    });

    await expect(
      prisma.cart.create({
        data: { id: otherCart, accountId: accountA, userId: userA, siteId: otherSite },
      }),
    ).resolves.toMatchObject({ id: otherCart });
  });

  it('allows a new basket once the old one is checked out', async () => {
    // The index is partial on OPEN, so history never blocks the next order.
    await prisma.cart.update({
      where: { id: cartA },
      data: { status: 'CHECKED_OUT', checkedOutAt: new Date() },
    });

    const next = createId('crt');
    await expect(
      prisma.cart.create({
        data: { id: next, accountId: accountA, userId: userA, siteId: siteA },
      }),
    ).resolves.toMatchObject({ id: next });
  });

  it('refuses a zero-quantity line rather than pricing it at nothing', async () => {
    await expect(
      prisma.cartLine.create({
        data: { id: createId('crl'), cartId: cartB, productId, quantity: 0 },
      }),
    ).rejects.toThrow();
  });
});
