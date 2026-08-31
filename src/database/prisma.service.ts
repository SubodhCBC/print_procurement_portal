import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { buildPrismaClientOptions } from './prisma-client.factory';
import { PrismaClient } from '@prisma/client';

/**
 * Nest lifecycle wrapper around PrismaClient.
 *
 * Connects eagerly at boot so a bad DATABASE_URL fails the deploy immediately
 * rather than on the first user request, and disconnects on shutdown so
 * in-flight queries can drain before the process exits.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super(buildPrismaClientOptions());
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /** Cheap liveness probe used by the health module. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
