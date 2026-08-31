/**
 * Seed entrypoint.
 *
 * Deliberately empty while the schema has no models. Seeds will be split per
 * domain (accounts, catalog, rate cards, templates) and composed here, so that
 * `pnpm db:seed` always produces a complete, demo-ready environment.
 *
 * Uses the shared client factory rather than `new PrismaClient()` so it reads
 * the same validated configuration — and the same .env — as the running apps.
 */
import { createPrismaClient } from '../prisma-client.factory';

const prisma = createPrismaClient();

async function main(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  console.log('[seed] database reachable — no seed data defined yet');
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
