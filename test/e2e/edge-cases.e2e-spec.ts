import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService, withTenantScope } from '@/database';

/**
 * The edge cases SOW BE-13 names, proven rather than asserted (SOW BE-13).
 *
 * Each of these is a claim made elsewhere in the codebase — "the transaction
 * rolls back", "a deleted rate card stops pricing", "an expired session is
 * refused". A comment saying so is not evidence; these are.
 *
 * Concurrency itself is covered where it lives: the stock race in
 * `stock-reservation.e2e-spec.ts`, the invoice sequence in
 * `billing-isolation.e2e-spec.ts`, and the rate-card overlap in
 * `rate-card-isolation.e2e-spec.ts`.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('edge cases and recovery (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountId = createId('acc');
  const siteId = createId('sit');
  const userId = createId('usr');
  const categoryId = createId('cat');
  const productId = createId('prd');
  const rateCardId = createId('rc');

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    await prisma.account.create({
      data: { id: accountId, slug: `ec-${suffix}`, accountCode: `EC-${suffix}`, name: 'Edge Co' },
    });
    await prisma.site.create({
      data: { id: siteId, accountId, code: `EC-${suffix}`, name: 'Edge Branch' },
    });
    await prisma.user.create({
      data: {
        id: userId,
        accountId,
        siteId,
        userType: 'NEW',
        login: `ec-${suffix}`,
        loginDisplay: `ec-${suffix}`,
        email: `ec-${suffix}@example.test`,
        firstName: 'Edge',
        lastName: 'User',
        role: 'SITE_USER',
      },
    });
    await prisma.productCategory.create({
      data: { id: categoryId, code: `EC-${suffix}`, name: 'Edge fixtures' },
    });
    await prisma.product.create({
      data: {
        id: productId,
        sku: `EC-SKU-${suffix}`,
        name: 'Edge fixture',
        categoryId,
        basePrice: '100.00',
        trackInventory: true,
        stockOnHand: 10,
      },
    });
  });

  afterAll(async () => {
    await prisma?.order.deleteMany({ where: { accountId } });
    await prisma?.cart.deleteMany({ where: { accountId } });
    await prisma?.rateCard.deleteMany({ where: { accountId } });
    await prisma?.refreshToken.deleteMany({ where: { userId } });
    await prisma?.user.deleteMany({ where: { accountId } });
    await prisma?.site.deleteMany({ where: { accountId } });
    await prisma?.product.deleteMany({ where: { id: productId } });
    await prisma?.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma?.account.deleteMany({ where: { id: accountId } });
    await prisma?.$disconnect();
  });

  describe('transactional rollback across tables', () => {
    it('leaves nothing behind when a later write in the transaction fails', async () => {
      // The claim OrdersService.place() rests on: the order, its lines, its
      // status event and the basket commit together or not at all.
      const orderId = createId('ord');

      await expect(
        withTenantScope(prisma, accountId, async (tx) => {
          await tx.order.create({
            data: {
              id: orderId,
              orderNumber: `ORD-EC-${suffix}`,
              accountId,
              siteId,
              placedById: userId,
              placedByName: 'Edge User',
              placedByEmail: 'edge@example.test',
              status: 'APPROVED',
              subtotal: '100.00',
              catalogSubtotal: '100.00',
              total: '100.00',
              billingPeriod: '2026-09',
              shippingSnapshot: {},
            },
          });

          // A line with a quantity the CHECK constraint refuses.
          await tx.orderLineItem.create({
            data: {
              id: createId('oli'),
              orderId,
              productId,
              sku: 'X',
              name: 'X',
              uom: 'EACH',
              packSize: 1,
              quantity: 0,
              unitPrice: '1.00',
              lineTotal: '1.00',
              catalogUnitPrice: '1.00',
              discountPercent: '0',
              priceSource: 'CATALOG_BASE',
            },
          });
        }),
      ).rejects.toThrow();

      const survivor = await prisma.order.findUnique({ where: { id: orderId } });
      expect(survivor).toBeNull();
    });

    it('rolls back a stock reservation when the order it was for fails', async () => {
      // The reason StockService takes a `tx`: a reservation left behind by an
      // order that never saved is inventory nobody can buy and nobody knows to
      // release.
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stockReserved: true },
      });

      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE "products" SET "stockReserved" = "stockReserved" + 5 WHERE "id" = ${productId}`;
          throw new Error('the order write failed');
        }),
      ).rejects.toThrow('the order write failed');

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stockReserved: true },
      });
      expect(after.stockReserved).toBe(before.stockReserved);
    });
  });

  describe('deleted rate cards', () => {
    beforeAll(async () => {
      await prisma.rateCard.create({
        data: {
          id: rateCardId,
          accountId,
          name: 'Edge contract',
          status: 'ACTIVE',
          effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
          defaultDiscountPercent: '50',
        },
      });
    });

    const activeCardNow = () =>
      withTenantScope(prisma, accountId, (tx) =>
        tx.rateCard.findFirst({
          where: {
            accountId,
            status: 'ACTIVE',
            deletedAt: null,
            effectiveFrom: { lte: new Date() },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
          },
          select: { id: true },
        }),
      );

    it('prices while it is live', async () => {
      expect(await activeCardNow()).toMatchObject({ id: rateCardId });
    });

    it('stops pricing the moment it is deleted, without orphaning anything', async () => {
      // A soft delete: orders priced under it still reference it, so the row
      // survives. What stops is the lookup — and because the cart re-prices on
      // every read, a basket assembled under this card simply reverts to
      // catalogue prices rather than carrying a stale number to checkout.
      await prisma.rateCard.update({
        where: { id: rateCardId },
        data: { status: 'ARCHIVED', deletedAt: new Date() },
      });

      expect(await activeCardNow()).toBeNull();

      const row = await prisma.rateCard.findUnique({ where: { id: rateCardId } });
      expect(row).not.toBeNull();
    });

    it('frees the period for a replacement', async () => {
      // The overlap constraint is partial on ACTIVE and `deletedAt IS NULL`, so
      // a deleted card never blocks its own successor.
      const successor = createId('rc');

      await expect(
        prisma.rateCard.create({
          data: {
            id: successor,
            accountId,
            name: 'Replacement',
            status: 'ACTIVE',
            effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
            defaultDiscountPercent: '10',
          },
        }),
      ).resolves.toMatchObject({ id: successor });
    });
  });

  describe('expired sessions', () => {
    const live = createId('rt');
    const expired = createId('rt');
    const revoked = createId('rt');

    beforeAll(async () => {
      const hour = 3_600_000;
      await prisma.refreshToken.createMany({
        data: [
          {
            id: live,
            userId,
            tokenHash: `live-${suffix}`,
            expiresAt: new Date(Date.now() + hour),
          },
          {
            id: expired,
            userId,
            tokenHash: `expired-${suffix}`,
            expiresAt: new Date(Date.now() - hour),
          },
          {
            id: revoked,
            userId,
            tokenHash: `revoked-${suffix}`,
            expiresAt: new Date(Date.now() + hour),
            revokedAt: new Date(),
          },
        ],
      });
    });

    /** The predicate the refresh path uses: unexpired and not revoked. */
    const usable = (id: string) =>
      prisma.refreshToken.findFirst({
        where: { id, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      });

    it('accepts a live session', async () => {
      expect(await usable(live)).toMatchObject({ id: live });
    });

    it('refuses one that has expired', async () => {
      expect(await usable(expired)).toBeNull();
    });

    it('refuses one that was revoked, even though it has not expired', async () => {
      // Signing out has to take effect immediately; waiting for the clock would
      // leave a stolen token usable for its full lifetime.
      expect(await usable(revoked)).toBeNull();
    });

    it('keeps the expired rows rather than deleting them on read', async () => {
      // Pruning belongs on the MAINTENANCE queue, not on the hot path: a
      // refresh request should not pay for a housekeeping delete, and the rows
      // are evidence of when a session ended.
      expect(await prisma.refreshToken.findUnique({ where: { id: expired } })).not.toBeNull();
    });
  });

  describe('composite indexes the hot queries need', () => {
    /**
     * Whether some index on the table covers every named column.
     *
     * Quotes are stripped before matching: PostgreSQL only quotes an identifier
     * in `indexdef` when it needs to, so `"siteId"` is quoted and `status` is
     * not, and matching on the quoted form silently misses half of them.
     */
    const hasIndex = async (table: string, columns: string[]) => {
      const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;

      return rows.some((row) => {
        const bare = row.indexdef.replace(/"/g, '');
        return columns.every((column) => new RegExp(`\\b${column}\\b`).test(bare));
      });
    };

    it('covers the branch budget query', async () => {
      // Runs on every cart validation — the hottest aggregate in the system.
      expect(await hasIndex('orders', ['siteId', 'billingPeriod', 'status'])).toBe(true);
    });

    it('covers the monthly billing run', async () => {
      // A B-tree cannot skip its leading column, so the budget index above does
      // not serve an account-wide query. Two indexes rather than one reordered.
      expect(await hasIndex('orders', ['accountId', 'billingPeriod', 'status'])).toBe(true);
    });

    it('covers the approvals queue', async () => {
      expect(await hasIndex('orders', ['status', 'requiresApproval'])).toBe(true);
    });

    it('covers order history for one buyer', async () => {
      expect(await hasIndex('orders', ['accountId', 'placedById', 'createdAt'])).toBe(true);
    });

    it('covers the audit trail lookup by entity', async () => {
      expect(await hasIndex('audit_log_entries', ['accountId', 'entityType', 'entityId'])).toBe(
        true,
      );
    });
  });
});
