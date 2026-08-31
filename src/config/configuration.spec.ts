import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseConfig } from './configuration';

const validEnv: NodeJS.ProcessEnv = {
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'assets',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_PUBLIC_BASE_URL: 'http://localhost:9000/assets',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  WEBHOOK_HMAC_SECRET: 'c'.repeat(48),
  MAIL_FROM_ADDRESS: 'no-reply@ticketit.local',
};

describe('parseConfig', () => {
  it('builds a nested config from a valid environment', () => {
    const config = parseConfig(validEnv);

    expect(config.app.env).toBe('development');
    expect(config.app.port).toBe(3000);
    expect(config.database.poolSize).toBe(10);
    expect(config.app.isProduction).toBe(false);
  });

  it('reports every missing variable at once instead of the first one', () => {
    try {
      parseConfig({});
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const { issues } = error as ConfigValidationError;
      expect(issues.length).toBeGreaterThan(3);
      expect(issues.some((issue) => issue.startsWith('DATABASE_URL'))).toBe(true);
    }
  });

  it('coerces booleanish and csv values', () => {
    const config = parseConfig({
      ...validEnv,
      S3_FORCE_PATH_STYLE: 'yes',
      CORS_ORIGINS: 'http://a.test, http://b.test ,',
    });

    expect(config.storage.forcePathStyle).toBe(true);
    expect(config.security.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('rejects the demo role switcher in production', () => {
    const run = () =>
      parseConfig({
        ...validEnv,
        APP_ENV: 'production',
        CORS_ORIGINS: 'https://portal.example.com',
        FEATURE_ROLE_SWITCHER: 'true',
      });

    expect(run).toThrowError(/FEATURE_ROLE_SWITCHER/);
  });

  it('rejects placeholder secrets in production', () => {
    const run = () =>
      parseConfig({
        ...validEnv,
        APP_ENV: 'production',
        CORS_ORIGINS: 'https://portal.example.com',
        JWT_ACCESS_SECRET: 'change-me-local-access-secret-min-32-characters-long',
      });

    expect(run).toThrowError(/JWT_ACCESS_SECRET/);
  });

  it('rejects a wildcard CORS allowlist in production', () => {
    const run = () => parseConfig({ ...validEnv, APP_ENV: 'production', CORS_ORIGINS: '*' });

    expect(run).toThrowError(/CORS_ORIGINS/);
  });

  it('rejects a malformed token TTL', () => {
    const run = () => parseConfig({ ...validEnv, JWT_ACCESS_TTL: '15 minutes' });
    expect(run).toThrowError(/JWT_ACCESS_TTL/);
  });
});
