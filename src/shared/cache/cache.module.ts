import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * The read-through cache (SOW BE-13).
 *
 * Global, like the database and mailer modules, so a feature module that wants
 * it does not need to declare an import — but note that almost none should.
 * Only aggregates a user reads and never writes belong in a cache; anything
 * transactional read from one is a correctness bug waiting for two people to
 * act on the same row.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
