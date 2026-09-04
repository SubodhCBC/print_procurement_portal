import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QueueName } from '@/shared/queue';
import { AssetDerivativeService, DerivativeJobSchema } from './asset-derivative.service';

/**
 * Drains the `render` queue for product-image derivatives.
 *
 * The only consumer on that queue today, and deliberately so. BullMQ hands each
 * job to exactly one worker, so a second `@Processor(RENDER)` elsewhere would
 * quietly eat this one's jobs and mark them complete. Anything new that needs
 * the render queue — the template builder's CMYK PDF, for one — dispatches from
 * here on the job name rather than by adding a worker.
 *
 * The name is still checked rather than assumed, for that same eventual second
 * kind of job: an unrecognised name is left alone, not failed.
 *
 * Concurrency is fixed at two rather than read from RENDER_CONCURRENCY: the
 * decorator needs a static value, and image decoding is memory-hungry enough
 * that a high setting is how a worker gets itself killed by the OOM reaper.
 * When the template renderer lands and this queue needs real tuning, the worker
 * options move to `BullModule.registerQueue` where config can reach them.
 */
@Processor(QueueName.RENDER, { concurrency: 2 })
export class DerivativeProcessor extends WorkerHost {
  private readonly logger = new Logger(DerivativeProcessor.name);

  static readonly JOB_NAME = 'product-image-derivatives';

  constructor(private readonly derivatives: AssetDerivativeService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== DerivativeProcessor.JOB_NAME) {
      // Another kind of render job. Left for whichever processor owns it rather
      // than failed, so adding the template renderer later needs no change here.
      this.logger.debug(`Ignoring render job "${job.name}".`);
      return;
    }

    const { assetId, target } = DerivativeJobSchema.parse(job.data);
    await this.derivatives.generate(assetId, target);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job ? `${job.attemptsMade}/${job.opts.attempts ?? 1}` : 'unknown';
    this.logger.error(
      `Render job ${job?.id ?? '?'} ("${job?.name ?? '?'}") failed on attempt ${attempts}: ` +
        error.message,
    );
  }
}
