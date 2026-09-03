import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { BadRequestException, VersioningType } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '@/config';
import { setupSwagger } from './common/utils/swagger.setup';

/** 8 MB — artwork uploads go straight to object storage via presigned URLs. */
export const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

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
  // Nest's own JSON body parser is off (`bodyParser: false` where the app is
  // created), because Fastify's built-in one rejects an empty body outright
  // (FST_ERR_CTP_EMPTY_JSON_BODY). That turns every bodyless DELETE into a 400
  // the moment a client sets `Content-Type: application/json` by default —
  // axios does, and so does anything built on it. An absent body is not a
  // malformed one, so it parses to `undefined` and the route's own schema
  // decides whether that is acceptable.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser<string>(
      'application/json',
      { parseAs: 'string', bodyLimit: BODY_LIMIT_BYTES },
      (_request, body, done) => {
        if (body === undefined || body.trim() === '') {
          done(null, undefined);
          return;
        }

        try {
          done(null, JSON.parse(body));
        } catch {
          // Deliberately not Fastify's parser error: a client that sent broken
          // JSON gets this API's own envelope, like every other bad request.
          done(new BadRequestException('Request body is not valid JSON'), undefined);
        }
      },
    );

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
    exclude: ['health', 'health/live', 'health/ready', 'health/dependencies'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.app.apiVersion });

  // Lets Nest run onModuleDestroy/onApplicationShutdown on SIGTERM so in-flight
  // requests finish and database connections close cleanly.
  app.enableShutdownHooks();

  const docsPath = setupSwagger(app, config);
  return docsPath ? { docsPath } : {};
}
