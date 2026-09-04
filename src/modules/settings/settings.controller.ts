import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ForbiddenError,
  Permission,
  RequirePermissions,
  Role,
  type AuthenticatedActor,
} from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { UpdateSettingsSchema, type UpdateSettingsDto } from './dto/settings.dto';
import { toSettingsView, type SettingsView } from './dto/settings-response';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions(Permission.ACCOUNT_MANAGE)
  @ApiOperation({
    summary: "The account's operational settings",
    description:
      "Scoped to the caller's own account. An ADMIN may pass `accountId` to read another one. " +
      'The row is created with its defaults the first time it is read.',
  })
  async read(
    @CurrentUser() actor: AuthenticatedActor,
    @Query('accountId') accountId?: string,
  ): Promise<SettingsView> {
    const { account, settings } = await this.settings.forAccount(
      resolveAccountId(actor, accountId),
    );
    return toSettingsView(account, settings);
  }

  @Patch()
  @RequirePermissions(Permission.ACCOUNT_MANAGE)
  @ApiZodBody(UpdateSettingsSchema)
  @ApiOperation({
    summary: 'Update the settings',
    description:
      'Every field is optional; only what is sent is written. The settings screen saves one tab ' +
      'at a time, and a full-document PUT would have two tabs saved in either order overwrite ' +
      'each other.',
  })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(UpdateSettingsSchema)) dto: UpdateSettingsDto,
    @Query('accountId') accountId?: string,
  ): Promise<SettingsView> {
    const { account, settings } = await this.settings.update(
      resolveAccountId(actor, accountId),
      dto,
      actor.userId,
    );
    return toSettingsView(account, settings);
  }
}

/**
 * Whose settings this call is about.
 *
 * Only an ADMIN may name another account; for everyone else the parameter is
 * refused rather than ignored, so a client that sends the wrong one is told
 * instead of quietly reading its own.
 */
function resolveAccountId(actor: AuthenticatedActor, requested?: string): string {
  if (!requested || requested === actor.accountId) return actor.accountId;
  if (actor.role !== Role.ADMIN) {
    throw new ForbiddenError("You cannot read or change another account's settings");
  }
  return requested;
}
