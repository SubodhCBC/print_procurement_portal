import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ForbiddenError,
  Permission,
  RequirePermissions,
  Role,
  type AuthenticatedActor,
  type CursorPage,
} from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import {
  AddSiteAddressSchema,
  CreateSiteSchema,
  ListSitesQuerySchema,
  UpdateSiteSchema,
  type AddSiteAddressDto,
  type CreateSiteDto,
  type ListSitesQueryDto,
  type UpdateSiteDto,
} from './dto/site.dto';
import { toSiteView, type SiteView } from './dto/site-response';
import { SitesService } from './sites.service';

@ApiTags('sites')
@ApiBearerAuth('access-token')
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @RequirePermissions(Permission.APPLICATION_VIEW)
  @ApiOperation({
    summary: 'List the branches in an account',
    description:
      "Scoped to the caller's own account. An ADMIN may pass `accountId` to read another one.",
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListSitesQuerySchema)) query: ListSitesQueryDto,
  ): Promise<CursorPage<SiteView>> {
    const accountId = resolveAccountId(actor, query.accountId);
    const page = await this.sites.list(accountId, query);
    return { items: page.items.map(toSiteView), pageInfo: page.pageInfo };
  }

  @Get(':siteId')
  @RequirePermissions(Permission.APPLICATION_VIEW)
  @ApiOperation({ summary: 'One branch, with its addresses' })
  async findOne(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('siteId') siteId: string,
    @Query('accountId') accountId?: string,
  ): Promise<SiteView> {
    return toSiteView(await this.sites.findById(resolveAccountId(actor, accountId), siteId));
  }

  @Post()
  @RequirePermissions(Permission.SITE_MANAGE)
  @ApiOperation({ summary: 'Create a branch' })
  @ApiZodBody(CreateSiteSchema, {
    example: {
      code: 'VIC-042',
      name: 'Richmond',
      monthlyBudget: '5000.00',
      poRequired: true,
      poPrefix: 'VIC',
      addresses: [
        {
          kind: 'SHIPPING',
          label: 'Back dock',
          line1: '12 Swan Street',
          city: 'Richmond',
          region: 'VIC',
          postcode: '3121',
          country: 'AU',
          isDefault: true,
        },
      ],
    },
  })
  async create(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateSiteSchema)) body: CreateSiteDto,
  ): Promise<SiteView> {
    return toSiteView(await this.sites.create(resolveAccountId(actor, body.accountId), body));
  }

  @Patch(':siteId')
  @RequirePermissions(Permission.SITE_MANAGE)
  @ApiOperation({ summary: 'Update a branch' })
  @ApiZodBody(UpdateSiteSchema, { example: { monthlyBudget: '7500.00', poRequired: true } })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('siteId') siteId: string,
    @Body(zodBody(UpdateSiteSchema)) body: UpdateSiteDto,
    @Query('accountId') accountId?: string,
  ): Promise<SiteView> {
    return toSiteView(await this.sites.update(resolveAccountId(actor, accountId), siteId, body));
  }

  @Post(':siteId/addresses')
  @RequirePermissions(Permission.SITE_MANAGE)
  @ApiOperation({ summary: 'Add a bill-to or ship-to address to a branch' })
  @ApiZodBody(AddSiteAddressSchema, {
    example: {
      kind: 'BILLING',
      line1: 'Level 4, 120 Collins Street',
      city: 'Melbourne',
      region: 'VIC',
      postcode: '3000',
      country: 'AU',
      isDefault: true,
    },
  })
  async addAddress(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('siteId') siteId: string,
    @Body(zodBody(AddSiteAddressSchema)) body: AddSiteAddressDto,
    @Query('accountId') accountId?: string,
  ): Promise<SiteView> {
    return toSiteView(
      await this.sites.addAddress(resolveAccountId(actor, accountId), siteId, body),
    );
  }

  @Delete(':siteId')
  @HttpCode(204)
  @RequirePermissions(Permission.SITE_MANAGE)
  @ApiOperation({
    summary: 'Deactivate a branch',
    description:
      'A soft delete. Historical orders and invoices reference the branch, so the row survives ' +
      'and only stops accepting new orders.',
  })
  async deactivate(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('siteId') siteId: string,
    @Query('accountId') accountId?: string,
  ): Promise<void> {
    await this.sites.deactivate(resolveAccountId(actor, accountId), siteId);
  }
}

/**
 * Which tenant this request acts on.
 *
 * The caller's own account, unless they are an ADMIN and asked for a different
 * one. A non-admin who supplies someone else's `accountId` is refused rather
 * than quietly served their own data: silently rewriting the parameter would
 * make a cross-tenant attempt look like a successful request and leave nothing
 * in the logs worth alerting on.
 */
function resolveAccountId(actor: AuthenticatedActor, requested?: string): string {
  if (!requested || requested === actor.accountId) return actor.accountId;

  if (actor.role !== Role.ADMIN) {
    throw new ForbiddenError('You may only act on your own account', {
      details: { requestedAccountId: requested },
    });
  }
  return requested;
}
