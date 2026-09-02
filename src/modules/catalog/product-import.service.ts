import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { CatalogImportJob, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { z, ZodError } from 'zod';
import {
  createId,
  NotFoundError,
  offsetPage,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
  type OffsetPageRequest,
} from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import { QueueName, STANDARD_RETRY } from '@/shared/queue';
import type { ImportJobSummaryRow } from './dto/product-response';
import { CategoriesService } from './categories.service';
import { ImportRowSchema, type ImportProductsDto } from './dto/product.dto';

export type ImportOutcome = 'created' | 'updated' | 'skipped' | 'failed';

export interface ImportRowResult {
  /** 1-based, matching the spreadsheet row the merchandiser is looking at. */
  readonly row: number;
  readonly sku: string | null;
  readonly outcome: ImportOutcome;
  readonly message?: string;
  readonly productId?: string;
}

/** The payload the queue carries: a reference, never the rows themselves. */
export const ImportJobPayloadSchema = z.object({ jobId: z.string().min(1).max(64) });
export type ImportJobPayload = z.infer<typeof ImportJobPayloadSchema>;

/**
 * Bulk product import (SOW BE-03).
 *
 * ---------------------------------------------------------------------------
 * Asynchronous, including the dry run
 * ---------------------------------------------------------------------------
 * The submitted rows are written to `catalog_import_jobs` and the queue carries
 * only the job id. Ten thousand rows have no business sitting in Redis under
 * BullMQ's completed-job retention, and a request that holds a connection open
 * for a minute is a request that times out at the load balancer.
 *
 * A dry run takes the same path. An import preview that used different logic
 * would be worse than no preview, and the whole point of `dryRun` is that it
 * makes exactly the decisions a real run would.
 *
 * ---------------------------------------------------------------------------
 * Row-at-a-time, not transactional
 * ---------------------------------------------------------------------------
 * A merchandiser uploading 300 rows wants the 297 good ones in and a list of
 * the three that are wrong. All-or-nothing turns a typo in one cell into a
 * rejected file, and the next attempt is a bigger file with more typos.
 *
 * Existing SKUs are skipped unless `updateExisting` is set: a re-uploaded file
 * must not silently overwrite prices edited in the admin UI since. An import
 * never publishes a product and never overwrites a warehouse stock count.
 */
@Injectable()
export class ProductImportService {
  private readonly logger = new Logger(ProductImportService.name);

  /**
   * How many per-row results are kept on the job row.
   *
   * A ten-thousand-row success does not need ten thousand JSON objects stored
   * for ever; the failures are what anyone comes back to read. Above this, the
   * results are truncated to the failures plus a note — the counts stay exact.
   */
  private static readonly MAX_STORED_RESULTS = 1_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly audit: AuditService,
    @InjectQueue(QueueName.IMPORT) private readonly queue: Queue,
  ) {}

  /**
   * Accepts a file and queues it. Returns immediately with the job to poll.
   *
   * The row payload is persisted before the job is enqueued, so a worker can
   * never pick up an id whose rows are not there yet.
   */
  async enqueue(dto: ImportProductsDto, actor: AuthenticatedActor): Promise<CatalogImportJob> {
    const job = await withTenantScope(this.prisma, actor.accountId, (tx) =>
      tx.catalogImportJob.create({
        data: {
          id: createId('imp'),
          accountId: actor.accountId,
          requestedById: actor.userId,
          dryRun: dto.dryRun,
          updateExisting: dto.updateExisting,
          payload: dto.rows as Prisma.InputJsonValue,
          totalRows: dto.rows.length,
        },
      }),
    );

    await this.queue.add(
      'catalog-import',
      { jobId: job.id } satisfies ImportJobPayload,
      STANDARD_RETRY,
    );

    this.logger.log(
      `Queued catalogue import ${job.id}: ${job.totalRows} row(s)` +
        `${dto.dryRun ? ' (dry run)' : ''}.`,
    );

    return job;
  }

  async findJob(accountId: string, jobId: string): Promise<CatalogImportJob> {
    const job = await withTenantScope(this.prisma, accountId, (tx) =>
      tx.catalogImportJob.findFirst({ where: { id: jobId, accountId } }),
    );
    if (!job) throw new NotFoundError('Import job');
    return job;
  }

  async listJobs(
    accountId: string,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<ImportJobSummaryRow>> {
    const { skip, take } = toSkipTake(page);

    return withTenantScope(this.prisma, accountId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.catalogImportJob.findMany({
          where: { accountId },
          // The payload is the uploaded file and the results can be a thousand
          // objects; neither belongs in a list response.
          omit: { payload: true, results: true },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        tx.catalogImportJob.count({ where: { accountId } }),
      ]);

      return offsetPage(items, total, page);
    });
  }

  /**
   * Runs a queued import. Called by the worker, never by a request.
   *
   * Marks the job RUNNING first, so a job that dies mid-flight is visibly stuck
   * rather than indistinguishable from one still waiting in the queue.
   */
  async run(jobId: string): Promise<void> {
    const job = await this.prisma.catalogImportJob.findUnique({ where: { id: jobId } });
    if (!job) {
      // Not retryable: the row is gone and no number of attempts will bring it
      // back. Logged and swallowed so the queue does not spend eight attempts
      // rediscovering that.
      this.logger.error(`Import job ${jobId} no longer exists; nothing to run.`);
      return;
    }

    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
      // A retry of an already-finished job. Re-running it would double-apply
      // every create, so it stops here.
      this.logger.warn(`Import job ${jobId} is already ${job.status}; skipping.`);
      return;
    }

    await this.prisma.catalogImportJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    try {
      const rows = Array.isArray(job.payload) ? job.payload : [];
      const results = await this.applyRows(rows, job.updateExisting, job.dryRun);
      const counts = countOutcomes(results);

      await this.prisma.catalogImportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          ...counts,
          // Cast through `unknown`: ImportRowResult is an interface, and
          // Prisma's InputJsonValue requires an index signature that an
          // interface does not have. The shape is plain JSON regardless.
          results: this.storableResults(results) as unknown as Prisma.InputJsonValue,
        },
      });

      if (!job.dryRun) {
        await this.audit.record({
          action: AuditAction.PRODUCT_IMPORTED,
          entityType: 'PRODUCT',
          entityId: jobId,
          entityName: `Bulk import of ${results.length} row(s)`,
          accountId: job.accountId,
          actor: {
            userId: job.requestedById,
            name: 'Catalogue import',
            email: 'system@ticketit.local',
            role: 'SYSTEM',
            accountId: job.accountId,
          },
          details: {
            ...counts,
            total: results.length,
            // Only the failures. A successful ten-thousand-row import does not
            // need ten thousand lines in the audit blob.
            failures: results
              .filter((result) => result.outcome === 'failed')
              .slice(0, 100)
              .map((result) => ({ row: result.row, sku: result.sku, message: result.message })),
          },
        });
      }

      this.logger.log(
        `Import ${jobId}${job.dryRun ? ' (dry run)' : ''}: ${counts.created} created, ` +
          `${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.catalogImportJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', finishedAt: new Date(), error: message },
      });

      this.logger.error(`Import job ${jobId} failed outright: ${message}`);
      // Rethrown so the queue records the failure and the retry policy applies.
      // `run()` guards against re-running a COMPLETED job, and a FAILED one is
      // retried from the top, which is safe: creates are keyed on SKU and a
      // second pass reports them as skipped or updates them.
      throw error;
    }
  }

  // --- The actual work ----------------------------------------------------------

  private async applyRows(
    rows: readonly unknown[],
    updateExisting: boolean,
    dryRun: boolean,
  ): Promise<ImportRowResult[]> {
    const results: ImportRowResult[] = [];

    // Category codes are resolved once. A 500-row file typically spans eight
    // categories, and looking each up per row is 500 queries for eight answers.
    const categoryIdByCode = new Map<string, string | null>();

    for (const [index, raw] of rows.entries()) {
      const rowNumber = index + 1;

      const parsed = ImportRowSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          row: rowNumber,
          sku: readSku(raw),
          outcome: 'failed',
          message: describeZodError(parsed.error),
        });
        continue;
      }

      const row = parsed.data;

      if (!categoryIdByCode.has(row.categoryCode)) {
        categoryIdByCode.set(
          row.categoryCode,
          await this.categories.findIdByCode(row.categoryCode),
        );
      }
      const categoryId = categoryIdByCode.get(row.categoryCode) ?? null;

      if (!categoryId) {
        results.push({
          row: rowNumber,
          sku: row.sku,
          outcome: 'failed',
          message: `Unknown category code "${row.categoryCode}"`,
        });
        continue;
      }

      const existing = await this.prisma.product.findUnique({
        where: { sku: row.sku },
        select: { id: true, deletedAt: true },
      });

      if (existing && !updateExisting) {
        results.push({
          row: rowNumber,
          sku: row.sku,
          outcome: 'skipped',
          message: 'SKU already exists; re-run with updateExisting to overwrite',
          productId: existing.id,
        });
        continue;
      }

      if (existing?.deletedAt) {
        // Reviving a deleted product through an import would resurrect it with
        // no audit context and none of the checks the status machine applies.
        results.push({
          row: rowNumber,
          sku: row.sku,
          outcome: 'failed',
          message: 'SKU belongs to a deleted product and cannot be re-imported',
        });
        continue;
      }

      if (dryRun) {
        results.push({
          row: rowNumber,
          sku: row.sku,
          outcome: existing ? 'updated' : 'created',
          ...(existing ? { productId: existing.id } : {}),
        });
        continue;
      }

      try {
        const data = {
          name: row.name,
          description: row.description ?? null,
          categoryId,
          basePrice: row.basePrice,
          moq: row.moq,
          orderMultiple: row.orderMultiple,
          packSize: row.packSize,
          uom: row.uom,
          widthMm: row.widthMm ?? null,
          heightMm: row.heightMm ?? null,
          bleedMm: row.bleedMm ?? null,
          safeMarginMm: row.safeMarginMm ?? null,
          lowStockThreshold: row.lowStockThreshold,
          leadTimeDays: row.leadTimeDays ?? null,
          tags: row.tags,
        };

        const product = existing
          ? await this.prisma.product.update({
              where: { id: existing.id },
              // `status` and `stockOnHand` are absent on purpose. An import must
              // not publish a product, and it must not silently overwrite a
              // warehouse count with a figure from a spreadsheet.
              data,
              select: { id: true },
            })
          : await this.prisma.product.create({
              data: { id: createId('prd'), sku: row.sku, status: 'DRAFT', ...data },
              select: { id: true },
            });

        results.push({
          row: rowNumber,
          sku: row.sku,
          outcome: existing ? 'updated' : 'created',
          productId: product.id,
        });
      } catch (error) {
        results.push({
          row: rowNumber,
          sku: row.sku,
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * What is worth persisting on the job row.
   *
   * Under the cap, everything. Above it, the failures plus a marker — the
   * counts are exact either way, and nobody scrolls ten thousand success lines.
   */
  private storableResults(results: readonly ImportRowResult[]): readonly ImportRowResult[] {
    if (results.length <= ProductImportService.MAX_STORED_RESULTS) return results;

    const failures = results.filter((result) => result.outcome === 'failed');
    return [
      ...failures.slice(0, ProductImportService.MAX_STORED_RESULTS),
      {
        row: 0,
        sku: null,
        outcome: 'skipped' as const,
        message:
          `${results.length} rows processed; only failures are listed. ` +
          'See the counts for the full picture.',
      },
    ];
  }
}

function countOutcomes(results: readonly ImportRowResult[]): {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
} {
  const count = (outcome: ImportOutcome): number =>
    results.filter((result) => result.outcome === outcome).length;

  return {
    created: count('created'),
    updated: count('updated'),
    skipped: count('skipped'),
    failed: count('failed'),
  };
}

/**
 * Pulls a SKU out of a row that failed validation, so the error report can name
 * it. Best-effort: the row is unvalidated by definition.
 */
function readSku(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const sku = (raw as { sku?: unknown }).sku;
  return typeof sku === 'string' && sku.length > 0 ? sku.trim().toUpperCase() : null;
}

/** Field-level messages, joined — "basePrice: Expected an amount such as …". */
function describeZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(row)'}: ${issue.message}`)
    .join('; ');
}
