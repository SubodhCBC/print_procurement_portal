import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Invitation, User } from '@prisma/client';
import {
  BusinessRuleError,
  ConflictError,
  createId,
  createSecretToken,
  emptyPage,
  NotFoundError,
  UnauthenticatedError,
  UserType,
  type AuthenticatedActor,
  type CursorPage,
} from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';
import { PrismaService, withTenantScope } from '@/database';
import { PasswordHasherService, TokenService, type IssuedTokens } from '@/modules/auth';
import { AuditAction, AuditService } from '@/modules/audit';
import { MailDispatcher } from '@/shared/mailer';
import type { CreateInvitationDto, ListInvitationsQueryDto } from './dto/invitation.dto';

export interface AcceptedInvitation {
  readonly tokens: IssuedTokens;
  readonly user: User;
}

/**
 * Invitations for users who have no legacy counterpart.
 *
 * The user row is created at *acceptance*, not at invitation. A revoked or
 * expired invitation therefore leaves nothing behind that could later be logged
 * into, and an administrator who mistypes an address has not created an account
 * for a stranger. The cost is that "invited users" and "users" are two lists in
 * the UI, which is the honest shape of the thing anyway.
 *
 * The token follows the refresh-token pattern exactly: 256 bits of entropy,
 * emailed once, stored only as a SHA-256 digest. A dump of `invitations` cannot
 * be replayed into an account.
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasherService,
    private readonly tokens: TokenService,
    private readonly mail: MailDispatcher,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** SHA-256, not Argon2 — see TokenService.digest for why. */
  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async create(
    accountId: string,
    dto: CreateInvitationDto,
    invitedBy: AuthenticatedActor,
  ): Promise<Invitation> {
    const expiresAt = new Date(Date.now() + this.config.auth.invitationTtlHours * 3_600_000);
    const token = createSecretToken(32);

    const { invitation, accountName } = await withTenantScope(
      this.prisma,
      accountId,
      async (tx) => {
        const account = await tx.account.findFirst({
          where: { id: accountId, deletedAt: null },
          select: { name: true },
        });
        if (!account) throw new NotFoundError('Account');

        if (dto.siteId) {
          const site = await tx.site.findFirst({
            where: { id: dto.siteId, accountId, deletedAt: null },
            select: { id: true },
          });
          // Checked inside the tenant scope, so naming a site that belongs to
          // another customer is indistinguishable from naming one that does not
          // exist — which is what it should look like to the caller.
          if (!site) throw new NotFoundError('Site');
        }

        // The invited address becomes the new user's login, and login is unique
        // across *all* accounts — so this check deliberately uses the unscoped
        // client rather than `tx`, which RLS has narrowed to one tenant and
        // which therefore could not see a clash in another. Catching it here
        // gives a usable message instead of a constraint violation at
        // acceptance time, in front of the invitee rather than the
        // administrator.
        const clash = await this.prisma.user.findUnique({
          where: { login: dto.email },
          select: { id: true },
        });
        if (clash) {
          throw new ConflictError('A user with that email address already exists', {
            details: { email: dto.email },
          });
        }

        const outstanding = await tx.invitation.findFirst({
          where: { accountId, email: dto.email, status: 'PENDING' },
          select: { id: true },
        });
        // Revoke-then-reinvite rather than silently issuing a second live token:
        // two valid invitations for one address means revoking one of them does
        // not actually revoke access.
        if (outstanding) {
          await tx.invitation.update({
            where: { id: outstanding.id },
            data: { status: 'REVOKED', revokedAt: new Date() },
          });
        }

        const created = await tx.invitation.create({
          data: {
            id: createId('inv'),
            accountId,
            siteId: dto.siteId ?? null,
            email: dto.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: dto.role,
            userType: dto.userType,
            tokenHash: this.digest(token),
            expiresAt,
            invitedById: invitedBy.userId,
          },
        });

        return { invitation: created, accountName: account.name };
      },
    );

    await this.mail.sendInvitation({
      to: invitation.email,
      firstName: invitation.firstName,
      accountName,
      token,
      expiresAt,
      isExternal: invitation.userType === UserType.EXTERNAL,
    });

    await this.audit.record({
      action: AuditAction.INVITATION_SENT,
      entityType: 'INVITATION',
      entityId: invitation.id,
      entityName: invitation.email,
      accountId,
      details: {
        email: invitation.email,
        role: invitation.role,
        userType: invitation.userType,
        siteId: invitation.siteId,
        expiresAt: invitation.expiresAt.toISOString(),
      },
    });

    this.logger.log(
      `Invited ${invitation.email} to account ${accountId} as ${invitation.role} ` +
        `(${invitation.userType}); invitation ${invitation.id}.`,
    );

    return invitation;
  }

  async list(accountId: string, query: ListInvitationsQueryDto): Promise<CursorPage<Invitation>> {
    return withTenantScope(this.prisma, accountId, async (tx) => {
      const rows = await tx.invitation.findMany({
        where: { accountId, ...(query.status ? { status: query.status } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) return emptyPage<Invitation>(query.limit);

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

  async revoke(accountId: string, invitationId: string): Promise<void> {
    const revoked = await withTenantScope(this.prisma, accountId, async (tx) => {
      const result = await tx.invitation.updateMany({
        where: { id: invitationId, accountId, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });

      if (result.count === 0) {
        // Either it does not exist or it is no longer pending. Both are "there
        // is nothing here to revoke", and distinguishing them would leak
        // whether an invitation was accepted.
        throw new NotFoundError('Pending invitation');
      }

      return tx.invitation.findFirstOrThrow({ where: { id: invitationId } });
    });

    await this.audit.record({
      action: AuditAction.INVITATION_REVOKED,
      entityType: 'INVITATION',
      entityId: invitationId,
      entityName: revoked.email,
      accountId,
    });
  }

  /**
   * Redeems an invitation and creates the user.
   *
   * Runs unauthenticated — the invitee has no account yet, which is the whole
   * point — so it takes no tenant scope: the account is discovered from the
   * token, not supplied by the caller.
   */
  async accept(token: string, password: string): Promise<AcceptedInvitation> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: this.digest(token) },
      include: { account: { select: { name: true, deletedAt: true } } },
    });

    // One message for every failure mode. An invitee cannot act on the
    // difference between "wrong token" and "already accepted", and telling an
    // attacker which one they hit turns this into an oracle.
    if (!invitation || invitation.status !== 'PENDING') {
      throw new UnauthenticatedError('This invitation is not valid or has already been used');
    }

    if (invitation.expiresAt.getTime() <= Date.now()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      });
      throw new UnauthenticatedError('This invitation has expired. Ask for a new one.');
    }

    if (invitation.account.deletedAt) {
      throw new BusinessRuleError('The account this invitation belongs to is no longer active');
    }

    const passwordHash = await this.hasher.hash(password);

    const user = await this.prisma.$transaction(async (tx) => {
      // Re-checked inside the transaction: the address may have been claimed
      // between the invitation being issued and it being accepted.
      const clash = await tx.user.findUnique({
        where: { login: invitation.email },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictError('A user with that email address already exists');
      }

      const created = await tx.user.create({
        data: {
          id: createId('usr'),
          accountId: invitation.accountId,
          siteId: invitation.siteId,
          userType: invitation.userType,
          // The email is the login for a portal-native user: they have no
          // legacy `Users.Login` to inherit, and asking them to invent a second
          // identifier at signup is friction with no security value.
          login: invitation.email,
          loginDisplay: invitation.email,
          email: invitation.email,
          firstName: invitation.firstName,
          lastName: invitation.lastName,
          passwordHash,
          role: invitation.role,
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedUserId: created.id },
      });

      return created;
    });

    // The acceptor is not the authenticated caller — this route is public and
    // the user did not exist a moment ago — so the actor is stated explicitly
    // rather than read from the request context, which holds nobody.
    await this.audit.record({
      action: AuditAction.INVITATION_ACCEPTED,
      entityType: 'INVITATION',
      entityId: invitation.id,
      entityName: invitation.email,
      accountId: invitation.accountId,
      actor: {
        userId: user.id,
        name: `${user.firstName} ${user.lastName}`.trim() || user.login,
        email: user.email,
        role: user.role,
        accountId: invitation.accountId,
      },
      details: { createdUserId: user.id, role: user.role, userType: user.userType },
    });

    this.logger.log(`Invitation ${invitation.id} accepted; created user ${user.id}.`);

    // Best-effort: the account exists and is usable whether or not the welcome
    // email is queued, so a Redis blip must not fail an acceptance the user
    // cannot retry — their token has just been consumed.
    try {
      await this.mail.sendWelcome({
        to: user.email,
        firstName: user.firstName,
        accountName: invitation.account.name,
      });
    } catch (error) {
      this.logger.warn(
        `Could not queue the welcome email for ${user.id}; the account is active regardless.`,
        error instanceof Error ? error.message : String(error),
      );
    }

    return { tokens: await this.tokens.issue(user), user };
  }
}
