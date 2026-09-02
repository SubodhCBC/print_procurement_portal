/**
 * Every asynchronous work stream in the platform. Queues are declared up front
 * so that infrastructure (dashboards, alerts, dead-letter handling) exists
 * before the first job is written, and so nobody invents an ad-hoc queue name
 * at 2am.
 *
 * A queue exists per *failure domain*, not per feature: a stuck render job must
 * never block an approval email.
 */
export const QueueName = {
  /** Transactional email: order placed, approval requested, dispatched. */
  EMAIL: 'email',
  /** Outbound integrations (PrintFlow, 3PL, ERP) drained from the outbox. */
  WEBHOOK: 'webhook',
  /** Template -> print-ready CMYK PDF. Slow, memory hungry, isolated. */
  RENDER: 'render',
  /** Monthly consolidation, invoice PDFs, accounting exports. */
  BILLING: 'billing',
  /** Large CSV/XLSX report generation delivered via object storage. */
  REPORT: 'report',
  /**
   * Bulk catalogue loads. Its own failure domain rather than sharing REPORT:
   * both are long-running bulk work, but an import saturates database write
   * capacity while a report saturates memory and storage — and a customer
   * waiting on an invoice export should not queue behind a ten-thousand-row
   * catalogue load.
   */
  IMPORT: 'import',
  /** Scheduled housekeeping: orphan assets, expired sessions, stale carts. */
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QueueName);
