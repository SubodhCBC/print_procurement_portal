import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { DependencyUnavailableError } from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';
import type { RenderedMail } from './mail.templates';

export interface OutboundMail extends RenderedMail {
  readonly to: string;
  readonly replyTo?: string;
}

/**
 * Delivers a rendered message.
 *
 * Deliberately dumb: it does not know what an invitation is, it does not retry,
 * and it does not decide when to send. Retries belong to the EMAIL queue, whose
 * backoff policy already exists in shared/queue/job-options.ts — duplicating
 * them here would mean two competing retry budgets for the same failure.
 *
 * Callers should enqueue an `email` job rather than calling this directly, so a
 * mail server outage delays a notification instead of failing the request that
 * triggered it. The one exception is the worker, which is what drains the queue.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private transporter?: Transporter;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Built on first use rather than in the constructor.
   *
   * The API process may never send an email — it only enqueues — and opening an
   * SMTP connection pool at boot would make a mail server outage delay or fail
   * the startup of a service that does not need it.
   */
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const { mail } = this.config;

    if (mail.transport === 'console') {
      // `jsonTransport` resolves without any network I/O and hands the message
      // back on the result, which is what makes it usable in tests and in a
      // sandbox that has no SMTP server at all.
      this.transporter = createTransport({ jsonTransport: true });
      return this.transporter;
    }

    if (mail.transport !== 'smtp') {
      // sendgrid and postmark are accepted by the env schema because the
      // statement of work names them, but neither adapter is written. Failing
      // loudly here beats silently dropping every notification.
      throw new DependencyUnavailableError(
        `Mail transport "${mail.transport}" (no adapter is implemented; use "smtp" or "console")`,
      );
    }

    this.transporter = createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      ...(mail.user ? { auth: { user: mail.user, pass: mail.password ?? '' } } : {}),
      pool: true,
      maxConnections: 3,
      // Bounded so a hung mail server cannot hold a queue worker forever; the
      // job's own retry policy takes it from there.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    return this.transporter;
  }

  async send(mail: OutboundMail): Promise<void> {
    const { mail: config } = this.config;

    try {
      // `sendMail` is typed as returning `any` because the shape differs per
      // transport (SMTP, JSON, SES). Only the message id is used, so it is
      // narrowed to that here rather than spread through the call site.
      const info = (await this.getTransporter().sendMail({
        from: { name: config.fromName, address: config.fromAddress },
        to: mail.to,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      })) as { messageId?: string };

      if (config.transport === 'console') {
        this.logger.log(`[console transport] "${mail.subject}" to ${mail.to}`);
      } else {
        this.logger.log(
          `Sent "${mail.subject}" to ${mail.to} (${info.messageId ?? 'no message id'}).`,
        );
      }
    } catch (error) {
      // Wrapped so the queue's failure handling sees a typed dependency error
      // rather than a raw nodemailer object, and so the message body — which
      // may contain a single-use token — never reaches the log.
      throw new DependencyUnavailableError('Mail server', { cause: error });
    }
  }

  onModuleDestroy(): void {
    // `close()` is synchronous — it tears down the pooled sockets and returns.
    this.transporter?.close();
  }
}
