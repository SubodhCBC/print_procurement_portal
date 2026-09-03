import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId, ForbiddenError, Role, UserType, type AuthenticatedActor } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService } from '@/database';
import { CacheService } from '@/shared/cache';
import { ReportsService } from '@/modules/reports';
import { DashboardQuerySchema } from '@/modules/reports/dto/report.dto';

/**
 * The dashboard bundle (SOW BE-10, FE-12).
 *
 * Three claims the endpoint makes, each of which is a way to leak or to lie if
 * it is wrong:
 *
 * 1. **Account scope is bounded by the tenant.** One customer's dashboard must
 *    never carry another's spend, and `network.activeAccounts` — how many
 *    customers exist at all — must be absent rather than merely unused, because
 *    a cached account-scope payload is served to every actor who shares its key.
 *
 * 2. **Platform scope is administrator-only.** It is the one path that skips
 *    `withTenantScope` entirely, so the role check is the whole boundary.
 *
 * 3. **The queue is not windowed.** An order placed outside the reporting
 *    window and still in production is work somebody is waiting on today. If
 *    the window filtered it away, the longer an order was stuck the more
 *    certainly it would vanish from the screen meant to surface it.
 *
 * The fixtures sit in March 2021 so a platform-scope total — which spans every
 * account in the database, including whatever else the suite has left behind —
 * can still be asserted exactly.
 *
 * Needs Postgres and Redis running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('dashboard report (e2e)', () => {
  let prisma: PrismaService;
  let cache: CacheService;
  let reports: ReportsService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const siteA = createId('sit');
  const siteB = createId('sit');
  const userA = createId('usr');
  const userB = createId('usr');
  const categoryId = createId('cat');
  const productId = createId('prd');

  /** The window the fixtures were built for. Exclusive `to`, as everywhere. */
  const WINDOW = {
    from: new Date('2021-03-14T00:00:00.000Z'),
    to: new Date('2021-03-16T00:00:00.000Z'),
  };
  const IN_WINDOW = new Date('2021-03-15T09:00:00.000Z');
  /** Deliberately long before the window: the stuck order the queue must show. */
  const LONG_BEFORE = new Date('2020-01-06T09:00:00.000Z');

  const actor = (accountId: string, role: Role, userId: string): AuthenticatedActor => ({
    userId,
    accountId,
    role,
    userType: UserType.NEW,
    email: `${userId}@example.test`,
    sessionId: createId('ses'),
  });

  const headOfficeA = actor(accountA, Role.HEAD_OFFICE, userA);
  const administrator = actor(accountA, Role.ADMIN, userA);

  const query = (overrides: Record<string, unknown> = {}) =>
    DashboardQuerySchema.parse({ from: WINDOW.from, to: WINDOW.to, ...overrides });

  const order = (
    accountId: string,
    siteId: string,
    userId: string,
    createdAt: Date,
    status: 'APPROVED' | 'PROCESSING' | 'CANCELLED',
    total: string,
  ) => ({
    id: createId('ord'),
    orderNumber: `ORD-DB-${createId('x').slice(-10)}`,
    accountId,
    siteId,
    placedById: userId,
    placedByName: 'Dashboard Buyer',
    placedByEmail: `${userId}@example.test`,
    status,
    subtotal: total,
    catalogSubtotal: total,
    total,
    billingPeriod: `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`,
    shippingSnapshot: { line1: '1 Dashboard St' },
    createdAt,
  });

  beforeAll(async () => {
    // The cache is a read-through with no invalidation, so leaving it on would
    // let one assertion's payload answer the next one's question. Overriding
    // the TTL on the config the service is handed keeps that decision local to
    // this suite rather than depending on how the environment happens to be set.
    const config = { ...loadConfig(), cache: { ttlSeconds: 0 } };

    prisma = new PrismaService();
    await prisma.$connect();
    cache = new CacheService(config);
    reports = new ReportsService(prisma, cache);

    for (const [accountId, code] of [
      [accountA, `DBA-${suffix}`],
      [accountB, `DBB-${suffix}`],
    ] as const) {
      await prisma.account.create({
        data: { id: accountId, slug: code.toLowerCase(), accountCode: code, name: `Dash ${code}` },
      });
    }

    await prisma.site.createMany({
      data: [
        { id: siteA, accountId: accountA, code: `DBA-${suffix}`, name: 'Dash Branch A' },
        { id: siteB, accountId: accountB, code: `DBB-${suffix}`, name: 'Dash Branch B' },
      ],
    });

    await prisma.user.createMany({
      data: [
        {
          id: userA,
          accountId: accountA,
          siteId: siteA,
          userType: 'NEW',
          login: `dba-${suffix}`,
          loginDisplay: `dba-${suffix}`,
          email: `dba-${suffix}@example.test`,
          firstName: 'Dash',
          lastName: 'A',
          role: 'HEAD_OFFICE',
        },
        {
          id: userB,
          accountId: accountB,
          siteId: siteB,
          userType: 'NEW',
          login: `dbb-${suffix}`,
          loginDisplay: `dbb-${suffix}`,
          email: `dbb-${suffix}@example.test`,
          firstName: 'Dash',
          lastName: 'B',
          role: 'HEAD_OFFICE',
        },
      ],
    });

    await prisma.productCategory.create({
      data: { id: categoryId, code: `DB-${suffix}`, name: 'Dashboard fixtures' },
    });
    await prisma.product.create({
      data: {
        id: productId,
        sku: `DB-SKU-${suffix}`,
        name: 'Dashboard fixture',
        categoryId,
        basePrice: '100.00',
      },
    });

    await prisma.order.createMany({
      data: [
        // Account A, inside the window: 200.00 across two orders.
        order(accountA, siteA, userA, IN_WINDOW, 'APPROVED', '100.00'),
        order(accountA, siteA, userA, IN_WINDOW, 'APPROVED', '100.00'),
        // Account A, long before the window and still in production. Counts in
        // the queue, must not count in the window's spend.
        order(accountA, siteA, userA, LONG_BEFORE, 'PROCESSING', '500.00'),
        // Account A, inside the window but cancelled: never spend, never queue.
        order(accountA, siteA, userA, IN_WINDOW, 'CANCELLED', '750.00'),
        // Account B, inside the window. The row account A must never see.
        order(accountB, siteB, userB, IN_WINDOW, 'APPROVED', '999.00'),
      ],
    });
  });

  afterAll(async () => {
    for (const accountId of [accountA, accountB]) {
      await prisma?.order.deleteMany({ where: { accountId } });
      await prisma?.user.deleteMany({ where: { accountId } });
      await prisma?.site.deleteMany({ where: { accountId } });
      await prisma?.account.deleteMany({ where: { id: accountId } });
    }
    await prisma?.product.deleteMany({ where: { id: productId } });
    await prisma?.productCategory.deleteMany({ where: { id: categoryId } });
    await cache?.onModuleDestroy();
    await prisma?.$disconnect();
  });

  describe('account scope', () => {
    it('reports the account own spend and nothing else', async () => {
      const report = await reports.dashboard(headOfficeA, query());

      expect(report.scope).toBe('account');
      expect(report.accountId).toBe(accountA);
      // 200.00, not 1199.00: account B contributed nothing, and the cancelled
      // order contributed nothing either.
      expect(report.spend.totalSpend).toBe('200.00');
      expect(report.spend.orderCount).toBe(2);
    });

    it('withholds how many customers exist on the platform', async () => {
      // Not merely unused by this screen — absent. The cached account-scope
      // payload is served to every actor sharing its key, so a number populated
      // here would reach a tenant through the cache even if no page drew it.
      const report = await reports.dashboard(headOfficeA, query());

      expect(report.network.activeAccounts).toBeNull();
      expect(report.network.activeSites).toBe(1);
    });

    it('lets an administrator drill into one customer', async () => {
      const report = await reports.dashboard(administrator, query({ accountId: accountB }));

      expect(report.accountId).toBe(accountB);
      expect(report.spend.totalSpend).toBe('999.00');
      expect(report.network.activeAccounts).toBeNull();
    });

    it('pins a non-administrator to their own account whatever they ask for', async () => {
      // The head office of A asking for B is not an error; it is simply not
      // honoured. `resolveAccount` decides, not the query string.
      const report = await reports.dashboard(headOfficeA, query({ accountId: accountB }));

      expect(report.accountId).toBe(accountA);
      expect(report.spend.totalSpend).toBe('200.00');
    });
  });

  describe('platform scope', () => {
    it('is refused to a head office user', async () => {
      await expect(reports.dashboard(headOfficeA, query({ scope: 'platform' }))).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('spans every account for an administrator', async () => {
      const report = await reports.dashboard(administrator, query({ scope: 'platform' }));

      expect(report.scope).toBe('platform');
      expect(report.accountId).toBeNull();
      // Both accounts, and still not the cancelled order.
      expect(report.spend.totalSpend).toBe('1199.00');
      expect(report.spend.orderCount).toBe(3);
    });

    it('carries the account count only here', async () => {
      const report = await reports.dashboard(administrator, query({ scope: 'platform' }));

      expect(report.network.activeAccounts).not.toBeNull();
      expect(report.network.activeAccounts ?? 0).toBeGreaterThanOrEqual(2);
    });
  });

  describe('the queue runs on a different clock from the window', () => {
    it('counts an order placed long before the window and still open', async () => {
      const report = await reports.dashboard(headOfficeA, query());

      // Two approved inside the window plus the one stuck in production since
      // 2020 — the order the window would otherwise hide.
      expect(report.queue.open).toBe(3);
      expect(report.spend.orderCount).toBe(2);
    });

    it('splits the queue where the goods change hands', async () => {
      const report = await reports.dashboard(headOfficeA, query());

      expect(report.queue.awaitingDispatch).toBe(3);
      expect(report.queue.inTransit).toBe(0);
      expect(report.queue.inFulfilment).toBe(3);
      expect(report.queue.awaitingApproval).toBe(0);
    });

    it('leaves cancelled orders out of the queue entirely', async () => {
      const report = await reports.dashboard(headOfficeA, query());

      // Four of account A's five orders are non-cancelled; the cancelled one
      // is terminal and appears in neither figure.
      expect(report.queue.open).toBe(3);
      expect(report.byStatus.find((row) => row.status === 'CANCELLED')?.orders).toBe(1);
    });

    it('still shows cancelled orders in the windowed status breakdown', async () => {
      // The spend reports exclude them; this one must not. "Where is work
      // stuck" is answered by exactly the statuses that carry no money.
      const report = await reports.dashboard(headOfficeA, query());

      const statuses = report.byStatus.map((row) => row.status);
      expect(statuses).toContain('CANCELLED');
      expect(statuses).toContain('APPROVED');
      // The 2020 order is outside the window, so it is absent here but present
      // in the queue — the same two clocks, seen from the other side.
      expect(statuses).not.toContain('PROCESSING');
    });
  });

  describe('the bundle agrees with the endpoints it replaces', () => {
    it('matches the standalone spend summary', async () => {
      const [bundled, standalone] = await Promise.all([
        reports.dashboard(headOfficeA, query()),
        reports.spendSummary(headOfficeA, { from: WINDOW.from, to: WINDOW.to }),
      ]);

      expect(bundled.spend).toEqual(standalone);
    });

    it('matches the standalone status breakdown', async () => {
      const [bundled, standalone] = await Promise.all([
        reports.dashboard(headOfficeA, query()),
        reports.ordersByStatus(headOfficeA, { from: WINDOW.from, to: WINDOW.to }),
      ]);

      expect(bundled.byStatus).toEqual(standalone);
    });

    it('matches the standalone spend chart', async () => {
      const [bundled, standalone] = await Promise.all([
        reports.dashboard(headOfficeA, query({ granularity: 'day' })),
        reports.spendOverTime(headOfficeA, {
          from: WINDOW.from,
          to: WINDOW.to,
          granularity: 'day',
        }),
      ]);

      expect(bundled.granularity).toBe(standalone.granularity);
      expect(bundled.trend).toEqual(standalone.buckets);
    });

    it('matches the standalone branch breakdown, capped', async () => {
      const [bundled, standalone] = await Promise.all([
        reports.dashboard(headOfficeA, query({ topSites: 1 })),
        reports.spendBySite(headOfficeA, { from: WINDOW.from, to: WINDOW.to }),
      ]);

      expect(bundled.topSites).toEqual(standalone.slice(0, 1));
      expect(bundled.topSites[0]?.label).toBe('Dash Branch A');
    });

    it('omits the branch strip when none was asked for', async () => {
      const report = await reports.dashboard(headOfficeA, query({ topSites: 0 }));

      expect(report.topSites).toEqual([]);
    });
  });

  describe('pace', () => {
    it('is derived from the same buckets the chart is drawn from', async () => {
      const report = await reports.dashboard(headOfficeA, query({ granularity: 'day' }));

      // Two orders over a two-day window.
      expect(report.pace.ordersPerDay).toBe(1);
      expect(report.pace.busiestBucket).toBe('2021-03-15');
      expect(report.pace.busiestBucketOrders).toBe(2);
    });
  });
});
