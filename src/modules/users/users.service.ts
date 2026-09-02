import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, User, UserPermissionGrant } from '@prisma/client';
import {
  BusinessRuleError,
  createId,
  emptyPage,
  isPermission,
  NotFoundError,
  Role,
  UserType,
  type AuthenticatedActor,
  type CursorPage,
} from '@/common';
import { PrismaService, withTenantScope, type TransactionClient } from '@/database';
import { TokenService } from '@/modules/auth';
import { AuditAction, AuditService } from '@/modules/audit';
import type {
  GrantPermissionDto,
  ListUsersQueryDto,
  RevokePermissionDto,
  UpdateUserDto,
} from './dto/user.dto';

export type UserWithSites = User & {
  site: { id: string; code: string; name: string } | null;
  siteAccess: { siteId: string }[];
};

/**
 * User administration inside a tenant.
 *
 * Creating users is not here — that is InvitationService for portal-native and
 * external users, and UserProvisioningService for replicated legacy ones. This
 * covers what happens afterwards: role, status, branch attachment and the
 * per-user permission grants that RBAC's code-defined baseline cannot express.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async list(accountId: string, query: ListUsersQueryDto): Promise<CursorPage<UserWithSites>> {
    const where: Prisma.UserWhereInput = {
      accountId,
      deletedAt: null,
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.userType ? { userType: query.userType } : {}),
      ...(query.search
        ? {
            OR: [
              { login: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return withTenantScope(this.prisma, accountId, async (tx) => {
      const rows = await tx.user.findMany({
        where,
        include: {
          site: { select: { id: true, code: true, name: true } },
          siteAccess: { select: { siteId: true } },
        },
        orderBy: [{ lastName: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) return emptyPage<UserWithSites>(query.limit);

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;

      return {
        items,
        pageInfo: {
          nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
          hasMore,
          limit: query.limit,
        },
      };
    });
  }

  async findById(accountId: string, userId: string): Promise<UserWithSites> {
    return withTenantScope(this.prisma, accountId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, accountId, deletedAt: null },
        include: {
          site: { select: { id: true, code: true, name: true } },
          siteAccess: { select: { siteId: true } },
        },
      });
      if (!user) throw new NotFoundError('User');
      return user;
    });
  }

  async update(
    accountId: string,
    userId: string,
    dto: UpdateUserDto,
    actor: AuthenticatedActor,
  ): Promise<UserWithSites> {
    const target = await this.findById(accountId, userId);

    this.assertNotSelfDemotion(target, dto, actor);
    this.assertExternalStaysConstrained(target, dto);

    const updated = await withTenantScope(this.prisma, accountId, async (tx) => {
      if (dto.siteId) await this.assertSiteBelongsToAccount(tx, accountId, dto.siteId);

      if (dto.additionalSiteIds) {
        for (const siteId of dto.additionalSiteIds) {
          await this.assertSiteBelongsToAccount(tx, accountId, siteId);
        }

        // Replace rather than merge: the caller sent the complete set, and a
        // merge would make removing a branch impossible through this endpoint.
        await tx.userSiteAccess.deleteMany({ where: { userId } });
        if (dto.additionalSiteIds.length > 0) {
          await tx.userSiteAccess.createMany({
            data: dto.additionalSiteIds.map((siteId) => ({
              id: createId('usa'),
              accountId,
              userId,
              siteId,
            })),
          });
        }
      }

      return tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
        },
        include: {
          site: { select: { id: true, code: true, name: true } },
          siteAccess: { select: { siteId: true } },
        },
      });
    });

    const name = `${updated.firstName} ${updated.lastName}`.trim() || updated.login;

    // A role change is its own action, not a line in a diff: "who made this
    // person an administrator" is a question asked on its own, usually under
    // time pressure.
    if (dto.role !== undefined && dto.role !== target.role) {
      await this.audit.record({
        action: AuditAction.USER_ROLE_CHANGED,
        entityType: 'USER',
        entityId: userId,
        entityName: name,
        accountId,
        details: { from: target.role, to: dto.role },
      });
    }

    await this.audit.record({
      action: AuditAction.USER_UPDATED,
      entityType: 'USER',
      entityId: userId,
      entityName: name,
      accountId,
      details: { changes: dto },
    });

    // The access token carries role, siteId and userType, so any of these
    // changing makes every live token stale — and a demotion that only takes
    // effect when the token expires is not a demotion. Revoking the refresh
    // family bounds it to the access TTL.
    if (dto.role !== undefined || dto.siteId !== undefined || dto.status === 'DISABLED') {
      await this.tokens.revokeAllForUser(userId);
      this.logger.log(`Revoked sessions for ${userId} after an access-affecting change.`);
    }

    return updated;
  }

  /**
   * Deactivates a user and ends their sessions.
   *
   * Soft, like everything else: the row is referenced by orders, approvals and
   * audit entries, so it has to survive. `deletedAt` plus DISABLED is what stops
   * them logging in — AuthService checks both.
   */
  async deactivate(accountId: string, userId: string, actor: AuthenticatedActor): Promise<void> {
    if (userId === actor.userId) {
      throw new BusinessRuleError('You cannot deactivate your own account');
    }

    const target = await this.findById(accountId, userId);

    await withTenantScope(this.prisma, accountId, async (tx) => {
      const result = await tx.user.updateMany({
        where: { id: userId, accountId, deletedAt: null },
        data: { status: 'DISABLED', deletedAt: new Date() },
      });
      if (result.count === 0) throw new NotFoundError('User');
    });

    await this.tokens.revokeAllForUser(userId);

    await this.audit.record({
      action: AuditAction.USER_DEACTIVATED,
      entityType: 'USER',
      entityId: userId,
      entityName: `${target.firstName} ${target.lastName}`.trim() || target.login,
      accountId,
      details: { login: target.login, role: target.role, userType: target.userType },
    });

    this.logger.log(`Deactivated user ${userId} in account ${accountId}.`);
  }

  // --- Permission grants ------------------------------------------------------

  async listGrants(accountId: string, userId: string): Promise<UserPermissionGrant[]> {
    await this.findById(accountId, userId);

    return withTenantScope(this.prisma, accountId, (tx) =>
      tx.userPermissionGrant.findMany({
        where: { userId, accountId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async grant(
    accountId: string,
    userId: string,
    dto: GrantPermissionDto,
    actor: AuthenticatedActor,
  ): Promise<UserPermissionGrant> {
    await this.findById(accountId, userId);

    // The DTO validates against the catalog already; this is the belt to that
    // braces, and it narrows the type for the write.
    if (!isPermission(dto.permission)) {
      throw new BusinessRuleError(`Unknown permission "${dto.permission}"`);
    }

    if (dto.expiresAt && dto.expiresAt.getTime() <= Date.now()) {
      throw new BusinessRuleError('A grant cannot expire in the past');
    }

    const resourceId = dto.resourceId ?? null;

    const grant = await withTenantScope(this.prisma, accountId, async (tx) => {
      // Not an upsert. The unique index is (userId, permission, resourceId) and
      // resourceId is nullable, so Prisma's compound-unique `where` cannot
      // express the account-wide row at all — PostgreSQL treats NULLs as
      // distinct, which is also why the index does not actually prevent two of
      // them. Finding first and branching is what makes a repeat grant an
      // update rather than a duplicate.
      const existing = await tx.userPermissionGrant.findFirst({
        where: { userId, accountId, permission: dto.permission, resourceId },
        select: { id: true },
      });

      if (existing) {
        return tx.userPermissionGrant.update({
          where: { id: existing.id },
          data: {
            effect: dto.effect,
            reason: dto.reason ?? null,
            expiresAt: dto.expiresAt ?? null,
            grantedById: actor.userId,
          },
        });
      }

      return tx.userPermissionGrant.create({
        data: {
          id: createId('grt'),
          accountId,
          userId,
          permission: dto.permission,
          effect: dto.effect,
          resourceId,
          reason: dto.reason ?? null,
          expiresAt: dto.expiresAt ?? null,
          grantedById: actor.userId,
        },
      });
    });

    await this.audit.record({
      action: AuditAction.USER_PERMISSION_GRANTED,
      entityType: 'PERMISSION',
      entityId: grant.id,
      entityName: dto.permission,
      accountId,
      details: {
        subjectUserId: userId,
        permission: dto.permission,
        effect: dto.effect,
        resourceId,
        reason: dto.reason ?? null,
        expiresAt: dto.expiresAt?.toISOString() ?? null,
      },
    });

    this.logger.log(
      `${actor.userId} set ${dto.effect} ${dto.permission}` +
        `${dto.resourceId ? ` on ${dto.resourceId}` : ''} for user ${userId}.`,
    );

    return grant;
  }

  async revokeGrant(accountId: string, userId: string, dto: RevokePermissionDto): Promise<void> {
    await withTenantScope(this.prisma, accountId, async (tx) => {
      const result = await tx.userPermissionGrant.deleteMany({
        where: {
          userId,
          accountId,
          permission: dto.permission,
          resourceId: dto.resourceId ?? null,
        },
      });
      if (result.count === 0) throw new NotFoundError('Permission grant');
    });

    await this.audit.record({
      action: AuditAction.USER_PERMISSION_REVOKED,
      entityType: 'PERMISSION',
      entityId: `${userId}:${dto.permission}`,
      entityName: dto.permission,
      accountId,
      details: {
        subjectUserId: userId,
        permission: dto.permission,
        resourceId: dto.resourceId ?? null,
      },
    });
  }

  // --- Guards on the guards ---------------------------------------------------

  /**
   * Stops an administrator locking themselves — and possibly the account — out.
   *
   * Not a security control: someone with USER_MANAGE can still demote a peer.
   * It is a foot-gun guard, and the reason it is worth having is that the
   * mistake is unrecoverable through the API that made it.
   */
  private assertNotSelfDemotion(target: User, dto: UpdateUserDto, actor: AuthenticatedActor): void {
    if (target.id !== actor.userId) return;

    if (dto.role !== undefined && dto.role !== actor.role) {
      throw new BusinessRuleError('You cannot change your own role');
    }
    if (dto.status === 'DISABLED') {
      throw new BusinessRuleError('You cannot deactivate your own account');
    }
  }

  /**
   * External users stay least-privileged.
   *
   * Their permission baseline is a closed list that ignores `role`
   * (see basePermissionsFor), so promoting one to ADMIN would grant nothing and
   * merely make the UI lie about what they can do. Refusing keeps the record
   * honest, and anything genuinely needed is a per-resource grant.
   */
  private assertExternalStaysConstrained(target: User, dto: UpdateUserDto): void {
    if (target.userType !== UserType.EXTERNAL) return;

    if (dto.role !== undefined && dto.role !== Role.SITE_USER) {
      throw new BusinessRuleError(
        'An external user cannot hold an elevated role. Grant individual permissions instead.',
      );
    }
    if (dto.siteId === null) {
      throw new BusinessRuleError('An external user must stay attached to a site');
    }
  }

  private async assertSiteBelongsToAccount(
    tx: TransactionClient,
    accountId: string,
    siteId: string,
  ): Promise<void> {
    const site = await tx.site.findFirst({
      where: { id: siteId, accountId, deletedAt: null },
      select: { id: true },
    });
    if (!site) throw new NotFoundError('Site');
  }
}
