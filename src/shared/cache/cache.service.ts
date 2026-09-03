import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '@/config';
import { createRedisConnection } from './redis.connection';

/**
 * A short-lived read-through cache for expensive reads (SOW BE-13).
 *
 * ---------------------------------------------------------------------------
 * What belongs in here, and what does not
 * ---------------------------------------------------------------------------
 * Only aggregates that a user reads and never writes: the reporting endpoints.
 * Nothing transactional is cached — a cart, an order, a stock level or a
 * permission set read from a cache is a correctness bug waiting for the moment
 * two people act on the same row.
 *
 * ---------------------------------------------------------------------------
 * Why the TTL is short and there is no invalidation
 * ---------------------------------------------------------------------------
 * Sixty seconds by default, and nothing ever busts a key. Invalidation would
 * mean every order placement, cancellation, dispatch and stocktake reaching in
 * to delete the right keys — a coupling that grows with every feature and
 * fails silently when one path forgets. A dashboard that is up to a minute
 * behind is a trade a finance team will make without noticing; a dashboard
 * that is *wrong* because an invalidation was missed is not.
 *
 * Set `CACHE_TTL_SECONDS=0` to switch it off entirely; every method then behaves
 * as a pass-through, which is what the tests run with.
 *
 * ---------------------------------------------------------------------------
 * Redis being down is not an error
 * ---------------------------------------------------------------------------
 * A cache miss and a cache outage produce the same result: the value is
 * computed. Failures are logged once and swallowed, because a reporting page
 * that 500s when Redis restarts is worse than one that is briefly slower.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  /** Logged once per process rather than per request, so an outage is not a flood. */
  private warned = false;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.redis = createRedisConnection(config.redis);
    this.ttlSeconds = config.cache?.ttlSeconds ?? 60;
  }

  /**
   * Returns the cached value, or computes and stores it.
   *
   * The key must already carry everything the value depends on — the actor's
   * account, the window, every filter. Building it is the caller's job because
   * only the caller knows what varies, and a key that forgets a dimension
   * serves one customer another's numbers.
   */
  async through<T>(key: string, compute: () => Promise<T>): Promise<T> {
    if (this.ttlSeconds <= 0) return compute();

    const hit = await this.read<T>(key);
    if (hit !== undefined) return hit;

    const value = await compute();
    await this.write(key, value);
    return value;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (error) {
      this.warnOnce(error);
      return undefined;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
    } catch (error) {
      this.warnOnce(error);
    }
  }

  private warnOnce(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(
      'Cache unavailable; falling through to the database. ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

/** Anything a cache key may be built from. */
export type CacheKeyPart = string | number | boolean | Date | null | undefined;

/**
 * Builds a cache key from an actor's scope and a query.
 *
 * The account is always first and never optional: it is the dimension that must
 * never be missed, and putting it at the front makes a key that forgot it
 * obvious on sight.
 */
export function cacheKey(
  namespace: string,
  accountId: string,
  parts: Record<string, CacheKeyPart>,
): string {
  // Sorted, so two callers passing the same filters in a different order share
  // a key rather than each computing their own copy.
  const encoded = Object.keys(parts)
    .sort()
    .map((name) => `${name}=${encodePart(parts[name])}`)
    .join('&');

  return `cache:${namespace}:${accountId}:${encoded}`;
}

function encodePart(value: CacheKeyPart): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
