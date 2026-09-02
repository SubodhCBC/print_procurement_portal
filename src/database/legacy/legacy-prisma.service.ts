import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient as LegacyPrismaClient } from '@prisma/legacy-client';
import { buildLegacyPrismaClientOptions } from './legacy-prisma-client.factory';
import { applyReadOnly, type ReadOnlyLegacyClient } from './read-only.extension';

/**
 * Connection to the legacy Ticket-IT database.
 *
 * Deliberately *not* a subclass of PrismaClient, unlike PrismaService. The
 * read-only extension produces a new client rather than mutating the original,
 * so a subclass would expose both the guarded client and the unguarded `this`.
 * Composition keeps `db` the only reachable surface, and it is guarded.
 */
@Injectable()
export class LegacyPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LegacyPrismaService.name);
  private readonly base: LegacyPrismaClient;

  /** The read-only client. Every mutating call on it throws. */
  readonly db: ReadOnlyLegacyClient;

  private connected = false;

  constructor() {
    this.base = new LegacyPrismaClient(buildLegacyPrismaClientOptions());
    this.db = applyReadOnly(this.base);
  }

  /**
   * Connects, but does not fail the boot if the legacy database is unreachable.
   *
   * This is the opposite of PrismaService's eager, fail-fast connect, and the
   * asymmetry is intentional. Without the portal database nothing works. Without
   * the legacy database, every user who has already logged in once still
   * authenticates normally — only first-time logins degrade. Refusing to start
   * would turn a partial outage in a system we do not own into a total one.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.base.$connect();
      this.connected = true;
      this.logger.log('Legacy database connection established (read-only)');
    } catch (error) {
      this.logger.error(
        'Legacy database unreachable at boot — first-time logins will fail until it recovers. ' +
          'Already-provisioned users are unaffected.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
    this.connected = false;
  }

  /** Whether the last connection attempt succeeded. Advisory only. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Liveness probe for the health module.
   *
   * Uses the unguarded base client because the read-only extension blocks raw
   * queries wholesale — see read-only.extension.ts for why. This is the only
   * sanctioned bypass, and it runs a constant with no user input.
   */
  async ping(): Promise<void> {
    await this.base.$queryRaw`SELECT 1`;
    this.connected = true;
  }
}
