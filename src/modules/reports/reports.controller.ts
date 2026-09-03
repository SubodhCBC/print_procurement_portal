import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Permission, RequirePermissions, type AuthenticatedActor } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth';
import {
  ReportsService,
  type DashboardReport,
  type DimensionRow,
  type InventoryReport,
  type SpendBucket,
  type SpendSummary,
  type TopProductRow,
  type StatusRow,
  type TurnoverRow,
  type VelocityReport,
} from './reports.service';
import {
  DashboardQuerySchema,
  InventoryQuerySchema,
  ReportRangeQuerySchema,
  TopProductsQuerySchema,
  type DashboardQueryDto,
  type InventoryQueryDto,
  type ReportRangeQueryDto,
  type TopProductsQueryDto,
} from './dto/report.dto';
import type { Granularity } from './report-periods';

/**
 * Analytics and reporting (SOW BE-10, FE-12).
 *
 * `REPORT_VIEW`, which head office holds — a customer can analyse their own
 * spending. The service pins any non-administrator to their own account before
 * a query is built, so the permission and the scope cannot disagree.
 *
 * Every figure is computed live from orders. There is no rollup table and no
 * nightly job: a stored aggregate is a second copy of a number, and the two
 * disagree the first time an order is cancelled after the rollup ran.
 */
@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'Every dashboard card and chart, in one call',
    description:
      'The bundle a dashboard opens on: headline spend with its trend, the spend chart, the ' +
      'status breakdown, the live fulfilment queue, the size of the network and the ' +
      'biggest-spending branches. One round trip instead of seven, and — more importantly — ' +
      'one resolved date range, so the cards cannot disagree with the chart beside them.\n\n' +
      '**Two clocks, deliberately.** `spend`, `trend`, `byStatus`, `pace` and `topSites` cover ' +
      'the window. `queue` and `network` are a snapshot of *now* and ignore it: an order placed ' +
      'six weeks ago and still in production is work somebody is waiting on today, and a ' +
      'thirty-day window would hide exactly the orders a fulfilment team most needs to see.\n\n' +
      '**Scope.** `account` (the default) reports on the caller’s account, or on ' +
      '`accountId` when an administrator supplies one. `scope=platform` spans every customer ' +
      'and is administrator-only — it is asked for explicitly rather than inferred from the ' +
      'caller’s role, so drilling into one customer and surveying the estate are two ' +
      'different requests. `network.activeAccounts` is populated in platform scope only.\n\n' +
      'The recent-orders table is **not** here: it reads order rows rather than aggregates and ' +
      'is guarded by `ORDER_VIEW_ALL` / `ORDER_VIEW_ACCOUNT`, so bundling it would hand order ' +
      'detail to anyone holding `REPORT_VIEW` alone. Fetch it from `GET /orders` alongside.',
  })
  async dashboard(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(DashboardQuerySchema)) query: DashboardQueryDto,
  ): Promise<DashboardReport> {
    return this.reports.dashboard(actor, query);
  }

  @Get('spend/summary')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'Headline spend, with the trend against the previous window',
    description:
      'The comparison window is the same *length* immediately before, not the previous ' +
      'calendar month: comparing a 31-day January against a 28-day February makes every ' +
      'February look like a downturn.\n\n' +
      '`spendGrowthPercent` is null when the previous window had nothing to compare against — ' +
      'a month following a month of zero has not grown by infinity.',
  })
  async spendSummary(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<SpendSummary> {
    return this.reports.spendSummary(actor, query);
  }

  @Get('spend/over-time')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'Spend per day, week or month',
    description:
      'Empty buckets are included. A chart that skips days with no orders draws a straight ' +
      'line through them and silently overstates a quiet week.\n\n' +
      'Weeks start on Monday. Omit `granularity` and the range picks one.',
  })
  async spendOverTime(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<{ granularity: Granularity; buckets: readonly SpendBucket[] }> {
    return this.reports.spendOverTime(actor, query);
  }

  @Get('spend/by-site')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({ summary: 'Spend per branch, biggest first' })
  async spendBySite(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    return this.reports.spendBySite(actor, query);
  }

  @Get('spend/by-category')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'Spend per product category',
    description:
      'Computed from order lines, so an order spanning three categories contributes to all ' +
      'three rather than landing wholly in one.',
  })
  async spendByCategory(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    return this.reports.spendByCategory(actor, query);
  }

  @Get('products/top')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'The SKUs that account for the most spend, or the most units',
    description:
      'Ranked on the *snapshotted* SKU and name from the order line, not the live product, so ' +
      'a product renamed since does not split its own history in two.',
  })
  async topProducts(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(TopProductsQuerySchema)) query: TopProductsQueryDto,
  ): Promise<readonly TopProductRow[]> {
    return this.reports.topProducts(actor, query);
  }

  @Get('spend/by-account')
  // ACCOUNT_MANAGE, not REPORT_VIEW: this is the one report that spans every
  // customer, and it is the same guard AccountsService.list() relies on.
  @RequirePermissions(Permission.ACCOUNT_MANAGE)
  @ApiOperation({
    summary: 'Spend per customer account',
    description:
      'Cross-tenant by nature, and therefore administrator-only. The permission is the whole ' +
      'boundary here — there is no tenant scope to fall back on.',
  })
  async spendByAccount(
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    return this.reports.spendByAccount(query);
  }

  @Get('spend/by-region')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'Spend by delivery region',
    description:
      "Read from each order's frozen delivery snapshot, not from the address row: an address " +
      'corrected after the fact must not move historical spend between regions.\n\n' +
      'Orders with no region recorded are grouped under their own row rather than dropped — a ' +
      'total that silently omitted them would not reconcile with the headline.',
  })
  async spendByRegion(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<readonly DimensionRow[]> {
    return this.reports.spendByRegion(actor, query);
  }

  @Get('orders/by-status')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'How many orders sit at each status, and what they are worth',
    description:
      'The pipeline breakdown a dashboard charts. One grouped query — asking per status would ' +
      'be a round trip each for something the database answers in a single pass.\n\n' +
      'Counts every status, unlike the spend reports: rejected and cancelled orders are exactly ' +
      'what a "where is work stuck" view has to show. `sharePercent` is a share of the order ' +
      'count rather than of the money, so one large order cannot make a busy queue look empty.',
  })
  async ordersByStatus(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<readonly StatusRow[]> {
    return this.reports.ordersByStatus(actor, query);
  }

  @Get('orders/velocity')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiOperation({
    summary: 'How fast orders are arriving',
    description:
      'A different question from spend: a month of many small orders and a month of one large ' +
      'one look identical on a revenue chart and mean very different things to a production ' +
      'team.\n\n' +
      'Carries the orders-per-day rate, the busiest bucket, and the change against the same ' +
      'length of time immediately before.',
  })
  async orderVelocity(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
  ): Promise<VelocityReport> {
    return this.reports.orderVelocity(actor, query);
  }

  @Get('inventory/turnover')
  // Administrator-only for the same reason the warehouse report is: it spans
  // the whole global catalogue, including lines restricted to one customer.
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({
    summary: 'How fast stock is moving relative to what is held',
    description:
      'Units shipped come from DISPATCHED and DELIVERED orders only — goods still in ' +
      'production have not left the shelf, and counting them would overstate movement in ' +
      'exactly the month a large order was placed and not yet filled.\n\n' +
      '`turnoverRatio` divides by *current* stock, not by average stock over the period: this ' +
      'system keeps no history of shelf counts, so the accounting definition is not available. ' +
      'It is named for what it is rather than borrowed and quietly wrong. `daysOfCover` is the ' +
      'operationally useful figure and needs no history.',
  })
  async inventoryTurnover(
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
    @Query(zodBody(InventoryQuerySchema)) limits: InventoryQueryDto,
  ): Promise<readonly TurnoverRow[]> {
    return this.reports.inventoryTurnover(query, limits.limit);
  }

  @Get('inventory')
  // INVENTORY_MANAGE, not INVENTORY_VIEW. This lists every tracked product in
  // the *global* catalogue and does not go through
  // `ProductsService.visibilityFilter()` — so a customer holding INVENTORY_VIEW
  // (head office does) would see RESTRICTED lines belonging to another
  // customer's contract. Reordering the warehouse is the operator's job, and
  // INVENTORY_MANAGE is in no customer role.
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({
    summary: 'What needs attention in the warehouse',
    description:
      'Only the items that are low or out — a thousand rows of nothing wrong is not a report. ' +
      'Status is judged on the shelf count rather than on what is available, because this ' +
      'drives reordering and what needs buying is decided by what is physically there.\n\n' +
      'Administrator-only: it reads the whole global catalogue, including lines restricted to ' +
      "another customer's contract.",
  })
  async inventory(
    @Query(zodBody(InventoryQuerySchema)) query: InventoryQueryDto,
  ): Promise<InventoryReport> {
    return this.reports.inventory(query.limit);
  }

  @Get('spend/by-site.csv')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Spend per branch, as CSV',
    description:
      'The exportable endpoint the statement of work asks for. Cells beginning with a formula ' +
      'character are prefixed with an apostrophe, for the same reason the invoice export does ' +
      'it — a branch name is free text and this file is opened in Excel.',
  })
  async spendBySiteCsv(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const rows = await this.reports.spendBySite(actor, query);
    const csv = toCsv(
      ['Branch code', 'Branch', 'Orders', 'Spend', 'Share %'],
      rows.map((row) => [
        row.sublabel ?? '',
        row.label,
        String(row.orders),
        row.spend,
        String(row.sharePercent),
      ]),
    );

    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="spend-by-branch.csv"')
      .send(csv);
  }

  @Get('spend/by-category.csv')
  @RequirePermissions(Permission.REPORT_VIEW)
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Spend per category, as CSV' })
  async spendByCategoryCsv(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ReportRangeQuerySchema)) query: ReportRangeQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const rows = await this.reports.spendByCategory(actor, query);
    const csv = toCsv(
      ['Category', 'Orders', 'Spend', 'Share %'],
      rows.map((row) => [row.label, String(row.orders), row.spend, String(row.sharePercent)]),
    );

    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="spend-by-category.csv"')
      .send(csv);
  }
}

function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * The same guard the invoice export uses.
 *
 * A leading `=`, `+`, `-` or `@` is a formula prefix Excel executes on open, and
 * a branch name or a category name is free text an administrator typed.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
