import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  basePermissionsFor,
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
import { PermissionService } from '@/modules/authorization';
import {
  GrantPermissionSchema,
  ListUsersQuerySchema,
  RevokePermissionSchema,
  UpdateUserSchema,
  type GrantPermissionDto,
  type ListUsersQueryDto,
  type RevokePermissionDto,
  type UpdateUserDto,
} from './dto/user.dto';
import {
  toGrantView,
  toUserSummaryView,
  type EffectivePermissionsView,
  type PermissionGrantView,
  type UserSummaryView,
} from './dto/user-response';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Declared before `:userId` on purpose. Fastify matches static segments ahead
   * of parameters regardless, but the ordering keeps the reading order honest
   * for anyone scanning the file.
   */
  @Get('me/permissions')
  @ApiOperation({
    summary: 'What the caller is allowed to do',
    description:
      "The role baseline with the caller's own grants applied. The frontend uses it to " +
      'decide which navigation and actions to render — it is a convenience, not the ' +
      'enforcement point, which is always the guard on the endpoint itself.',
  })
  async myPermissions(@CurrentUser() actor: AuthenticatedActor): Promise<EffectivePermissionsView> {
    const effective = await this.permissions.resolve(actor);
    return {
      userId: actor.userId,
      role: actor.role,
      userType: actor.userType,
      permissions: [...effective.accountWide].sort(),
    };
  }

  @Get()
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({ summary: 'List users in an account' })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListUsersQuerySchema)) query: ListUsersQueryDto,
  ): Promise<CursorPage<UserSummaryView>> {
    const page = await this.users.list(resolveAccountId(actor, query.accountId), query);
    return { items: page.items.map(toUserSummaryView), pageInfo: page.pageInfo };
  }

  @Get(':userId')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({ summary: 'One user' })
  async findOne(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('userId') userId: string,
    @Query('accountId') accountId?: string,
  ): Promise<UserSummaryView> {
    return toUserSummaryView(await this.users.findById(resolveAccountId(actor, accountId), userId));
  }

  @Patch(':userId')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: "Change a user's role, status or branch attachment",
    description:
      "Revokes the user's sessions when the change affects access, so a demotion takes " +
      'effect within the access-token TTL rather than at the end of the refresh window.',
  })
  @ApiZodBody(UpdateUserSchema, {
    example: { role: 'HEAD_OFFICE', siteId: null, additionalSiteIds: ['sit_01j9x…'] },
  })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('userId') userId: string,
    @Body(zodBody(UpdateUserSchema)) body: UpdateUserDto,
    @Query('accountId') accountId?: string,
  ): Promise<UserSummaryView> {
    if (body.role) assertMayGrantRole(actor, body.role);

    return toUserSummaryView(
      await this.users.update(resolveAccountId(actor, accountId), userId, body, actor),
    );
  }

  @Delete(':userId')
  @HttpCode(204)
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'Deactivate a user',
    description:
      'A soft delete: orders, approvals and audit entries reference the row, so it survives ' +
      'and only stops being able to sign in. Every session is revoked.',
  })
  async deactivate(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('userId') userId: string,
    @Query('accountId') accountId?: string,
  ): Promise<void> {
    await this.users.deactivate(resolveAccountId(actor, accountId), userId, actor);
  }

  // --- Permission grants ------------------------------------------------------

  @Get(':userId/permissions')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({ summary: 'The per-user grants layered on top of the role baseline' })
  async listGrants(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('userId') userId: string,
    @Query('accountId') accountId?: string,
  ): Promise<readonly PermissionGrantView[]> {
    const grants = await this.users.listGrants(resolveAccountId(actor, accountId), userId);
    return grants.map(toGrantView);
  }

  @Post(':userId/permissions')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'Grant or deny a permission for one user',
    description:
      'Use `resourceId` to narrow the grant to a single object — this is how an external ' +
      'user is given EXTERNAL_DOCUMENT_ACCESS to one document. DENY always beats ALLOW.',
  })
  @ApiZodBody(GrantPermissionSchema, {
    example: {
      permission: 'EXTERNAL_DOCUMENT_ACCESS',
      effect: 'ALLOW',
      resourceId: 'doc_01j9x…',
      reason: 'Campaign artwork review, ticket OPS-2291',
      expiresAt: '2026-12-31T00:00:00.000Z',
    },
  })
  async grant(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('userId') userId: string,
    @Body(zodBody(GrantPermissionSchema)) body: GrantPermissionDto,
    @Query('accountId') accountId?: string,
  ): Promise<PermissionGrantView> {
    assertMayGrantPermission(actor, body.permission);

    return toGrantView(
      await this.users.grant(resolveAccountId(actor, accountId), userId, body, actor),
    );
  }

  @Delete(':userId/permissions')
  @HttpCode(204)
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({ summary: 'Remove a permission grant' })
  @ApiZodBody(RevokePermissionSchema, {
    example: { permission: 'EXTERNAL_DOCUMENT_ACCESS', resourceId: 'doc_01j9x…' },
  })
  async revokeGrant(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('userId') userId: string,
    @Body(zodBody(RevokePermissionSchema)) body: RevokePermissionDto,
    @Query('accountId') accountId?: string,
  ): Promise<void> {
    await this.users.revokeGrant(resolveAccountId(actor, accountId), userId, body);
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

function assertMayGrantRole(actor: AuthenticatedActor, role: Role): void {
  if (role === Role.ADMIN && actor.role !== Role.ADMIN) {
    throw new ForbiddenError('Only an administrator can grant the administrator role', {
      details: { requestedRole: role },
    });
  }
}

/**
 * Nobody grants a permission they do not hold themselves.
 *
 * Without this, USER_MANAGE is effectively every permission: a head-office user
 * could grant themselves PRICING_MANAGE and rewrite their own rate card. The
 * check is against the *role baseline* rather than the caller's effective set,
 * so a permission someone was granted temporarily cannot be laundered into a
 * permanent grant for someone else.
 */
function assertMayGrantPermission(actor: AuthenticatedActor, permission: string): void {
  if (actor.role === Role.ADMIN) return;

  const held: ReadonlySet<string> = basePermissionsFor(actor.role, actor.userType);
  if (!held.has(permission)) {
    throw new ForbiddenError('You cannot grant a permission you do not hold', {
      details: { permission },
    });
  }
}
