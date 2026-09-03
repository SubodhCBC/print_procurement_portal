import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Analytics and reporting (SOW BE-10).
 *
 * Owns no tables and imports no domain module: every figure is computed from
 * orders, their lines and the catalogue, and the one constant it needs from the
 * order lifecycle comes from the pure `order-status.ts`.
 *
 * PrismaService comes from the global DatabaseModule.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
