import { Global, Module } from '@nestjs/common';
import { LegacyPrismaService } from './legacy';
import { PrismaService } from './prisma.service';

/**
 * Global so feature modules can inject PrismaService without re-importing it
 * in every module — there is exactly one client per process by design.
 *
 * Swapping the ORM later means changing this module and PrismaService; nothing
 * in src/modules imports Prisma directly.
 *
 * Two connections live here, and they are not peers:
 *
 *   PrismaService        the portal's own PostgreSQL database. Read/write,
 *                        migrated by this repo, fails the boot if unreachable.
 *   LegacyPrismaService  the legacy Ticket-IT SQL Server database. Read-only,
 *                        owned by another system, tolerated as unreachable.
 *
 * Only src/modules/auth may inject the legacy service. Anything else needing
 * legacy data should read the replica in the portal database instead.
 */
@Global()
@Module({
  providers: [PrismaService, LegacyPrismaService],
  exports: [PrismaService, LegacyPrismaService],
})
export class DatabaseModule {}
