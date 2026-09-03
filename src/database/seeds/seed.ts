/**
 * Seed entrypoint.
 *
 * Seeds are split per domain and composed here, so that `npm run db:seed`
 * always produces a complete, demo-ready environment.
 *
 * Uses the shared client factory rather than `new PrismaClient()` so it reads
 * the same validated configuration — and the same .env — as the running apps.
 */
import { createPrismaClient } from '../prisma-client.factory';
import { seedDevCatalog } from './dev-catalog.seed';
import { seedDevPricing } from './dev-pricing.seed';
import { seedDevUsers } from './dev-users.seed';

const prisma = createPrismaClient();

async function main(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  await seedDevUsers(prisma);
  // After the users: nothing in the catalogue is tenant-scoped, but the log
  // reads in the order someone would set the system up.
  await seedDevCatalog(prisma);
  // Last: a rate card prices products, so both have to exist first.
  await seedDevPricing(prisma);
  console.log('[seed] done');
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
