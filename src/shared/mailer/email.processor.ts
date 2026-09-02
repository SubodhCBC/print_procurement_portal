import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '@/config';
import { QueueName } from '@/shared/queue';
import { MailService } from './mail.service';
import {
  ApprovalDecidedJobSchema,
  ApprovalPendingJobSchema,
  InvitationJobSchema,
  LowStockJobSchema,
  MailJob,
  OrderDispatchedJobSchema,
  OrderPlacedJobSchema,
  PasswordResetJobSchema,
  WelcomeJobSchema,
} from './mail.job';
import {
  renderInvitationMail,
  renderPasswordResetMail,
  renderWelcomeMail,
  renderApprovalDecidedMail,
  renderApprovalPendingMail,
  renderLowStockMail,
  renderOrderDispatchedMail,
  renderOrderPlacedMail,
  type RenderedMail,
} from './mail.templates';

/**
 * Drains the `email` queue.
 *
 * The first queue consumer in the codebase, and the pattern the others follow:
 * parse the payload with the same schema the producer used, render, hand the
 * result to a service that knows nothing about queues, and let a thrown error
 * become a retry rather than catching it.
 *
 * It runs inside the API process today because there is no separate worker
 * deployment yet. Moving it out is a deployment change and an import — nothing
 * here assumes it shares a process with the HTTP server.
 */
@Processor(QueueName.EMAIL, { concurrency: 5 })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const rendered = this.render(job);
    await this.mail.send({ to: this.recipient(job), ...rendered });
  }

  private recipient(job: Job): string {
    const to = (job.data as { to?: unknown }).to;
    if (typeof to !== 'string' || to.length === 0) {
      // Thrown before any parsing so the failure message names the real problem.
      throw new Error(`Email job ${job.id} (${job.name}) has no recipient.`);
    }
    return to;
  }

  private render(job: Job): RenderedMail {
    const base = this.config.app.portalBaseUrl;

    switch (job.name) {
      case MailJob.INVITATION: {
        const data = InvitationJobSchema.parse(job.data);
        return renderInvitationMail({
          firstName: data.firstName,
          accountName: data.accountName,
          ...(data.inviterName ? { inviterName: data.inviterName } : {}),
          acceptUrl: `${base}/invitations/accept?token=${encodeURIComponent(data.token)}`,
          expiresAt: data.expiresAt,
          isExternal: data.isExternal,
        });
      }

      case MailJob.PASSWORD_RESET: {
        const data = PasswordResetJobSchema.parse(job.data);
        return renderPasswordResetMail({
          firstName: data.firstName,
          resetUrl: `${base}/password/reset?token=${encodeURIComponent(data.token)}`,
          expiresAt: data.expiresAt,
        });
      }

      case MailJob.WELCOME: {
        const data = WelcomeJobSchema.parse(job.data);
        return renderWelcomeMail({
          firstName: data.firstName,
          accountName: data.accountName,
          portalUrl: `${base}/login`,
        });
      }

      // --- Order notifications (SOW BE-08) ---------------------------------
      //
      // Each of these describes its order from the job payload rather than by
      // reading the database. A message must say what was true when the event
      // happened: re-reading now would let a job that ran after an amendment
      // announce the new order while claiming to be the old one's receipt.

      case MailJob.ORDER_PLACED: {
        const data = OrderPlacedJobSchema.parse(job.data);
        return renderOrderPlacedMail({
          firstName: data.firstName,
          order: data.order,
          awaitingApproval: data.awaitingApproval,
          orderUrl: `${base}/orders/${encodeURIComponent(data.order.orderId)}`,
        });
      }

      case MailJob.APPROVAL_PENDING: {
        const data = ApprovalPendingJobSchema.parse(job.data);
        return renderApprovalPendingMail({
          firstName: data.firstName,
          order: data.order,
          tier: data.tier,
          approvalsUrl: `${base}/approvals`,
        });
      }

      case MailJob.APPROVAL_DECIDED: {
        const data = ApprovalDecidedJobSchema.parse(job.data);
        return renderApprovalDecidedMail({
          firstName: data.firstName,
          order: data.order,
          decision: data.decision,
          decidedByName: data.decidedByName,
          comment: data.comment,
          orderUrl: `${base}/orders/${encodeURIComponent(data.order.orderId)}`,
        });
      }

      case MailJob.ORDER_DISPATCHED: {
        const data = OrderDispatchedJobSchema.parse(job.data);
        return renderOrderDispatchedMail({
          firstName: data.firstName,
          order: data.order,
          carrier: data.carrier,
          trackingNumber: data.trackingNumber,
          orderUrl: `${base}/orders/${encodeURIComponent(data.order.orderId)}`,
        });
      }

      case MailJob.LOW_STOCK: {
        const data = LowStockJobSchema.parse(job.data);
        return renderLowStockMail({
          firstName: data.firstName,
          items: data.items,
          inventoryUrl: `${base}/admin/inventory`,
        });
      }

      default:
        // An unknown name is a deploy-ordering problem, not a transient one.
        // It still consumes the retry budget and then dead-letters, which is
        // where it becomes visible.
        throw new Error(`No renderer for email job "${job.name}".`);
    }
  }

  /**
   * BullMQ swallows worker errors unless something listens. Without this a
   * failing mail job is invisible until someone notices the email never
   * arrived.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job ? `${job.attemptsMade}/${job.opts.attempts ?? 1}` : 'unknown';
    this.logger.error(
      `Email job ${job?.id ?? '?'} ("${job?.name ?? '?'}") failed on attempt ${attempts}: ` +
        error.message,
    );
  }
}
