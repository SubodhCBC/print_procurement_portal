import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigValidationError, loadConfig } from '@/config';
import { createRequestId } from '@/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { initSentry } from '@/shared/logger';

/** 8 MB — artwork uploads go straight to object storage via presigned URLs. */
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  initSentry(config);

  const adapter = new FastifyAdapter({
    // Behind a load balancer the client IP lives in X-Forwarded-For; rate
    // limiting and audit logs are wrong without this.
    trustProxy: config.security.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    // One id per request, reused as the log correlation id and returned to the
    // client in the error envelope. nestjs-pino owns request logging.
    genReqId: () => createRequestId(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true, // hold startup logs until pino is wired up
  });

  app.useLogger(app.get(Logger));
  app.flushLogs();

  const { docsPath } = await configureApp(app, config);

  await app.listen({ port: config.app.port, host: config.app.host });

  const base = `http://${config.app.host}:${config.app.port}`;
  app.get(Logger).log(
    {
      env: config.app.env,
      release: config.app.release,
      api: `${base}/${config.app.globalPrefix}/v${config.app.apiVersion}`,
      health: `${base}/health/ready`,
      docs: docsPath ? `${base}/${docsPath}` : 'disabled',
    },
    `${config.app.name} API is listening`,
  );
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    // Config problems are operator errors: print them plainly, no stack trace.
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  console.error('Failed to start the API', error);
  process.exit(1);
});
