import type { DefaultJobOptions } from 'bullmq';

/**
 * Retry policies are a product decision, not a per-call afterthought, so they
 * live here and are referenced by name.
 *
 * `removeOnComplete` is bounded rather than `true`: keeping the recent tail
 * makes incident triage possible without letting Redis grow without limit.
 */
const baseOptions: DefaultJobOptions = {
  removeOnComplete: { age: 60 * 60 * 24, count: 1_000 },
  removeOnFail: { age: 60 * 60 * 24 * 14 },
};

/** Fast, idempotent work — a few quick retries then give up loudly. */
export const STANDARD_RETRY: DefaultJobOptions = {
  ...baseOptions,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
};

/** Email: a transient SMTP failure should not lose a notification. */
export const EMAIL_RETRY: DefaultJobOptions = {
  ...baseOptions,
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
};

/**
 * Outbound webhooks: partner systems go down for hours. Eight attempts with
 * exponential backoff spans roughly a day before the job is dead-lettered for
 * manual replay.
 */
export const WEBHOOK_RETRY: DefaultJobOptions = {
  ...baseOptions,
  attempts: 8,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnFail: false, // failed deliveries stay inspectable and replayable
};

/** Rendering is expensive; retrying a genuinely broken template wastes minutes. */
export const RENDER_RETRY: DefaultJobOptions = {
  ...baseOptions,
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
};
