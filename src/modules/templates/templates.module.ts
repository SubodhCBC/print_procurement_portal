import { Module } from '@nestjs/common';
import { CatalogModule } from '@/modules/catalog';
import { DamModule } from '@/shared/dam';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Master artwork templates (SOW FE-13).
 *
 * Global data, like the catalogue it prints onto: no tenant scope and no RLS,
 * because the library belongs to the platform operator. What an account may see
 * is decided by TemplatesService.visibilityFilter(), and the one tenant-shaped
 * table — template_account_visibility — is a join whose whole content is an
 * account id.
 *
 * Imports CatalogModule for AssetDerivativeService: template tiles need the
 * same two resized copies product images do, and they ride the same render
 * queue. A second derivative service would mean a second worker on that queue,
 * and BullMQ hands each job to exactly one worker — the product worker would
 * consume template jobs and mark them complete, so no template thumbnail would
 * ever appear.
 *
 * Imports DamModule so the builder can offer artwork from the document library
 * once it is configured. Nothing here fails when it is not: DamIntegrationService
 * answers 503 with a message naming the missing variable.
 */
@Module({
  imports: [CatalogModule, DamModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
