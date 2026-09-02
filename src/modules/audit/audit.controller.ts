import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ForbiddenError,
  Permission,
  RequirePermissions,
  Role,
  type AuthenticatedActor,
  type OffsetPage,
} from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth';
import { AuditService } from './audit.service';
import { ListAuditLogQuerySchema, type ListAuditLogQueryDto } from './dto/audit.dto';
import { toAuditLogEntryView, type AuditLogEntryView } from './dto/audit-response';

@ApiTags('audit')
@ApiBearerAuth('access-token')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Read-only by design. There is no POST, PATCH or DELETE on this controller
   * and there should never be one — an audit trail an operator can write to or
   * edit is not evidence of anything.
   */
  @Get()
  @RequirePermissions(Permission.AUDIT_VIEW)
  @ApiOperation({
    summary: 'Search the audit trail',
    description:
      'Newest first. Filter by actor, entity, action or date range. Offset-paginated so the ' +
      'admin table can show a total and jump between pages.',
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListAuditLogQuerySchema)) query: ListAuditLogQueryDto,
  ): Promise<OffsetPage<AuditLogEntryView>> {
    const page = await this.audit.list(resolveAccountId(actor, query.accountId), query);
    return { ...page, items: page.items.map(toAuditLogEntryView) };
  }
}

/** See the identical helper in SitesController for why this refuses rather than rewrites. */
function resolveAccountId(actor: AuthenticatedActor, requested?: string): string {
  if (!requested || requested === actor.accountId) return actor.accountId;

  if (actor.role !== Role.ADMIN) {
    throw new ForbiddenError('You may only act on your own account', {
      details: { requestedAccountId: requested },
    });
  }
  return requested;
}
