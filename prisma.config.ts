import { existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type { PrismaConfig } from 'prisma';

/**
 * Prisma 7 drops the `prisma` key in package.json, so the CLI is configured here.
 *
 * Once a config file exists the CLI stops loading `.env` itself, so the
 * environment is loaded explicitly. This file is executed by the Prisma CLI
 * outside Nest's path-alias resolution, hence plain dotenv rather than
 * importing from `@/config`.
 */
const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';

for (const file of [
  path.join(__dirname, '.env.local'),
  path.join(__dirname, '.env'),
  path.join(__dirname, 'src', 'config', 'env', `.env.${appEnv}`),
]) {
  if (existsSync(file)) dotenv.config({ path: file, override: false });
}

export default {
  schema: path.join(__dirname, 'src', 'database', 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'src', 'database', 'migrations'),
    seed: 'tsx src/database/seeds/seed.ts',
  },
} satisfies PrismaConfig;
