import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QueueName } from '@/shared/queue';
import { ImportJobPayloadSchema, ProductImportService } from './product-import.service';

/**
 * Drains the `import` queue.
 *
 * Concurrency of one, deliberately. An import is a long run of database writes
 * keyed on SKU, and two of them in parallel can be loading the same file twice
 * — the second would find rows the first had just created and report them as
 * skipped, which looks like data loss to whoever uploaded it. Imports are not
 * latency-sensitive; serialising them costs nothing anyone notices.
 */
@Processor(QueueName.IMPORT, { concurrency: 1 })
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(private readonly imports: ProductImportService) {
    super();
  }

  async process(job: Job): Promise<void> {
    // Parsed with the same schema the producer used. A job left in Redis from
    // before a deploy can carry a shape this build does not understand, and
    // that should be a clean failure rather than a TypeError halfway through.
    const { jobId } = ImportJobPayloadSchema.parse(job.data);
    await this.imports.run(jobId);
  }

  /**
   * BullMQ swallows worker errors unless something listens. The job row is
   * already marked FAILED by `run()`; this is what makes it visible in the logs
   * as well.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job ? `${job.attemptsMade}/${job.opts.attempts ?? 1}` : 'unknown';
    this.logger.error(
      `Catalogue import job ${job?.id ?? '?'} failed on attempt ${attempts}: ${error.message}`,
    );
  }
}
