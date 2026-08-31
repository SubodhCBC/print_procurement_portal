import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { PrismaService } from '@/database';

@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  async isHealthy(key = 'database'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const startedAt = Date.now();

    try {
      await this.prisma.ping();
      return indicator.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
}
