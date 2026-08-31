import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { VersioningType } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '@/config';
import { setupSwagger } from './common/utils/swagger.setup';

/**
 * Everything that turns a bare Nest application into *this* API.
 *
 * Shared by `main.ts` and the e2e suite on purpose: when the tests build the
 * app differently from production, they validate a wiring that is never
 * deployed — route prefixes, versioning and security headers all silently
 * diverge.
 */
export async function configureApp(
  app: NestFastifyApplication,
  config: AppConfig,
): Promise<{ docsPath?: string }> {
  await app.register(helmet, {
    contentSecurityPolicy: false, // API responses are JSON; CSP belongs to the SPA
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(compress, { encodings: ['gzip', 'deflate'] });

  app.enableCors({
    origin: config.security.corsOrigins.length > 0 ? [...config.security.corsOrigins] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });

  app.setGlobalPrefix(config.app.globalPrefix, {
    // Probes stay at /health — see VERSION_NEUTRAL on HealthController.
    exclude: ['health', 'health/live', 'health/ready'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.app.apiVersion });

  // Lets Nest run onModuleDestroy/onApplicationShutdown on SIGTERM so in-flight
  // requests finish and database connections close cleanly.
  app.enableShutdownHooks();

  const docsPath = setupSwagger(app, config);
  return docsPath ? { docsPath } : {};
}
