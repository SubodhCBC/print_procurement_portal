import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';
import { LegacyPrismaHealthIndicator } from './indicators/legacy-prisma.health';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';

/**
 * Three distinct probes, because orchestrators need different answers:
 *
 *  - /health/live   process is running. Failing it means "restart me".
 *  - /health/ready  dependencies reachable. Failing it means "stop sending
 *                   traffic" — but do NOT restart, the database may just be
 *                   failing over.
 *  - /health        human-readable summary including the deployed revision.
 *
 * Conflating the two probes is how a brief database blip turns into a rolling
 * restart of every replica.
 */
@ApiTags('health')
// VERSION_NEUTRAL: probes must live at a fixed, unversioned path. An
// orchestrator health check should not have to be updated when the API moves
// from v1 to v2.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
// Probes must answer without a bearer token — an orchestrator has no
// credentials, and a 401 here reads as "unhealthy" and triggers a restart loop.
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly legacy: LegacyPrismaHealthIndicator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — process is running' })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — downstream dependencies reachable' })
  @HealthCheck()
  ready() {
    // The legacy database is deliberately absent: it is not required to serve
    // traffic. See LegacyPrismaHealthIndicator, and /health/dependencies below
    // for its status.
    return this.health.check([
      () => this.prisma.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }

  @Get('dependencies')
  @ApiOperation({
    summary: 'Every dependency including non-critical ones',
    description:
      'Includes the legacy database, whose outage degrades first-time logins but does ' +
      'not make the service unready.',
  })
  @HealthCheck()
  dependencies() {
    return this.health.check([
      () => this.prisma.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
      () => this.legacy.isHealthy('legacy-database'),
    ]);
  }

  @Get()
  @ApiOperation({ summary: 'Service summary' })
  summary() {
    return {
      name: this.config.app.name,
      environment: this.config.app.env,
      release: this.config.app.release,
      apiVersion: this.config.app.apiVersion,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
