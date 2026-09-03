import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ForbiddenError,
  Permission,
  RequirePermissions,
  Role,
  Public,
  type AuthenticatedActor,
  type CursorPage,
} from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { loadConfig } from '@/config';
import { AuthService, CurrentUser, toLoginResponse, type LoginResponse } from '@/modules/auth';
import {
  AcceptInvitationSchema,
  CreateInvitationSchema,
  ListInvitationsQuerySchema,
  type AcceptInvitationDto,
  type CreateInvitationDto,
  type ListInvitationsQueryDto,
} from './dto/invitation.dto';
import { toInvitationView, type InvitationView } from './dto/user-response';
import { InvitationService } from './invitation.service';

const config = loadConfig();

/** Credential-adjacent, so the tighter auth limit applies, not the global one. */
const AUTH_THROTTLE = {
  default: {
    limit: config.security.rateLimit.authMax,
    ttl: config.security.rateLimit.ttlSeconds * 1000,
  },
};

@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @RequirePermissions(Permission.USER_INVITE)
  @ApiOperation({
    summary: 'Invite a portal-native or external user',
    description:
      'No user row is created until the invitation is accepted, so revoking or letting it ' +
      'expire leaves nothing behind that can be logged into.',
  })
  @ApiZodBody(CreateInvitationSchema, {
    example: {
      email: 'jo@partner.example',
      firstName: 'Jo',
      lastName: 'Reed',
      role: 'SITE_USER',
      userType: 'EXTERNAL',
      siteId: 'sit_01j9x…',
    },
  })
  async create(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateInvitationSchema)) body: CreateInvitationDto,
  ): Promise<InvitationView> {
    const accountId = resolveAccountId(actor, body.accountId);
    assertMayGrantRole(actor, body.role);

    return toInvitationView(await this.invitations.create(accountId, body, actor));
  }

  @Get()
  @ApiBearerAuth('access-token')
  @RequirePermissions(Permission.USER_INVITE)
  @ApiOperation({ summary: 'List invitations for an account' })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListInvitationsQuerySchema)) query: ListInvitationsQueryDto,
  ): Promise<CursorPage<InvitationView>> {
    const page = await this.invitations.list(resolveAccountId(actor, query.accountId), query);
    return { items: page.items.map(toInvitationView), pageInfo: page.pageInfo };
  }

  @Post(':invitationId/revoke')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @RequirePermissions(Permission.USER_INVITE)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('invitationId') invitationId: string,
    @Query('accountId') accountId?: string,
  ): Promise<void> {
    await this.invitations.revoke(resolveAccountId(actor, accountId), invitationId);
  }

  @Post('accept')
  @Public()
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Accept an invitation and set a password',
    description:
      'Creates the user and returns a token pair, so the invitee is signed in immediately ' +
      'rather than being sent to a login form to retype the password they just chose.',
  })
  @ApiZodBody(AcceptInvitationSchema, {
    example: { token: 'the-token-from-the-invitation-email', password: 'a-long-passphrase' },
  })
  async accept(
    @Body(zodBody(AcceptInvitationSchema)) body: AcceptInvitationDto,
  ): Promise<LoginResponse> {
    const result = await this.invitations.accept(body.token, body.password);
    return toLoginResponse(result.tokens, await this.auth.describeUser(result.user));
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

/**
 * Nobody invites someone more privileged than themselves.
 *
 * USER_INVITE is held by HEAD_OFFICE, and without this a head-office user could
 * invite an ADMIN and then sign in as them — a one-step privilege escalation
 * that the permission check alone does not catch, because inviting is exactly
 * the thing they are allowed to do.
 */
function assertMayGrantRole(actor: AuthenticatedActor, role: Role): void {
  if (role === Role.ADMIN && actor.role !== Role.ADMIN) {
    throw new ForbiddenError('Only an administrator can invite another administrator', {
      details: { requestedRole: role },
    });
  }
}
