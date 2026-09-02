import { Module } from '@nestjs/common';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

/**
 * Branches and their addresses — the level orders are placed for and billed to.
 *
 * PrismaService comes from the global DatabaseModule; the guards that protect
 * these routes are registered globally by AuthModule. SitesService is exported
 * because user provisioning attaches a replicated legacy user to their branch
 * through it.
 */
@Module({
  controllers: [SitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
