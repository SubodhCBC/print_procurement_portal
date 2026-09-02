import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor, type OffsetPage } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { AccountsService } from './accounts.service';
import {
  CreateAccountSchema,
  ListAccountsQuerySchema,
  UpdateAccountSchema,
  type CreateAccountDto,
  type ListAccountsQueryDto,
  type UpdateAccountDto,
} from './dto/account.dto';
import { toAccountView, type AccountView } from './dto/account-response';

/**
 * Every route here is guarded by ACCOUNT_MANAGE, which only ADMIN holds in the
 * role baseline. There is no `resolveAccountId` helper as on the other
 * controllers, because these endpoints are cross-tenant by nature — the
 * permission is the boundary, not a scoping rule.
 */
@ApiTags('accounts')
@ApiBearerAuth('access-token')
@RequirePermissions(Permission.ACCOUNT_MANAGE)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({
    summary: 'List customer accounts',
    description:
      'Cross-tenant, and therefore administrator-only. Includes the site and user counts the ' +
      'admin table shows.',
  })
  async list(
    @Query(zodBody(ListAccountsQuerySchema)) query: ListAccountsQueryDto,
  ): Promise<OffsetPage<AccountView>> {
    const page = await this.accounts.list(query);
    return { ...page, items: page.items.map(toAccountView) };
  }

  @Get(':accountId')
  @ApiOperation({ summary: 'One account' })
  async findOne(@Param('accountId') accountId: string): Promise<AccountView> {
    return toAccountView(await this.accounts.findById(accountId));
  }

  @Post()
  @ApiOperation({
    summary: 'Create an account',
    description:
      'For customers with no legacy footprint. An account for an existing Ticket-IT client is ' +
      'created automatically the first time one of its users logs in — this endpoint is how the ' +
      'rest of its details are then filled in via PATCH.',
  })
  @ApiZodBody(CreateAccountSchema, {
    example: {
      accountCode: 'ACME',
      name: 'Acme Retail Group',
      contactEmail: 'accounts@acme.example',
      approvalThreshold: '1000.00',
      requirePoNumber: true,
      poPrefix: 'ACM',
    },
  })
  async create(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateAccountSchema)) body: CreateAccountDto,
  ): Promise<AccountView> {
    return toAccountView(await this.accounts.create(body, actor));
  }

  @Patch(':accountId')
  @ApiOperation({
    summary: 'Update an account',
    description:
      '`accountCode` cannot be changed here: it appears on invoices and purchase orders that ' +
      'have already been issued.',
  })
  @ApiZodBody(UpdateAccountSchema, {
    example: { status: 'SUSPENDED', approvalThreshold: '500.00' },
  })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('accountId') accountId: string,
    @Body(zodBody(UpdateAccountSchema)) body: UpdateAccountDto,
  ): Promise<AccountView> {
    return toAccountView(await this.accounts.update(accountId, body, actor));
  }

  @Delete(':accountId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate an account',
    description:
      'A soft delete. Invoices, orders and audit entries reference the account, so the row ' +
      'survives and only stops being usable.',
  })
  async deactivate(@Param('accountId') accountId: string): Promise<void> {
    await this.accounts.deactivate(accountId);
  }
}
