import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { createRedisConnection } from '@/shared/cache';
import type { Redis } from 'ioredis';

@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly redis: Redis = createRedisConnection({ lazyConnect: true });

  constructor(private readonly health: HealthIndicatorService) {}

  async isHealthy(key = 'redis'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const startedAt = Date.now();

    try {
      if (this.redis.status !== 'ready') await this.redis.connect();
      await this.redis.ping();
      return indicator.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
