import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/bootstrap';

/**
 * Smoke test for the infrastructure wiring: the module graph resolves, the
 * server boots, and the probes answer. It needs Postgres and Redis running
 * (`pnpm infra:up`), which is exactly the point — a green run proves the whole
 * local stack is healthy.
 */
describe('health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    // `bodyParser: false` for the same reason main.ts sets it — configureApp
    // registers the JSON parser, and Nest's would claim the content type first.
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      bodyParser: false,
    });
    // Same configuration as production, so route prefixes, versioning and
    // security headers are actually the ones being tested.
    await configureApp(app, loadConfig());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports liveness without touching dependencies', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports readiness for database and redis', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = response.json<{ status: string; info?: Record<string, unknown> }>();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.info).toHaveProperty('database');
    expect(body.info).toHaveProperty('redis');
  });

  it('serves the API under the versioned prefix', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/docs/openapi.json' });
    const spec = response.json<{ paths: Record<string, unknown> }>();

    expect(response.statusCode).toBe(200);
    expect(Object.keys(spec.paths)).toContain('/health/live');
  });

  it('applies security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeTruthy();
  });

  it('returns a stable error envelope for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    const body = response.json<{ error: { code: string }; meta: { requestId: string } }>();

    expect(response.statusCode).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.meta.requestId).toBeTruthy();
  });
});
