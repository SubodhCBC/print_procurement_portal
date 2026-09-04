import { Module } from '@nestjs/common';
import { AuditModule } from '@/modules/audit';
import { DamIntegrationService } from './dam.service';

/**
 * The DAM boundary (ARCH section 8).
 *
 * Global-ish by intent but registered explicitly where it is needed, like the
 * storage and mailer modules: a feature module that can reach the DAM should
 * say so in its imports, because "who can read the document library" is a
 * question worth being able to answer by reading the module graph.
 *
 * Imports AuditModule because every DAM access is logged — see the note on
 * DamIntegrationService for why reads are logged and not only writes.
 */
@Module({
  imports: [AuditModule],
  providers: [DamIntegrationService],
  exports: [DamIntegrationService],
})
export class DamModule {}
