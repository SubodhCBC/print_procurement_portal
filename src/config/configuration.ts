import { loadDotEnv } from './dotenv';
import { envSchema, type AppEnv, type RawEnv } from './validation.schema';

export interface AppConfig {
  readonly app: {
    readonly name: string;
    readonly env: AppEnv;
    readonly nodeEnv: RawEnv['NODE_ENV'];
    readonly isProduction: boolean;
    readonly isDevelopment: boolean;
    readonly host: string;
    readonly port: number;
    readonly globalPrefix: string;
    readonly apiVersion: string;
    readonly shutdownTimeoutMs: number;
    readonly release: string;
  };
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
    readonly statementTimeoutMs: number;
    readonly logQueries: boolean;
  };
  readonly redis: {
    readonly url: string;
    readonly keyPrefix: string;
    readonly queuePrefix: string;
  };
  readonly storage: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
    readonly publicBaseUrl: string;
    readonly presignExpirySeconds: number;
  };
  readonly auth: {
    readonly accessSecret: string;
    readonly accessTtl: string;
    readonly refreshSecret: string;
    readonly refreshTtl: string;
    readonly passwordHash: {
      readonly memoryCost: number;
      readonly timeCost: number;
    };
  };
  readonly security: {
    readonly corsOrigins: readonly string[];
    readonly trustProxy: boolean;
    readonly rateLimit: {
      readonly ttlSeconds: number;
      readonly max: number;
      readonly authMax: number;
    };
    readonly webhook: {
      readonly hmacSecret: string;
      readonly timestampToleranceSeconds: number;
    };
  };
  readonly mail: {
    readonly transport: RawEnv['MAIL_TRANSPORT'];
    readonly host: string;
    readonly port: number;
    readonly user?: string;
    readonly password?: string;
    readonly secure: boolean;
    readonly fromAddress: string;
    readonly fromName: string;
  };
  readonly workers: {
    readonly concurrency: number;
    readonly render: {
      readonly concurrency: number;
      readonly jobTimeoutMs: number;
      readonly browserPoolSize: number;
    };
  };
  readonly observability: {
    readonly logLevel: RawEnv['LOG_LEVEL'];
    readonly logPretty: boolean;
    readonly sentryDsn?: string;
    readonly sentryTracesSampleRate: number;
    readonly otelEnabled: boolean;
    readonly otelEndpoint?: string;
  };
  readonly features: {
    readonly swagger: boolean;
    readonly roleSwitcher: boolean;
    readonly mockIntegrations: boolean;
  };
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      [
        'Invalid environment configuration — the process will not start.',
        ...issues.map((issue) => `  • ${issue}`),
        '',
        'Compare your .env against .env.example.',
      ].join('\n'),
    );
    this.name = 'ConfigValidationError';
  }
}

function toAppConfig(env: RawEnv): AppConfig {
  return {
    app: {
      name: env.APP_NAME,
      env: env.APP_ENV,
      nodeEnv: env.NODE_ENV,
      isProduction: env.APP_ENV === 'production',
      isDevelopment: env.APP_ENV === 'development',
      host: env.API_HOST,
      port: env.API_PORT,
      globalPrefix: env.API_PREFIX,
      apiVersion: env.API_VERSION,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      release: env.GIT_SHA,
    },
    database: {
      url: env.DATABASE_URL,
      poolSize: env.DATABASE_POOL_SIZE,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      logQueries: env.DATABASE_LOG_QUERIES,
    },
    redis: {
      url: env.REDIS_URL,
      keyPrefix: env.REDIS_KEY_PREFIX,
      queuePrefix: env.QUEUE_PREFIX,
    },
    storage: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      publicBaseUrl: env.S3_PUBLIC_BASE_URL,
      presignExpirySeconds: env.S3_PRESIGN_EXPIRY_SECONDS,
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshSecret: env.JWT_REFRESH_SECRET,
      refreshTtl: env.JWT_REFRESH_TTL,
      passwordHash: {
        memoryCost: env.PASSWORD_HASH_MEMORY_COST,
        timeCost: env.PASSWORD_HASH_TIME_COST,
      },
    },
    security: {
      corsOrigins: env.CORS_ORIGINS,
      trustProxy: env.TRUST_PROXY,
      rateLimit: {
        ttlSeconds: env.RATE_LIMIT_TTL_SECONDS,
        max: env.RATE_LIMIT_MAX,
        authMax: env.RATE_LIMIT_AUTH_MAX,
      },
      webhook: {
        hmacSecret: env.WEBHOOK_HMAC_SECRET,
        timestampToleranceSeconds: env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
      },
    },
    mail: {
      transport: env.MAIL_TRANSPORT,
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      secure: env.SMTP_SECURE,
      fromAddress: env.MAIL_FROM_ADDRESS,
      fromName: env.MAIL_FROM_NAME,
    },
    workers: {
      concurrency: env.WORKER_CONCURRENCY,
      render: {
        concurrency: env.RENDER_CONCURRENCY,
        jobTimeoutMs: env.RENDER_JOB_TIMEOUT_MS,
        browserPoolSize: env.RENDER_BROWSER_POOL_SIZE,
      },
    },
    observability: {
      logLevel: env.LOG_LEVEL,
      logPretty: env.LOG_PRETTY,
      sentryDsn: env.SENTRY_DSN,
      sentryTracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      otelEnabled: env.OTEL_ENABLED,
      otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    features: {
      swagger: env.SWAGGER_ENABLED,
      roleSwitcher: env.FEATURE_ROLE_SWITCHER,
      mockIntegrations: env.FEATURE_MOCK_INTEGRATIONS,
    },
  };
}

/**
 * Parses and validates the environment. Every consumer — API, workers, scripts,
 * tests — goes through here, so a misconfigured deploy dies at boot with a list
 * of every problem at once instead of a null-pointer three hours later.
 */
export function parseConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }

  return toAppConfig(result.data);
}

let cached: AppConfig | undefined;

/** Cached singleton — the environment cannot change mid-process. */
export function loadConfig(): AppConfig {
  if (!cached) {
    loadDotEnv();
    cached = parseConfig(process.env);
  }
  return cached;
}

/** Test-only escape hatch so a spec can exercise a different environment. */
export function resetConfigCache(): void {
  cached = undefined;
}
