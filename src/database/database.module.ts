import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so feature modules can inject PrismaService without re-importing it
 * in every module — there is exactly one client per process by design.
 *
 * Swapping the ORM later means changing this module and PrismaService; nothing
 * in src/modules imports Prisma directly.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
