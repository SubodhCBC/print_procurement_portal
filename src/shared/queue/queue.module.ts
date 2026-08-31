import { BullModule } from '@nestjs/bullmq';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { loadConfig } from '@/config';
import { buildRedisOptions } from '../cache';
import { STANDARD_RETRY } from './job-options';
import { ALL_QUEUE_NAMES, type QueueName } from './queue-names';

/**
 * Registers BullMQ with the shared Redis settings and exposes the requested
 * queues as injectable producers.
 *
 * The API registers only the queues it enqueues to; the worker app registers
 * the ones it consumes. Keeping that explicit means a queue can be moved to a
 * dedicated worker deployment without touching producer code.
 */
@Global()
@Module({})
export class QueueModule {
  static forRoot(queues: readonly QueueName[] = ALL_QUEUE_NAMES): DynamicModule {
    const config = loadConfig();

    const root = BullModule.forRoot({
      connection: { ...buildRedisOptions(), url: config.redis.url },
      prefix: config.redis.queuePrefix,
      defaultJobOptions: STANDARD_RETRY,
    });

    const registered = BullModule.registerQueue(
      ...queues.map((name) => ({ name, prefix: config.redis.queuePrefix })),
    );

    return {
      module: QueueModule,
      imports: [root, registered],
      exports: [root, registered],
    };
  }
}
