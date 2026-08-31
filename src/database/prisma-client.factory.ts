import { loadConfig } from '@/config';
import { PrismaClient, type Prisma } from '@prisma/client';

export type PrismaQueryEvent = Prisma.QueryEvent;
export type PrismaLogEvent = Prisma.LogEvent;

export interface PrismaClientOptionsInput {
  /** Overrides the configured DATABASE_URL — used by integration tests. */
  readonly url?: string;
  readonly logQueries?: boolean;
}

/**
 * Builds the connection string with pool and timeout settings applied.
 * Prisma reads all of these from the URL, so this is the only place that
 * decides how the process talks to PostgreSQL.
 */
export function buildDatabaseUrl(override?: string): string {
  const config = loadConfig();
  const url = new URL(override ?? config.database.url);

  url.searchParams.set('connection_limit', String(config.database.poolSize));
  url.searchParams.set('pool_timeout', '10');
  url.searchParams.set('statement_timeout', String(config.database.statementTimeoutMs));

  return url.toString();
}

/**
 * Single source of truth for PrismaClient construction options, shared by the
 * standalone factory (scripts, workers, tests) and the Nest PrismaService.
 */
export function buildPrismaClientOptions(
  input: PrismaClientOptionsInput = {},
): Prisma.PrismaClientOptions {
  const config = loadConfig();
  const logQueries = input.logQueries ?? config.database.logQueries;

  const log: Prisma.LogDefinition[] = [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ];
  if (logQueries) log.unshift({ emit: 'event', level: 'query' });

  return {
    datasources: { db: { url: buildDatabaseUrl(input.url) } },
    log,
  };
}

/** For scripts, workers and tests that live outside the Nest DI container. */
export function createPrismaClient(input: PrismaClientOptionsInput = {}): PrismaClient {
  return new PrismaClient(buildPrismaClientOptions(input));
}
