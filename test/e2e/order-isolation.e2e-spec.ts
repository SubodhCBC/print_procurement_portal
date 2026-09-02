import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService, withTenantScope } from '@/database';

/**
 * The order guarantees that live in the database.
 *
 * 1. `order_line_items` and `order_status_events` carry no `accountId` and are
 *    policied through the parent. Worth proving separately: the line items hold
 *    what a customer paid per unit, which is the most commercially sensitive
 *    row in the system — it is the negotiated price, made concrete.
 *
 * 2. Order numbers are unique and correctly shaped, from a sequence rather than
 *    from application code that could race with itself.
 *
 * 3. The constraints that stop a malformed order existing at all: a rejection
 *    without a reason, a bad billing period, a zero-quantity line.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('order isolation and integrity (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const siteA = createId('sit');
  const siteB = createId('sit');
  const userA = createId('usr');
  const userB = createId('usr');
  const categoryId = createId('cat');
  const productId = createId('prd');
  const orderA = createId('ord');
  const orderB = createId('ord');
  const lineA = createId('oli');
  const lineB = createId('oli');

  const baseOrder = (id: string, accountId: string, siteId: string, userId: string) => ({
    id,
    orderNumber: `ORD-2026-${id.slice(-6)}`,
    accountId,
    siteId,
    placedById: userId,
    placedByName: 'Test Buyer',
    placedByEmail: `${userId}@example.test`,
    status: 'APPROVED' as const,
    subtotal: '100.00',
    catalogSubtotal: '120.00',
    total: '100.00',
    billingPeriod: '2026-09',
    shippingSnapshot: { line1: '1 Test St' },
  });

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    await prisma.account.createMany({
      data: [
        { id: accountA, slug: `od-a-${suffix}`, accountCode: `OD-A-${suffix}`, name: 'Order A' },
        { id: accountB, slug: `od-b-${suffix}`, accountCode: `OD-B-${suffix}`, name: 'Order B' },
      ],
    });

    await prisma.site.createMany({
      data: [
        { id: siteA, accountId: accountA, code: `A-${suffix}`, name: 'Branch A' },
        { id: siteB, accountId: accountB, code: `B-${suffix}`, name: 'Branch B' },
      ],
    });

    await prisma.user.createMany({
      data: [
        {
          id: userA,
          accountId: accountA,
          siteId: siteA,
          userType: 'NEW',
          login: `od-a-${suffix}`,
          loginDisplay: `od-a-${suffix}`,
          email: `od-a-${suffix}@example.test`,
          firstName: 'A',
          lastName: 'Buyer',
          role: 'SITE_USER',
        },
        {
          id: userB,
          accountId: accountB,
          siteId: siteB,
          userType: 'NEW',
          login: `od-b-${suffix}`,
          loginDisplay: `od-b-${suffix}`,
          email: `od-b-${suffix}@example.test`,
          firstName: 'B',
          lastName: 'Buyer',
          role: 'SITE_USER',
        },
      ],
    });

    await prisma.productCategory.create({
      data: { id: categoryId, code: `OD-${suffix}`, name: 'Order fixtures' },
    });
    await prisma.product.create({
      data: {
        id: productId,
        sku: `OD-SKU-${suffix}`,
        name: 'Order fixture',
        categoryId,
        basePrice: '10.00',
      },
    });

    await prisma.order.create({ data: baseOrder(orderA, accountA, siteA, userA) });
    await prisma.order.create({ data: baseOrder(orderB, accountB, siteB, userB) });

    const line = (id: string, orderId: string, unitPrice: string) => ({
      id,
      orderId,
      productId,
      sku: `OD-SKU-${suffix}`,
      name: 'Order fixture',
      uom: 'EACH' as const,
      packSize: 1,
      quantity: 10,
      unitPrice,
      lineTotal: '100.00',
      catalogUnitPrice: '12.00',
      discountPercent: '16.67',
      priceSource: 'CONTRACT_ITEM_DISCOUNT',
    });

    await prisma.orderLineItem.createMany({
      data: [line(lineA, orderA, '10.00'), line(lineB, orderB, '7.50')],
    });

    await prisma.orderStatusEvent.createMany({
      data: [
        {
          id: createId('ose'),
          orderId: orderA,
          toStatus: 'APPROVED',
          actorName: 'A Buyer',
          actorRole: 'SITE_USER',
        },
        {
          id: createId('ose'),
          orderId: orderB,
          toStatus: 'APPROVED',
          actorName: 'B Buyer',
          actorRole: 'SITE_USER',
          comment: 'Confidential note',
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.order.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.user.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.site.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await prisma?.product.deleteMany({ where: { id: productId } });
    await prisma?.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma?.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await prisma?.$disconnect();
  });

  it("hides another account's orders", async () => {
    const orders = await withTenantScope(prisma, accountA, (tx) =>
      tx.order.findMany({ select: { id: true } }),
    );

    expect(orders.map((order) => order.id)).toEqual([orderA]);
  });

  it("hides another account's line items, which hold what they negotiated", async () => {
    const lines = await withTenantScope(prisma, accountA, (tx) =>
      tx.orderLineItem.findMany({ select: { id: true, unitPrice: true } }),
    );

    expect(lines.map((line) => line.id)).toEqual([lineA]);
  });

  it("hides another account's unit price from a lookup by primary key", async () => {
    const line = await withTenantScope(prisma, accountA, (tx) =>
      tx.orderLineItem.findUnique({ where: { id: lineB } }),
    );

    expect(line).toBeNull();
  });

  it("hides another account's status timeline", async () => {
    const events = await withTenantScope(prisma, accountA, (tx) =>
      tx.orderStatusEvent.findMany({ select: { comment: true } }),
    );

    expect(events.map((event) => event.comment)).toEqual([null]);
  });

  it("refuses to add a line to another account's order", async () => {
    await expect(
      withTenantScope(prisma, accountA, (tx) =>
        tx.orderLineItem.create({
          data: {
            id: createId('oli'),
            orderId: orderB,
            productId,
            sku: 'X',
            name: 'X',
            uom: 'EACH',
            packSize: 1,
            quantity: 1,
            unitPrice: '1.00',
            lineTotal: '1.00',
            catalogUnitPrice: '1.00',
            discountPercent: '0',
            priceSource: 'CATALOG_BASE',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("cannot reprice another account's line", async () => {
    const result = await withTenantScope(prisma, accountA, (tx) =>
      tx.orderLineItem.updateMany({ where: { id: lineB }, data: { unitPrice: '0.01' } }),
    );

    expect(result.count).toBe(0);

    const untouched = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: lineB } });
    expect(untouched.unitPrice.toFixed(2)).toBe('7.50');
  });

  it('allocates unique, correctly shaped order numbers', async () => {
    const [first] = await prisma.$queryRaw<[{ n: string }]>`SELECT next_order_number() AS n`;
    const [second] = await prisma.$queryRaw<[{ n: string }]>`SELECT next_order_number() AS n`;

    expect(first.n).toMatch(/^ORD-\d{4}-\d{6}$/);
    expect(second.n).not.toBe(first.n);
  });

  it('refuses a rejected order with no reason', async () => {
    // SOW BE-07 is explicit that a rejection carries a mandatory reason. Held in
    // the database so no code path can produce one that does not say why.
    await expect(
      prisma.order.update({ where: { id: orderA }, data: { status: 'REJECTED' } }),
    ).rejects.toThrow();
  });

  it('accepts a rejection that gives one', async () => {
    await expect(
      prisma.order.update({
        where: { id: orderA },
        data: { status: 'REJECTED', rejectionReason: 'Over budget' },
      }),
    ).resolves.toMatchObject({ status: 'REJECTED' });
  });

  it('refuses a malformed billing period', async () => {
    // A bad period would silently drop the order out of both the monthly
    // invoice and the branch's budget.
    await expect(
      prisma.order.update({ where: { id: orderA }, data: { billingPeriod: '2026-13' } }),
    ).rejects.toThrow();
  });

  it('refuses a zero-quantity line', async () => {
    await expect(
      prisma.orderLineItem.update({ where: { id: lineA }, data: { quantity: 0 } }),
    ).rejects.toThrow();
  });
});
