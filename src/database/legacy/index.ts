export { LegacyPrismaService } from './legacy-prisma.service';
export {
  buildLegacyDatabaseUrl,
  buildLegacyPrismaClientOptions,
  createLegacyPrismaClient,
} from './legacy-prisma-client.factory';
export type { LegacyPrismaClientOptionsInput } from './legacy-prisma-client.factory';
export { applyReadOnly, LegacyDatabaseReadOnlyError, LegacyPrisma } from './read-only.extension';
export type { ReadOnlyLegacyClient } from './read-only.extension';
