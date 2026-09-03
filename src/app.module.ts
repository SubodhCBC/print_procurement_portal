import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule, loadConfig } from '@/config';
import { DatabaseModule } from '@/database';
import { AppLoggerModule } from '@/shared/logger';
import { MailerModule } from '@/shared/mailer';
import { CacheModule } from '@/shared/cache';
import { ALL_QUEUE_NAMES, QueueModule } from '@/shared/queue';
import { StorageModule } from '@/shared/storage';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RedisThrottlerStorage } from './common/guards/redis-throttler.storage';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth';
import { AuthorizationModule } from './modules/authorization';
import { AccountsModule } from './modules/accounts';
import { AuditModule } from './modules/audit';
import { CatalogModule } from './modules/catalog';
import { PricingModule } from './modules/pricing';
import { CartModule } from './modules/cart';
import { OrdersModule } from './modules/orders';
import { ApprovalsModule } from './modules/approvals';
import { BillingModule } from './modules/billing';
import { ReportsModule } from './modules/reports';
import { SitesModule } from './modules/sites';
import { UsersModule } from './modules/users';

const config = loadConfig();

/**
 * Infrastructure composition root.
 *
 * Only cross-cutting concerns live here — config, logging, persistence, queues,
 * object storage, mail, rate limiting, error handling and health. Domain
 * modules (catalog, pricing, orders, approvals, templates, billing) are added
 * below HealthModule as they are built, and must not need any change to this
 * file beyond their own import line.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule.forRoot({ httpLogging: true }),
    DatabaseModule,
    CacheModule,
    QueueModule.forRoot(ALL_QUEUE_NAMES),
    // After QueueModule: MailerModule's dispatcher injects the `email` queue
    // that QueueModule registers, and its processor consumes it.
    MailerModule,
    StorageModule,

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

    // Domain modules. AuthModule registers the global JwtAuthGuard and, right
    // behind it, the AuthorizationGuard — so every route added below is
    // authenticated unless it declares @Public(), and is checked against
    // whatever @Roles()/@RequirePermissions() it declares.
    AuthorizationModule,
    AuthModule,
    // Global, and before every module that records to it.
    AuditModule,
    AccountsModule,
    SitesModule,
    UsersModule,
    CatalogModule,
    // After CatalogModule: pricing reads products through it, and the
    // dependency deliberately runs one way.
    PricingModule,
    // After PricingModule: a basket is priced through it on every read.
    CartModule,
    // After CartModule: an order is written from a validated basket.
    // Before OrdersModule: placing an order raises an approval through it.
    ApprovalsModule,
    OrdersModule,
    // After OrdersModule: an invoice is a month of its orders.
    BillingModule,
    // Last: reports read what every module above writes, and own nothing.
    ReportsModule,
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
