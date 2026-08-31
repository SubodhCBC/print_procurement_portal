import { loadConfig } from '@/config';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * BullMQ requires `maxRetriesPerRequest: null` — with the ioredis default a
 * blocking `BRPOPLPUSH` is aborted mid-wait and the worker dies silently.
 */
export function buildRedisOptions(overrides: RedisOptions = {}): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // A worker that cannot reach Redis should keep retrying, not crash-loop.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...overrides,
  } satisfies RedisOptions;
}

/** Shared connection for producers. Workers create their own (blocking) one. */
export function createRedisConnection(overrides: RedisOptions = {}): Redis {
  const config = loadConfig();
  return new Redis(config.redis.url, buildRedisOptions(overrides));
}

/** Namespaces every BullMQ key so multiple environments can share one Redis. */
export function queuePrefix(): string {
  return loadConfig().redis.queuePrefix;
}
