import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createRedisConnection, queuePrefix } from '@/shared/cache';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

/**
 * @nestjs/throttler does not re-export this from its entrypoint. Declaring it
 * structurally keeps us off a `dist/` deep import that a patch release could
 * move; TypeScript still checks it against ThrottlerStorage.
 */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed rate limiting.
 *
 * The default in-memory storage counts per process, so with three API replicas
 * a "10 login attempts per minute" rule actually allows thirty. Rate limits are
 * a security control, so the counter has to be shared.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis: Redis = createRedisConnection();
  private readonly prefix = `${queuePrefix()}:throttle`;

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const counterKey = `${this.prefix}:${throttlerName}:${key}`;
    const blockKey = `${counterKey}:blocked`;

    const blockedFor = await this.redis.pttl(blockKey);
    if (blockedFor > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockedFor / 1000),
      };
    }

    const results = await this.redis.multi().incr(counterKey).pttl(counterKey).exec();
    const totalHits = Number(results?.[0]?.[1] ?? 0);
    let timeToExpire = Number(results?.[1]?.[1] ?? -1);

    // First hit in the window: attach the TTL now, so the key cannot leak.
    if (timeToExpire < 0) {
      await this.redis.pexpire(counterKey, ttl);
      timeToExpire = ttl;
    }

    const isBlocked = totalHits > limit;
    if (isBlocked && blockDuration > 0) {
      await this.redis.set(blockKey, '1', 'PX', blockDuration);
    }

    return {
      totalHits,
      timeToExpire: Math.ceil(timeToExpire / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
