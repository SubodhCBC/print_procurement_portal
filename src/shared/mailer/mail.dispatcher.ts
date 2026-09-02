import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EMAIL_RETRY, QueueName } from '@/shared/queue';
import {
  MailJob,
  type ApprovalDecidedJobData,
  type ApprovalPendingJobData,
  type InvitationJobData,
  type LowStockJobData,
  type OrderDispatchedJobData,
  type OrderPlacedJobData,
  type PasswordResetJobData,
  type WelcomeJobData,
} from './mail.job';

/**
 * Enqueues transactional email. The only thing feature modules should call.
 *
 * Sending inline would tie a user-facing request to an SMTP round trip: an
 * invitation would fail to be created because the mail server was slow, and the
 * administrator would retry, creating a second invitation. Enqueuing decouples
 * the two, and the EMAIL_RETRY policy (five attempts, exponential from 5s)
 * means a transient outage delays the message rather than losing it.
 *
 * Every method swallows nothing: if Redis is unreachable the caller finds out,
 * because an invitation that will never be delivered is worse than a failed
 * request the administrator can repeat.
 */
@Injectable()
export class MailDispatcher {
  private readonly logger = new Logger(MailDispatcher.name);

  constructor(@InjectQueue(QueueName.EMAIL) private readonly queue: Queue) {}

  async sendInvitation(data: InvitationJobData): Promise<void> {
    await this.enqueue(MailJob.INVITATION, data);
  }

  async sendPasswordReset(data: PasswordResetJobData): Promise<void> {
    await this.enqueue(MailJob.PASSWORD_RESET, data);
  }

  async sendWelcome(data: WelcomeJobData): Promise<void> {
    await this.enqueue(MailJob.WELCOME, data);
  }

  // --- Order notifications (SOW BE-08) ----------------------------------------
  //
  // Every one of these is called *after* its transaction commits, never inside
  // it. A message announcing an order that then failed to save is not
  // retractable, and the queue's own retry is the thing that makes delivery
  // reliable — not the database transaction.

  async sendOrderPlaced(data: OrderPlacedJobData): Promise<void> {
    await this.enqueue(MailJob.ORDER_PLACED, data);
  }

  async sendApprovalPending(data: ApprovalPendingJobData): Promise<void> {
    await this.enqueue(MailJob.APPROVAL_PENDING, data);
  }

  async sendApprovalDecided(data: ApprovalDecidedJobData): Promise<void> {
    await this.enqueue(MailJob.APPROVAL_DECIDED, data);
  }

  async sendOrderDispatched(data: OrderDispatchedJobData): Promise<void> {
    await this.enqueue(MailJob.ORDER_DISPATCHED, data);
  }

  async sendLowStock(data: LowStockJobData): Promise<void> {
    await this.enqueue(MailJob.LOW_STOCK, data);
  }

  private async enqueue(name: MailJob, data: object): Promise<void> {
    await this.queue.add(name, data, EMAIL_RETRY);
    // The recipient is logged, the payload is not — invitation and reset
    // payloads carry a single-use token.
    this.logger.log(`Queued "${name}" email.`);
  }
}
