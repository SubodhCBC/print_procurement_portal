import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { LegacyPrismaService } from '@/database';

/**
 * Liveness of the legacy database.
 *
 * Reported on /health but deliberately kept out of /health/ready: legacy being
 * unreachable degrades first-time logins only, and every already-provisioned
 * user authenticates normally. Failing readiness would pull a working portal
 * out of the load balancer over an outage in a system we do not own.
 */
@Injectable()
export class LegacyPrismaHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly legacy: LegacyPrismaService,
  ) {}

  async isHealthy(key = 'legacy-database'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const startedAt = Date.now();

    try {
      await this.legacy.ping();
      return indicator.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - startedAt,
        impact: 'first-time logins only; existing users are unaffected',
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
}
