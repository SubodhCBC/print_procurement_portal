import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule, loadConfig } from '@/config';
import { DatabaseModule } from '@/database';
import { AppLoggerModule } from '@/shared/logger';
import { ALL_QUEUE_NAMES, QueueModule } from '@/shared/queue';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RedisThrottlerStorage } from './common/guards/redis-throttler.storage';
import { HealthModule } from './health/health.module';

const config = loadConfig();

/**
 * Infrastructure composition root.
 *
 * Only cross-cutting concerns live here — config, logging, persistence, queues,
 * rate limiting, error handling and health. Domain modules (auth, catalog,
 * pricing, orders, approvals, templates, billing) are added below HealthModule
 * as they are built, and must not need any change to this file beyond their
 * own import line.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule.forRoot({ httpLogging: true }),
    DatabaseModule,
    QueueModule.forRoot(ALL_QUEUE_NAMES),

    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: config.security.rateLimit.ttlSeconds * 1000,
          limit: config.security.rateLimit.max,
        },
      ],
      storage: new RedisThrottlerStorage(),
    }),

    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must be first: everything downstream reads the request context.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
