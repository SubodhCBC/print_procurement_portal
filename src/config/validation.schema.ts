import { z } from 'zod';

/** `"true" | "1" | "yes"` and friends — env vars are always strings. */
const booleanish = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
});

/** Comma-separated list -> trimmed, non-empty string array. */
const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

/** `15m`, `30d`, `900s` — validated here so a typo fails at boot, not at first login. */
const duration = z.string().regex(/^\d+(ms|s|m|h|d)$/, 'must look like 15m, 900s or 30d');

export const APP_ENVS = ['development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const SECRET_MIN_LENGTH = 32;
const secret = z
  .string()
  .min(SECRET_MIN_LENGTH, `must be at least ${SECRET_MIN_LENGTH} characters`);

export const envSchema = z
  .object({
    // --- Application ---
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(APP_ENVS).default('development'),
    APP_NAME: z.string().min(1).default('ticketit-portal'),
    API_PORT: port.default(3000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PREFIX: z.string().default('api'),
    API_VERSION: z.string().default('1'),
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(15_000),
    /**
     * Where the Next.js frontend is served from. Every link this service emails
     * — invitation, password reset — is built against it, so it must be the
     * address the *recipient* can reach, not the API's own host.
     */
    PORTAL_BASE_URL: z.string().url().default('http://localhost:3001'),
    /** How long an invitation or password-reset link stays usable. */
    INVITATION_TTL_HOURS: positiveInt.default(168),
    PASSWORD_RESET_TTL_MINUTES: positiveInt.default(60),
    /** Injected by CI at build time; tags logs, Sentry releases and /health. */
    GIT_SHA: z.string().default('unknown'),

    // --- Database (primary, owned by this service) ---
    DATABASE_URL: z.string().url().startsWith('postgres'),
    DATABASE_POOL_SIZE: positiveInt.default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInt.default(15_000),
    DATABASE_LOG_QUERIES: booleanish.default(false),

    // --- Legacy database (read-only source of truth for first login) ---
    // Not `.url()`: a SQL Server connection string is semicolon-delimited
    // (`sqlserver://host:1433;database=x;user=y`) and is not a WHATWG URL, so
    // url() rejects perfectly valid values.
    LEGACY_DATABASE_URL: z
      .string()
      .min(1)
      .startsWith('sqlserver://', 'must be a SQL Server connection string'),
    LEGACY_DATABASE_POOL_SIZE: positiveInt.default(5),
    LEGACY_AUTH_FALLBACK_ENABLED: booleanish.default(true),
    LEGACY_USER_SYNC_TTL_SECONDS: positiveInt.default(86_400),

    // --- Redis / queues ---
    REDIS_URL: z.string().url().startsWith('redis'),
    REDIS_KEY_PREFIX: z.string().default('ticketit'),
    QUEUE_PREFIX: z.string().default('ticketit'),

    // --- Object storage ---
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanish.default(true),
    S3_PUBLIC_BASE_URL: z.string().url(),
    S3_PRESIGN_EXPIRY_SECONDS: positiveInt.default(900),

    // --- Auth ---
    JWT_ACCESS_SECRET: secret,
    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_SECRET: secret,
    JWT_REFRESH_TTL: duration.default('30d'),
    PASSWORD_HASH_MEMORY_COST: positiveInt.default(19_456),
    PASSWORD_HASH_TIME_COST: positiveInt.default(2),

    // --- Security ---
    CORS_ORIGINS: csv,
    RATE_LIMIT_TTL_SECONDS: positiveInt.default(60),
    RATE_LIMIT_MAX: positiveInt.default(120),
    RATE_LIMIT_AUTH_MAX: positiveInt.default(10),
    TRUST_PROXY: booleanish.default(false),
    WEBHOOK_HMAC_SECRET: secret,
    WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: positiveInt.default(300),

    // --- Mail ---
    MAIL_TRANSPORT: z.enum(['smtp', 'sendgrid', 'postmark', 'console']).default('smtp'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: port.default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: booleanish.default(false),
    MAIL_FROM_ADDRESS: z.string().email(),
    MAIL_FROM_NAME: z.string().default('Ticket-IT Portal'),

    // --- Workers ---
    WORKER_CONCURRENCY: positiveInt.default(5),
    RENDER_CONCURRENCY: positiveInt.default(2),
    RENDER_JOB_TIMEOUT_MS: positiveInt.default(120_000),
    RENDER_BROWSER_POOL_SIZE: positiveInt.default(2),

    // --- Observability ---
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_PRETTY: booleanish.default(false),
    SENTRY_DSN: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    OTEL_ENABLED: booleanish.default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // --- Feature flags ---
    SWAGGER_ENABLED: booleanish.default(false),
    FEATURE_ROLE_SWITCHER: booleanish.default(false),
    FEATURE_MOCK_INTEGRATIONS: booleanish.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== 'production') return;

    // Production hardening. These are the switches that turn a demo build into
    // a data breach, so they fail the boot rather than warn in a log nobody reads.
    const forbidden: Array<[keyof typeof env, boolean, string]> = [
      ['FEATURE_ROLE_SWITCHER', env.FEATURE_ROLE_SWITCHER, 'lets any user assume another role'],
      ['SWAGGER_ENABLED', env.SWAGGER_ENABLED, 'exposes the full API surface publicly'],
      ['LOG_PRETTY', env.LOG_PRETTY, 'breaks structured log ingestion'],
      ['DATABASE_LOG_QUERIES', env.DATABASE_LOG_QUERIES, 'leaks tenant data into logs'],
    ];

    for (const [key, isOn, why] of forbidden) {
      if (isOn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `must be false in production — it ${why}`,
        });
      }
    }

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'WEBHOOK_HMAC_SECRET'] as const) {
      if (env[key].startsWith('change-me')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'still holds the placeholder value from .env.example',
        });
      }
    }

    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }

    if (env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'must be an explicit origin allowlist in production',
      });
    }
  });

export type RawEnv = z.infer<typeof envSchema>;
