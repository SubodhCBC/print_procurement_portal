import { loadConfig } from '@/config';
import { PrismaClient as LegacyPrismaClient, type Prisma } from '@prisma/legacy-client';

export interface LegacyPrismaClientOptionsInput {
  /** Overrides the configured LEGACY_DATABASE_URL — used by integration tests. */
  readonly url?: string;
  readonly logQueries?: boolean;
}

/**
 * SQL Server connection strings are semicolon-delimited key/value pairs, not
 * URLs, so the app database's `new URL()` + searchParams approach in
 * prisma-client.factory.ts cannot be reused here.
 *
 * Parameters already present in the configured string win — an operator who
 * pins `connectionLimit` in the secret manager means it.
 */
export function buildLegacyDatabaseUrl(override?: string): string {
  const config = loadConfig();
  const base = (override ?? config.legacyDatabase.url).replace(/;+$/, '');

  const existing = new Set(
    base
      .split(';')
      .slice(1) // the first segment is `sqlserver://host:port`
      .map((pair) => pair.split('=')[0]?.trim().toLowerCase())
      .filter((key): key is string => Boolean(key)),
  );

  const defaults: Array<[string, string]> = [
    // Deliberately smaller than the app pool. This connection is used on the
    // first login of each user and nowhere else; a large pool against someone
    // else's production database is not ours to take.
    ['connectionLimit', String(config.legacyDatabase.poolSize)],
    ['poolTimeout', '10'],
    // A slow legacy database must not hold an HTTP request open indefinitely —
    // the login falls back to a 503 instead.
    ['socketTimeout', '15'],
  ];

  const additions = defaults
    .filter(([key]) => !existing.has(key.toLowerCase()))
    .map(([key, value]) => `${key}=${value}`);

  return additions.length > 0 ? `${base};${additions.join(';')}` : base;
}

export function buildLegacyPrismaClientOptions(
  input: LegacyPrismaClientOptionsInput = {},
): Prisma.PrismaClientOptions {
  const config = loadConfig();
  const logQueries = input.logQueries ?? config.database.logQueries;

  const log: Prisma.LogDefinition[] = [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ];
  if (logQueries) log.unshift({ emit: 'event', level: 'query' });

  return {
    datasources: { db: { url: buildLegacyDatabaseUrl(input.url) } },
    log,
  };
}

/** For scripts and tests that live outside Nest's DI container. */
export function createLegacyPrismaClient(
  input: LegacyPrismaClientOptionsInput = {},
): LegacyPrismaClient {
  return new LegacyPrismaClient(buildLegacyPrismaClientOptions(input));
}
