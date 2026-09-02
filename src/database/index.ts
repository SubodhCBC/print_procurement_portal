export { DatabaseModule } from './database.module';
export { PrismaService } from './prisma.service';
export {
  buildDatabaseUrl,
  buildPrismaClientOptions,
  createPrismaClient,
} from './prisma-client.factory';
export type {
  PrismaClientOptionsInput,
  PrismaLogEvent,
  PrismaQueryEvent,
} from './prisma-client.factory';
export {
  TENANT_APP_ROLE,
  TENANT_SESSION_VAR,
  withCurrentTenantScope,
  withTenantScope,
} from './tenant-scope';
export type { TransactionClient } from './tenant-scope';
export {
  applyReadOnly,
  buildLegacyDatabaseUrl,
  buildLegacyPrismaClientOptions,
  createLegacyPrismaClient,
  LegacyDatabaseReadOnlyError,
  LegacyPrisma,
  LegacyPrismaService,
} from './legacy';
export type { LegacyPrismaClientOptionsInput, ReadOnlyLegacyClient } from './legacy';
