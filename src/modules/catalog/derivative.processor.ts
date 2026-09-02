import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QueueName } from '@/shared/queue';
import { AssetDerivativeService, DerivativeJobSchema } from './asset-derivative.service';

/**
 * Drains the `render` queue for product-image derivatives.
 *
 * The first consumer on that queue. It will not be the only one — the template
 * builder's CMYK PDF render belongs here too — which is why the job name is
 * checked rather than assumed: a render worker will eventually see more than
 * one kind of job and must not try to resize a template.
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

    const { assetId } = DerivativeJobSchema.parse(job.data);
    await this.derivatives.generate(assetId);
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
