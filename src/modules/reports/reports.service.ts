import { Injectable } from '@nestjs/common';
import { Prisma, type OrderStatus } from '@prisma/client';
import { ForbiddenError, Role, type AuthenticatedActor } from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { CacheService, cacheKey } from '@/shared/cache';
// The pure lifecycle file, not the orders barrel: that would pull OrdersService
// and its whole dependency chain in for one constant.
import {
  AWAITING_APPROVAL_STATUSES,
  COMMITTED_STATUSES,
  IN_FULFILMENT_STATUSES,
  OPEN_STATUSES,
} from '@/modules/orders/order-status';
import type { DashboardQueryDto, ReportRangeQueryDto, TopProductsQueryDto } from './dto/report.dto';
import {
  bucketOf,
  bucketsIn,
  defaultGranularity,
  growthPercent,
  previousRange,
  resolveRange,
  type DateRange,
  type Granularity,
} from './report-periods';

/**
 * The one definition of "spend" every report here uses.
 *
 * Committed orders — everything from awaiting-approval through delivered, but
 * never drafts, rejections or cancellations. The same set the branch budget
 * counts, so a dashboard and a budget can never disagree about what a branch
 * has spent. Reporting only shipped orders would be a different, equally
 * defensible number; having *two* of them in one system is what is not
 * defensible.
 */
const SPEND_STATUSES = [...COMMITTED_STATUSES];

/**
 * The two halves of the fulfilment queue, split where the goods change hands.
 *
 * Named here rather than in the lifecycle file because the split is a
 * reporting distinction — what the warehouse still has to pick versus what is
 * already with a carrier — and not a rule the state machine enforces.
 */
const AWAITING_DISPATCH_STATUSES: readonly OrderStatus[] = ['APPROVED', 'PROCESSING'];
const IN_TRANSIT_STATUSES: readonly OrderStatus[] = ['DISPATCHED'];

export interface SpendSummary {
  readonly from: string;
  readonly to: string;
  readonly totalSpend: string;
  readonly orderCount: number;
  readonly averageOrderValue: string;
  readonly siteCount: number;
  readonly previous: {
    readonly totalSpend: string;
    readonly orderCount: number;
  };
  /** Null when the previous window had nothing to compare against. */
  readonly spendGrowthPercent: number | null;
  readonly orderGrowthPercent: number | null;
}

export interface SpendBucket {
  readonly bucket: string;
  readonly spend: string;
  readonly orders: number;
}

/** One row of the pipeline breakdown: how many orders sit at a status. */
export interface StatusRow {
  readonly status: OrderStatus;
  readonly orders: number;
  readonly value: string;
  readonly sharePercent: number;
}

export interface DimensionRow {
  readonly id: string;
  readonly label: string;
  readonly sublabel?: string;
  readonly spend: string;
  readonly orders: number;
  /** Share of the window's total, to one decimal place. */
  readonly sharePercent: number;
}

export interface TopProductRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryName: string;
  readonly quantity: number;
  readonly spend: string;
  readonly orders: number;
}

export interface VelocityReport {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly orders: number;
  /** Orders per day across the window, to one decimal place. */
  readonly ordersPerDay: number;
  readonly busiestBucket: string | null;
  readonly busiestBucketOrders: number;
  readonly granularity: Granularity;
  readonly buckets: readonly SpendBucket[];
  /** Against the same-length window immediately before. Null when it was empty. */
  readonly velocityGrowthPercent: number | null;
}

export interface TurnoverRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unitsShipped: number;
  readonly stockOnHand: number;
  /**
   * Units shipped in the window divided by what is on the shelf now.
   *
   * Not the accounting definition, which divides by *average* stock over the
   * period — that needs a history of shelf counts this system does not keep.
   * Named and documented for what it actually is rather than borrowed from a
   * textbook and quietly wrong.
   */
  readonly turnoverRatio: number | null;
  /** At this rate, how long the current shelf lasts. Null when nothing moved. */
  readonly daysOfCover: number | null;
}

export interface InventoryReport {
  readonly trackedProducts: number;
  readonly lowStock: number;
  readonly outOfStock: number;
  readonly totalUnitsOnHand: number;
  readonly totalUnitsReserved: number;
  readonly items: readonly {
    readonly productId: string;
    readonly sku: string;
    readonly name: string;
    readonly stockOnHand: number;
    readonly stockReserved: number;
    readonly available: number;
    readonly lowStockThreshold: number;
    readonly reorderQuantity: number | null;
    readonly status: 'OUT_OF_STOCK' | 'LOW' | 'HEALTHY';
  }[];
}

/** The live queue counts, as of now rather than over the reporting window. */
export interface DashboardQueue {
  /** Submitted and not yet finished. The "orders in flight" card. */
  readonly open: number;
  readonly awaitingApproval: number;
  /** Approved and not yet delivered — the fulfilment board's working set. */
  readonly inFulfilment: number;
  /** Approved or in production: what the warehouse still has to pick. */
  readonly awaitingDispatch: number;
  /** Dispatched and not yet delivered. */
  readonly inTransit: number;
}

/** How large the estate being reported on is. */
export interface DashboardNetwork {
  readonly activeSites: number;
  /**
   * Customer accounts on the platform. Null in account scope — how many other
   * customers exist is not a tenant's business, and leaving the field present
   * but null keeps one response shape rather than two.
   */
  readonly activeAccounts: number | null;
}

/** Pace, derived from the trend buckets rather than from a query of its own. */
export interface DashboardPace {
  readonly ordersPerDay: number;
  readonly busiestBucket: string | null;
  readonly busiestBucketOrders: number;
}

/**
 * Everything a dashboard's cards and charts need, in one response.
 *
 * ---------------------------------------------------------------------------
 * Two clocks, on purpose
 * ---------------------------------------------------------------------------
 * `spend`, `trend`, `byStatus`, `pace` and `topSites` are **windowed** — they
 * answer "what happened between `from` and `to`". `queue` and `network` are a
 * **snapshot of now** and ignore the window entirely.
 *
 * That asymmetry is the point rather than an oversight. An order placed six
 * weeks ago and still in production is work somebody is waiting on today, and a
 * thirty-day window would hide exactly the orders a fulfilment team most needs
 * to see. Equally, a branch that opened last week is an active branch even
 * though it appears in no historical total. Collapsing both onto one clock
 * would make one of the two numbers quietly wrong.
 */
export interface DashboardReport {
  readonly scope: 'account' | 'platform';
  /** Null in platform scope, where the figures span every customer. */
  readonly accountId: string | null;
  readonly from: string;
  readonly to: string;
  readonly granularity: Granularity;
  readonly spend: SpendSummary;
  readonly pace: DashboardPace;
  readonly trend: readonly SpendBucket[];
  /** Windowed, and counts every status including rejected and cancelled. */
  readonly byStatus: readonly StatusRow[];
  readonly queue: DashboardQueue;
  readonly network: DashboardNetwork;
  readonly topSites: readonly DimensionRow[];
}

/**
 * Analytics and reporting (SOW BE-10).
 *
 * ---------------------------------------------------------------------------
 * No tables of its own
 * ---------------------------------------------------------------------------
 * Every figure here is computed from orders, their lines and the catalogue.
 * There is no rollup table and no nightly job, deliberately: a stored aggregate
 * is a second copy of a number, and the two disagree the first time an order is
 * cancelled after the rollup ran. The volumes this system will see — thousands
 * of orders a month, not millions — are comfortably within what an indexed
 * aggregate query answers in milliseconds. When that stops being true, the
 * seam to add is a materialised view refreshed on the MAINTENANCE queue, and
 * nothing outside this file changes.
 *
 * Every query runs inside `withTenantScope`, so RLS bounds it even though the
 * aggregates are written as raw SQL.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Wraps a report in the short-lived cache.
   *
   * The key carries the account and every filter, because a key that forgets a
   * dimension serves one customer another's numbers. Nothing here is ever
   * invalidated — see CacheService for why a sixty-second TTL is preferred to
   * an invalidation web that grows with every feature and fails silently when
   * one path forgets.
   */
  private cached<T>(
    namespace: string,
    accountId: string,
    query: ReportRangeQueryDto & { by?: string; limit?: number },
    compute: () => Promise<T>,
  ): Promise<T> {
    return this.cache.through(
      cacheKey(namespace, accountId, {
        from: query.from,
        to: query.to,
        siteId: query.siteId,
        granularity: query.granularity,
        by: query.by,
        limit: query.limit,
      }),
      compute,
    );
  }

  /** The headline cards: spend, orders, average value, and the trend. */
  async spendSummary(actor: AuthenticatedActor, query: ReportRangeQueryDto): Promise<SpendSummary> {
    return this.cached('spend-summary', this.resolveAccount(actor, query.accountId), query, () =>
      this.computeSpendSummary(actor, query),
    );
  }

  private async computeSpendSummary(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<SpendSummary> {
    const accountId = this.resolveAccount(actor, query.accountId);
    const range = resolveRange(query.from, query.to);
    const previous = previousRange(range);

    const [current, before] = await withTenantScope(this.prisma, accountId, (tx) =>
      Promise.all([
        this.totals(tx, accountId, range, query.siteId),
        this.totals(tx, accountId, previous, query.siteId),
      ]),
    );

    const average =
      current.orders === 0 ? new Prisma.Decimal(0) : current.spend.dividedBy(current.orders);

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      totalSpend: current.spend.toFixed(2),
      orderCount: current.orders,
      averageOrderValue: average.toFixed(2),
      siteCount: current.sites,
      previous: { totalSpend: before.spend.toFixed(2), orderCount: before.orders },
      spendGrowthPercent: growthPercent(Number(current.spend), Number(before.spend)),
      orderGrowthPercent: growthPercent(current.orders, before.orders),
    };
  }

  /**
   * Spend over time, for the trend chart.
   *
   * Empty buckets are filled in rather than omitted: a chart that skips days
   * with no orders draws a straight line through them and silently overstates a
   * quiet week.
   */
  async spendOverTime(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<{ granularity: Granularity; buckets: readonly SpendBucket[] }> {
    const accountId = this.resolveAccount(actor, query.accountId);
    const range = resolveRange(query.from, query.to);
    const granularity = query.granularity ?? defaultGranularity(range);

    const orders = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.order.findMany({
        where: this.spendWhere(accountId, range, query.siteId),
        select: { createdAt: true, total: true },
      }),
    );

    return { granularity, buckets: this.bucketise(orders, range, granularity) };
  }

  /**
   * Folds raw orders into the chart's buckets.
   *
   * Every bucket in the range is prepared first, so a day with no orders is a
   * zero rather than a gap: a chart that omits quiet days draws a straight line
   * through them and silently overstates the week.
   *
   * Shared with the dashboard bundle so the two can never draw different
   * charts from the same window.
   */
  private bucketise(
    orders: readonly { createdAt: Date; total: Prisma.Decimal }[],
    range: DateRange,
    granularity: Granularity,
  ): SpendBucket[] {
    const totals = new Map<string, { spend: Prisma.Decimal; orders: number }>();
    for (const bucket of bucketsIn(range, granularity)) {
      totals.set(bucket, { spend: new Prisma.Decimal(0), orders: 0 });
    }

    for (const order of orders) {
      const bucket = bucketOf(order.createdAt, granularity);
      const entry = totals.get(bucket);
      // An order outside every prepared bucket can only mean the range and the
      // data disagree; dropping it silently would be worse than not charting it.
      if (!entry) continue;
      entry.spend = entry.spend.plus(order.total);
      entry.orders += 1;
    }

    return [...totals.entries()].map(([bucket, entry]) => ({
      bucket,
      spend: entry.spend.toFixed(2),
      orders: entry.orders,
    }));
  }

  /** Spend broken down by branch. */
  async spendBySite(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    return this.cached('spend-by-site', this.resolveAccount(actor, query.accountId), query, () =>
      this.computeSpendBySite(actor, query),
    );
  }

  private async computeSpendBySite(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    const accountId = this.resolveAccount(actor, query.accountId);
    const range = resolveRange(query.from, query.to);

    return withTenantScope(this.prisma, accountId, (tx) =>
      this.siteSpendRows(tx, accountId, range, query.siteId),
    );
  }

  /**
   * Spend per branch, against a caller-supplied scope.
   *
   * Takes the transaction rather than opening one, so the dashboard bundle can
   * fold it into the single scope it already holds — and so both callers rank
   * branches by exactly the same rule.
   */
  private async siteSpendRows(
    tx: Prisma.TransactionClient,
    accountId: string | null,
    range: DateRange,
    siteId?: string,
  ): Promise<readonly DimensionRow[]> {
    const grouped = await tx.order.groupBy({
      by: ['siteId'],
      where: this.spendWhere(accountId, range, siteId),
      _sum: { total: true },
      _count: { _all: true },
    });

    const sites = await tx.site.findMany({
      where: { id: { in: grouped.map((row) => row.siteId) } },
      select: { id: true, code: true, name: true },
    });

    const byId = new Map(sites.map((site) => [site.id, site]));
    return this.withShares(
      grouped.map((row) => ({
        id: row.siteId,
        label: byId.get(row.siteId)?.name ?? 'Unknown branch',
        sublabel: byId.get(row.siteId)?.code,
        spend: row._sum.total ?? new Prisma.Decimal(0),
        orders: row._count._all,
      })),
    );
  }

  /**
   * Spend broken down by product category.
   *
   * Raw SQL because it spans order lines, products and categories, and Prisma's
   * `groupBy` cannot group by a column two joins away. The tenant scope still
   * applies — RLS is enforced by the database, not by the query builder — and
   * every value is parameterised.
   */
  async spendByCategory(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    return this.cached(
      'spend-by-category',
      this.resolveAccount(actor, query.accountId),
      query,
      () => this.computeSpendByCategory(actor, query),
    );
  }

  private async computeSpendByCategory(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    const accountId = this.resolveAccount(actor, query.accountId);
    const range = resolveRange(query.from, query.to);

    const rows = await withTenantScope(
      this.prisma,
      accountId,
      (tx) =>
        tx.$queryRaw<{ id: string; label: string; spend: Prisma.Decimal; orders: bigint }[]>`
        SELECT c."id"                        AS "id",
               c."name"                      AS "label",
               SUM(l."lineTotal")            AS "spend",
               COUNT(DISTINCT o."id")        AS "orders"
        FROM "order_line_items" l
        JOIN "orders" o            ON o."id" = l."orderId"
        JOIN "products" p          ON p."id" = l."productId"
        JOIN "product_categories" c ON c."id" = p."categoryId"
        WHERE o."accountId" = ${accountId}
          AND o."createdAt" >= ${range.from}
          AND o."createdAt" <  ${range.to}
          AND o."status" = ANY(${SPEND_STATUSES}::"OrderStatus"[])
          ${query.siteId ? Prisma.sql`AND o."siteId" = ${query.siteId}` : Prisma.empty}
        GROUP BY c."id", c."name"
        ORDER BY "spend" DESC`,
    );

    return this.withShares(
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        spend: row.spend,
        orders: Number(row.orders),
      })),
    );
  }

  /** The SKUs that account for the most spend, for the executive dashboard. */
  async topProducts(
    actor: AuthenticatedActor,
    query: TopProductsQueryDto,
  ): Promise<readonly TopProductRow[]> {
    return this.cached('top-products', this.resolveAccount(actor, query.accountId), query, () =>
      this.computeTopProducts(actor, query),
    );
  }

  private async computeTopProducts(
    actor: AuthenticatedActor,
    query: TopProductsQueryDto,
  ): Promise<readonly TopProductRow[]> {
    const accountId = this.resolveAccount(actor, query.accountId);
    const range = resolveRange(query.from, query.to);
    const orderBy = query.by === 'quantity' ? Prisma.sql`"quantity"` : Prisma.sql`"spend"`;

    const rows = await withTenantScope(
      this.prisma,
      accountId,
      (tx) =>
        tx.$queryRaw<
          {
            productId: string;
            sku: string;
            name: string;
            categoryName: string;
            quantity: bigint;
            spend: Prisma.Decimal;
            orders: bigint;
          }[]
        >`
        SELECT l."productId"            AS "productId",
               l."sku"                  AS "sku",
               l."name"                 AS "name",
               c."name"                 AS "categoryName",
               SUM(l."quantity")        AS "quantity",
               SUM(l."lineTotal")       AS "spend",
               COUNT(DISTINCT o."id")   AS "orders"
        FROM "order_line_items" l
        JOIN "orders" o             ON o."id" = l."orderId"
        JOIN "products" p           ON p."id" = l."productId"
        JOIN "product_categories" c ON c."id" = p."categoryId"
        WHERE o."accountId" = ${accountId}
          AND o."createdAt" >= ${range.from}
          AND o."createdAt" <  ${range.to}
          AND o."status" = ANY(${SPEND_STATUSES}::"OrderStatus"[])
          ${query.siteId ? Prisma.sql`AND o."siteId" = ${query.siteId}` : Prisma.empty}
        -- Grouped on the snapshotted sku and name, not the live product: a
        -- product renamed since must not split its own history in two.
        GROUP BY l."productId", l."sku", l."name", c."name"
        ORDER BY ${orderBy} DESC
        LIMIT ${query.limit}`,
    );

    return rows.map((row) => ({
      productId: row.productId,
      sku: row.sku,
      name: row.name,
      categoryName: row.categoryName,
      quantity: Number(row.quantity),
      spend: row.spend.toFixed(2),
      orders: Number(row.orders),
    }));
  }

  /**
   * The warehouse view: what is low, what is out, and what to reorder.
   *
   * Not tenant-scoped, because the catalogue is not — and deliberately *not*
   * filtered by product visibility either, because a reorder report has to show
   * every line the warehouse holds including the ones restricted to a single
   * customer's contract.
   *
   * That is exactly why the route is gated on INVENTORY_MANAGE rather than
   * INVENTORY_VIEW: head office holds the latter, and would otherwise see
   * another customer's contract lines here.
   */
  async inventory(limit: number): Promise<InventoryReport> {
    const products = await this.prisma.product.findMany({
      where: { trackInventory: true, deletedAt: null },
      select: {
        id: true,
        sku: true,
        name: true,
        stockOnHand: true,
        stockReserved: true,
        lowStockThreshold: true,
        reorderQuantity: true,
      },
      orderBy: { stockOnHand: 'asc' },
    });

    const items = products.map((product) => {
      const available = Math.max(0, product.stockOnHand - product.stockReserved);
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        stockOnHand: product.stockOnHand,
        stockReserved: product.stockReserved,
        available,
        lowStockThreshold: product.lowStockThreshold,
        reorderQuantity: product.reorderQuantity,
        // Judged on the shelf, not on what is available: this drives
        // reordering, and what needs buying is decided by what is physically
        // there rather than by how much of it is already spoken for.
        status:
          product.stockOnHand === 0
            ? ('OUT_OF_STOCK' as const)
            : product.stockOnHand <= product.lowStockThreshold
              ? ('LOW' as const)
              : ('HEALTHY' as const),
      };
    });

    return {
      trackedProducts: items.length,
      lowStock: items.filter((item) => item.status === 'LOW').length,
      outOfStock: items.filter((item) => item.status === 'OUT_OF_STOCK').length,
      totalUnitsOnHand: items.reduce((total, item) => total + item.stockOnHand, 0),
      totalUnitsReserved: items.reduce((total, item) => total + item.stockReserved, 0),
      // The healthy tail is trimmed: this is a "what needs attention" report,
      // and a thousand rows of nothing wrong is not one.
      items: items.filter((item) => item.status !== 'HEALTHY').slice(0, limit),
    };
  }

  /**
   * Spend per customer account.
   *
   * The one report here that is genuinely cross-tenant, so it runs outside
   * `withTenantScope` — the same shape as AccountsService.list(). The guard on
   * the route is the whole protection: ACCOUNT_MANAGE is administrator-only and
   * this method must never be reachable without it.
   */
  async spendByAccount(query: ReportRangeQueryDto): Promise<readonly DimensionRow[]> {
    const range = resolveRange(query.from, query.to);

    const grouped = await this.prisma.order.groupBy({
      by: ['accountId'],
      where: {
        status: { in: SPEND_STATUSES },
        createdAt: { gte: range.from, lt: range.to },
      },
      _sum: { total: true },
      _count: { _all: true },
    });

    const accounts = await this.prisma.account.findMany({
      where: { id: { in: grouped.map((row) => row.accountId) } },
      select: { id: true, accountCode: true, name: true },
    });
    const byId = new Map(accounts.map((account) => [account.id, account]));

    return this.withShares(
      grouped.map((row) => ({
        id: row.accountId,
        label: byId.get(row.accountId)?.name ?? 'Unknown account',
        sublabel: byId.get(row.accountId)?.accountCode,
        spend: row._sum.total ?? new Prisma.Decimal(0),
        orders: row._count._all,
      })),
    );
  }

  /**
   * Spend by delivery region.
   *
   * Read from the order's frozen `shippingSnapshot`, not from the address row:
   * an address corrected after the fact must not move historical spend between
   * regions. Orders with no region recorded are grouped rather than dropped —
   * a total that silently omits them would not reconcile with the headline.
   */
  async spendByRegion(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    const accountId = this.resolveAccount(actor, query.accountId);
    const range = resolveRange(query.from, query.to);

    const rows = await withTenantScope(
      this.prisma,
      accountId,
      (tx) =>
        tx.$queryRaw<{ region: string | null; spend: Prisma.Decimal; orders: bigint }[]>`
        SELECT NULLIF(TRIM(o."shippingSnapshot" ->> 'region'), '') AS "region",
               SUM(o."total")                                      AS "spend",
               COUNT(*)                                            AS "orders"
        FROM "orders" o
        WHERE o."accountId" = ${accountId}
          AND o."createdAt" >= ${range.from}
          AND o."createdAt" <  ${range.to}
          AND o."status" = ANY(${SPEND_STATUSES}::"OrderStatus"[])
          ${query.siteId ? Prisma.sql`AND o."siteId" = ${query.siteId}` : Prisma.empty}
        GROUP BY 1
        ORDER BY "spend" DESC`,
    );

    return this.withShares(
      rows.map((row) => ({
        id: row.region ?? '__unspecified__',
        label: row.region ?? 'No region recorded',
        spend: row.spend,
        orders: Number(row.orders),
      })),
    );
  }

  /**
   * How fast orders are arriving, rather than how much they are worth.
   *
   * A separate question from spend: a month of many small orders and a month of
   * one large one look identical on a revenue chart and mean very different
   * things to a production team.
   */
  async orderVelocity(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<VelocityReport> {
    const range = resolveRange(query.from, query.to);
    const previous = previousRange(range);

    const [current, before] = await Promise.all([
      this.spendOverTime(actor, { ...query, from: range.from, to: range.to }),
      this.spendOverTime(actor, { ...query, from: previous.from, to: previous.to }),
    ]);

    const orders = current.buckets.reduce((total, bucket) => total + bucket.orders, 0);
    const previousOrders = before.buckets.reduce((total, bucket) => total + bucket.orders, 0);
    const days = Math.max(1, (range.to.getTime() - range.from.getTime()) / 86_400_000);

    // The busiest bucket, for "your peak week was ...". Ties resolve to the
    // earliest, which is the one a reader scanning left to right expects.
    const busiest = current.buckets.reduce<SpendBucket | null>(
      (best, bucket) => (best === null || bucket.orders > best.orders ? bucket : best),
      null,
    );

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      days: Math.round(days),
      orders,
      ordersPerDay: Math.round((orders / days) * 10) / 10,
      busiestBucket: busiest && busiest.orders > 0 ? busiest.bucket : null,
      busiestBucketOrders: busiest?.orders ?? 0,
      granularity: current.granularity,
      buckets: current.buckets,
      velocityGrowthPercent: growthPercent(orders, previousOrders),
    };
  }

  /**
   * How fast stock is moving relative to what is being held.
   *
   * Units shipped are counted from DISPATCHED and DELIVERED orders only — goods
   * still in production have not left the shelf, and counting them would
   * overstate movement in exactly the month a large order was placed and not
   * yet filled.
   *
   * Not tenant-scoped, and administrator-only for the same reason the warehouse
   * report is: it spans the whole global catalogue.
   */
  async inventoryTurnover(
    query: ReportRangeQueryDto,
    limit: number,
  ): Promise<readonly TurnoverRow[]> {
    const range = resolveRange(query.from, query.to);
    const days = Math.max(1, (range.to.getTime() - range.from.getTime()) / 86_400_000);

    const rows = await this.prisma.$queryRaw<
      { productId: string; sku: string; name: string; unitsShipped: bigint; stockOnHand: number }[]
    >`
      SELECT p."id"                              AS "productId",
             p."sku"                             AS "sku",
             p."name"                            AS "name",
             -- FILTER, not a bare SUM: with a LEFT JOIN the line row survives
             -- even when the order fails the date and status conditions in the
             -- ON clause, so a plain SUM would count orders from outside the
             -- window and ones that have not shipped.
             COALESCE(SUM(l."quantity") FILTER (WHERE o."id" IS NOT NULL), 0) AS "unitsShipped",
             p."stockOnHand"                     AS "stockOnHand"
      FROM "products" p
      LEFT JOIN "order_line_items" l ON l."productId" = p."id"
      LEFT JOIN "orders" o
             ON o."id" = l."orderId"
            AND o."createdAt" >= ${range.from}
            AND o."createdAt" <  ${range.to}
            AND o."status" IN ('DISPATCHED', 'DELIVERED')
      -- LEFT JOIN, so a product that shipped nothing still appears with a zero:
      -- "what is not moving" is half the question this answers.
      WHERE p."trackInventory" AND p."deletedAt" IS NULL
      GROUP BY p."id", p."sku", p."name", p."stockOnHand"
      ORDER BY "unitsShipped" DESC
      LIMIT ${limit}`;

    return rows.map((row) => {
      const shipped = Number(row.unitsShipped);
      const perDay = shipped / days;

      return {
        productId: row.productId,
        sku: row.sku,
        name: row.name,
        unitsShipped: shipped,
        stockOnHand: row.stockOnHand,
        // Null rather than infinity when the shelf is empty: a product with no
        // stock has no turnover ratio, it has a supply problem.
        turnoverRatio:
          row.stockOnHand === 0 ? null : Math.round((shipped / row.stockOnHand) * 100) / 100,
        // Null when nothing moved: dividing by zero would report "forever",
        // which reads as healthy and is the opposite of what a dead line means.
        daysOfCover: perDay === 0 ? null : Math.round(row.stockOnHand / perDay),
      };
    });
  }

  // --- Internals --------------------------------------------------------------

  /**
   * How many orders sit at each status, and what they are worth.
   *
   * One grouped query rather than a count per status: the dashboard used to ask
   * six times and read only the totals, which is six round trips for something
   * the database answers in one pass over an index it already has
   * (`@@index([accountId, status])`).
   *
   * Unlike the spend reports this counts *every* status, rejected and cancelled
   * included — the question here is where work is stuck, and the statuses that
   * carry no money are often the interesting ones.
   */
  async ordersByStatus(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<readonly StatusRow[]> {
    return this.cached('orders-by-status', this.resolveAccount(actor, query.accountId), query, () =>
      this.computeOrdersByStatus(actor, query),
    );
  }

  private async computeOrdersByStatus(
    actor: AuthenticatedActor,
    query: ReportRangeQueryDto,
  ): Promise<readonly StatusRow[]> {
    const accountId = this.resolveAccount(actor, query.accountId);
    const range = resolveRange(query.from, query.to);

    return withTenantScope(this.prisma, accountId, (tx) =>
      this.statusRows(tx, accountId, range, query.siteId),
    );
  }

  /**
   * The status breakdown, against a caller-supplied scope.
   *
   * Windowed on `createdAt` and counting every status — unlike the spend
   * reports, rejected and cancelled orders are exactly what a "where is work
   * stuck" view has to show.
   */
  private async statusRows(
    tx: Prisma.TransactionClient,
    accountId: string | null,
    range: DateRange,
    siteId?: string,
  ): Promise<readonly StatusRow[]> {
    const grouped = await tx.order.groupBy({
      by: ['status'],
      where: {
        ...(accountId ? { accountId } : {}),
        createdAt: { gte: range.from, lt: range.to },
        ...(siteId ? { siteId } : {}),
      },
      _sum: { total: true },
      _count: { _all: true },
    });

    const total = grouped.reduce((sum, row) => sum + row._count._all, 0);

    return grouped
      .map((row) => ({
        status: row.status,
        orders: row._count._all,
        value: (row._sum.total ?? new Prisma.Decimal(0)).toFixed(2),
        // Share of the order *count*, not of the money: this chart is about how
        // many things are where, and a single large order would otherwise make
        // a busy queue look empty.
        sharePercent: total === 0 ? 0 : Math.round((row._count._all / total) * 1000) / 10,
      }))
      .sort((a, b) => b.orders - a.orders);
  }

  /**
   * Every card and chart on a dashboard, in one response (SOW BE-10, FE-12).
   *
   * ---------------------------------------------------------------------------
   * Why this exists when the pieces already have endpoints
   * ---------------------------------------------------------------------------
   * A dashboard opening on seven separate calls pays seven round trips, seven
   * authentications and seven tenant-scope transactions to draw one screen, and
   * each call resolves its own date range — so a request that straddles
   * midnight can render cards that disagree with the chart beside them. Here
   * the range is resolved once and every figure is computed against it.
   *
   * Nothing is computed that the individual endpoints do not already compute;
   * this is a different *shape*, not a different set of numbers, and the two
   * must never be able to disagree. That is why the per-dimension helpers are
   * shared rather than reimplemented.
   *
   * ---------------------------------------------------------------------------
   * What is deliberately not in here
   * ---------------------------------------------------------------------------
   * The recent-orders table. It reads order rows rather than aggregates, and it
   * is guarded by ORDER_VIEW_ALL / ORDER_VIEW_ACCOUNT rather than REPORT_VIEW —
   * bundling it would hand order detail to anyone holding the reporting
   * permission alone. A dashboard fetches it from `GET /orders` alongside this.
   */
  async dashboard(actor: AuthenticatedActor, query: DashboardQueryDto): Promise<DashboardReport> {
    if (query.scope === 'platform' && actor.role !== Role.ADMIN) {
      throw new ForbiddenError('The platform-wide dashboard is administrator-only');
    }

    // The only place a null account is produced, and it is produced one line
    // after the check that permits it. Everything downstream reads that null as
    // "every account, no tenant scope".
    const accountId =
      query.scope === 'platform' ? null : this.resolveAccount(actor, query.accountId);

    return this.cache.through(
      // The scope is part of the key by construction: an account key is the
      // account's id, and the platform key is a word no id can collide with.
      // Two actors who share a key must see the same payload, which is why
      // `activeAccounts` is populated in platform scope only.
      cacheKey('dashboard', accountId ?? 'platform', {
        from: query.from,
        to: query.to,
        siteId: query.siteId,
        granularity: query.granularity,
        limit: query.topSites,
      }),
      () => this.computeDashboard(accountId, query),
    );
  }

  private async computeDashboard(
    accountId: string | null,
    query: DashboardQueryDto,
  ): Promise<DashboardReport> {
    const range = resolveRange(query.from, query.to);
    const previous = previousRange(range);
    const granularity = query.granularity ?? defaultGranularity(range);

    const data = await this.runScoped(accountId, async (tx) => {
      const [current, before, orders, byStatus, queue, topSites, activeSites] = await Promise.all([
        this.totals(tx, accountId, range, query.siteId),
        this.totals(tx, accountId, previous, query.siteId),
        tx.order.findMany({
          where: this.spendWhere(accountId, range, query.siteId),
          select: { createdAt: true, total: true },
        }),
        this.statusRows(tx, accountId, range, query.siteId),
        this.queueCounts(tx, accountId, query.siteId),
        query.topSites === 0
          ? Promise.resolve<readonly DimensionRow[]>([])
          : this.siteSpendRows(tx, accountId, range, query.siteId),
        tx.site.count({
          where: {
            status: 'ACTIVE',
            deletedAt: null,
            ...(accountId ? { accountId } : {}),
            // A dashboard filtered to one branch reports a network of one, not
            // of the whole account. Anything else would put a number on the
            // card that contradicts every other number on the screen.
            ...(query.siteId ? { id: query.siteId } : {}),
          },
        }),
      ]);

      return { current, before, orders, byStatus, queue, topSites, activeSites };
    });

    // Outside the tenant scope on purpose: it is a platform-level count, it is
    // only ever asked for in platform scope, and asking for it inside a scope
    // bounded to one account would return that account and read as a bug.
    const activeAccounts =
      accountId === null
        ? await this.prisma.account.count({ where: { status: 'ACTIVE', deletedAt: null } })
        : null;

    const trend = this.bucketise(data.orders, range, granularity);
    const average =
      data.current.orders === 0
        ? new Prisma.Decimal(0)
        : data.current.spend.dividedBy(data.current.orders);
    const days = Math.max(1, (range.to.getTime() - range.from.getTime()) / 86_400_000);
    // Ties resolve to the earliest, which is the one a reader scanning the
    // chart left to right expects — the same rule `orderVelocity` uses.
    const busiest = trend.reduce<SpendBucket | null>(
      (best, bucket) => (best === null || bucket.orders > best.orders ? bucket : best),
      null,
    );

    return {
      scope: query.scope,
      accountId,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      granularity,
      spend: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        totalSpend: data.current.spend.toFixed(2),
        orderCount: data.current.orders,
        averageOrderValue: average.toFixed(2),
        siteCount: data.current.sites,
        previous: { totalSpend: data.before.spend.toFixed(2), orderCount: data.before.orders },
        spendGrowthPercent: growthPercent(Number(data.current.spend), Number(data.before.spend)),
        orderGrowthPercent: growthPercent(data.current.orders, data.before.orders),
      },
      pace: {
        ordersPerDay: Math.round((data.current.orders / days) * 10) / 10,
        busiestBucket: busiest && busiest.orders > 0 ? busiest.bucket : null,
        busiestBucketOrders: busiest?.orders ?? 0,
      },
      trend,
      byStatus: data.byStatus,
      queue: data.queue,
      network: { activeSites: data.activeSites, activeAccounts },
      topSites: data.topSites.slice(0, query.topSites),
    };
  }

  /**
   * The live queue, deliberately unwindowed.
   *
   * An order placed six weeks ago and still in production is work somebody is
   * waiting on today. Filtering this by the reporting window would hide exactly
   * the orders a fulfilment team most needs to see, and the longer one is stuck
   * the more certainly it would disappear.
   */
  private async queueCounts(
    tx: Prisma.TransactionClient,
    accountId: string | null,
    siteId?: string,
  ): Promise<DashboardQueue> {
    const grouped = await tx.order.groupBy({
      by: ['status'],
      where: {
        ...(accountId ? { accountId } : {}),
        status: { in: [...OPEN_STATUSES] },
        ...(siteId ? { siteId } : {}),
      },
      _count: { _all: true },
    });

    const count = (statuses: readonly OrderStatus[]): number =>
      grouped.reduce(
        (sum, row) => (statuses.includes(row.status) ? sum + row._count._all : sum),
        0,
      );

    return {
      open: grouped.reduce((sum, row) => sum + row._count._all, 0),
      awaitingApproval: count(AWAITING_APPROVAL_STATUSES),
      inFulfilment: count(IN_FULFILMENT_STATUSES),
      awaitingDispatch: count(AWAITING_DISPATCH_STATUSES),
      inTransit: count(IN_TRANSIT_STATUSES),
    };
  }

  /**
   * The `where` every spend figure shares.
   *
   * A null account means the platform scope — no account predicate, and no
   * tenant scope around the query either. `dashboard()` is the only caller that
   * can produce it, and only for an administrator who asked for it explicitly.
   */
  private spendWhere(
    accountId: string | null,
    range: DateRange,
    siteId?: string,
  ): Prisma.OrderWhereInput {
    return {
      ...(accountId ? { accountId } : {}),
      status: { in: SPEND_STATUSES },
      createdAt: { gte: range.from, lt: range.to },
      ...(siteId ? { siteId } : {}),
    };
  }

  /**
   * Runs a read under the right scope for the account it was given.
   *
   * The one place the platform scope skips `withTenantScope`, so there is a
   * single line to audit rather than a null check scattered across every query.
   */
  private runScoped<T>(
    accountId: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return accountId === null ? fn(this.prisma) : withTenantScope(this.prisma, accountId, fn);
  }

  private async totals(
    tx: Prisma.TransactionClient,
    accountId: string | null,
    range: DateRange,
    siteId?: string,
  ): Promise<{ spend: Prisma.Decimal; orders: number; sites: number }> {
    const where = this.spendWhere(accountId, range, siteId);

    const [aggregate, sites] = await Promise.all([
      tx.order.aggregate({ where, _sum: { total: true }, _count: { _all: true } }),
      tx.order.findMany({ where, select: { siteId: true }, distinct: ['siteId'] }),
    ]);

    return {
      spend: aggregate._sum.total ?? new Prisma.Decimal(0),
      orders: aggregate._count._all,
      sites: sites.length,
    };
  }

  /** Adds each row's share of the total, and orders biggest first. */
  private withShares(
    rows: { id: string; label: string; sublabel?: string; spend: Prisma.Decimal; orders: number }[],
  ): DimensionRow[] {
    const total = rows.reduce((sum, row) => sum.plus(row.spend), new Prisma.Decimal(0));

    return rows
      .map((row) => ({
        id: row.id,
        label: row.label,
        ...(row.sublabel ? { sublabel: row.sublabel } : {}),
        spend: row.spend.toFixed(2),
        orders: row.orders,
        // Zero rather than null when nothing was spent: every row's share of
        // nothing is nothing, and a null here would only complicate the chart.
        sharePercent: total.isZero()
          ? 0
          : Math.round(row.spend.dividedBy(total).times(1000).toNumber()) / 10,
      }))
      .sort((a, b) => Number(b.spend) - Number(a.spend));
  }

  private resolveAccount(actor: AuthenticatedActor, requested?: string): string {
    if (actor.role === Role.ADMIN && requested) return requested;
    return actor.accountId;
  }
}
