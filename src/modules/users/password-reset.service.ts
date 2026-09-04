import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  BusinessRuleError,
  createId,
  createSecretToken,
  UnauthenticatedError,
  UserType,
} from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';
import { PrismaService } from '@/database';
import { PasswordHasherService, TokenService } from '@/modules/auth';
import { AuditAction, AuditService } from '@/modules/audit';
import { MailDispatcher } from '@/shared/mailer';

export interface ResetContext {
  readonly ip?: string;
  readonly userAgent?: string;
}

/**
 * Self-service password reset for portal-native and external users.
 *
 * ---------------------------------------------------------------------------
 * Why legacy users are excluded
 * ---------------------------------------------------------------------------
 * A user replicated from legacy authenticates against the portal's Argon2id
 * hash, and AuthService falls back to the legacy database whenever that hash
 * rejects — which is how an upstream password change is picked up (see
 * retryAgainstLegacy). Letting such a user set a portal-only password would
 * make the two systems disagree, and the next time they typed their *old*
 * legacy password the fallback would succeed and overwrite the local hash,
 * silently undoing the reset.
 *
 * Rather than build a per-user "local password wins" flag to paper over that,
 * this flow refuses and points the user at the legacy system, which remains the
 * source of truth for their credential. Closing that gap properly is a decision
 * for the identity work in the architecture document, not something to smuggle
 * in here.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasherService,
    private readonly tokens: TokenService,
    private readonly mail: MailDispatcher,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Starts a reset. Always resolves, whatever the identifier was.
   *
   * The controller answers 204 unconditionally: an endpoint that behaved
   * differently for a known and an unknown address would let anyone test
   * whether a given person has an account here.
   */
  async request(identifier: string, context: ResetContext = {}): Promise<void> {
    const normalised = identifier.trim().toLowerCase();

    const user = await this.prisma.user.findFirst({
      // Login first: it is unique. Email is not — 159 groups of legacy users
      // share an address — so an email match takes the oldest row, and a user
      // in that situation has to use their login.
      where: {
        OR: [{ login: normalised }, { email: normalised }],
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!user) {
      this.logger.debug('Password reset requested for an unknown identifier.');
      return;
    }

    if (!this.isSelfServiceEligible(user)) {
      this.logger.log(
        `Password reset requested for ${user.id}, which is a ${user.userType} user — ` +
          'no email sent; they must reset in the legacy system.',
      );
      return;
    }

    const token = createSecretToken(32);
    const expiresAt = new Date(Date.now() + this.config.auth.passwordResetTtlMinutes * 60_000);

    await this.prisma.$transaction(async (tx) => {
      // Invalidate any outstanding token first. Two live reset links for one
      // account means the older one still works after the newer has been used.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.passwordResetToken.create({
        data: {
          id: createId('prt'),
          userId: user.id,
          tokenHash: this.digest(token),
          expiresAt,
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
        },
      });
    });

    await this.mail.sendPasswordReset({
      to: user.email,
      firstName: user.firstName,
      token,
      expiresAt,
    });

    // The requester is unauthenticated, so the actor is the account holder
    // themselves — this records that a reset was *asked for*, which is the
    // signal worth having when an account is later found compromised.
    await this.audit.record({
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      entityType: 'USER',
      entityId: user.id,
      entityName: `${user.firstName} ${user.lastName}`.trim() || user.login,
      accountId: user.accountId,
      actor: this.selfActor(user),
      details: { expiresAt: expiresAt.toISOString() },
    });

    this.logger.log(`Password reset email queued for user ${user.id}.`);
  }

  /**
   * Completes a reset.
   *
   * Every existing session is revoked on success. A password is usually reset
   * because the old one may be known to someone else, and leaving their refresh
   * token live for another thirty days would make the reset cosmetic.
   */
  async complete(token: string, password: string): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.digest(token) },
      include: { user: true },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError('This reset link is not valid or has already been used');
    }

    if (record.user.deletedAt || record.user.status === 'DISABLED') {
      throw new BusinessRuleError('This account is not active');
    }

    // Re-checked at completion, not only at request: the user's type could have
    // changed between the two, and this is the step that actually writes.
    if (!this.isSelfServiceEligible(record.user)) {
      throw new BusinessRuleError(
        'This account is managed in the legacy Ticket-IT system. Reset your password there.',
      );
    }

    const passwordHash = await this.hasher.hash(password);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          // An invited user who never signed in but did reset their password is
          // active from this moment.
          status: 'ACTIVE',
          activatedAt: record.user.activatedAt ?? new Date(),
        },
      });

      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
    });

    await this.tokens.revokeAllForUser(record.userId);

    await this.audit.record({
      action: AuditAction.PASSWORD_RESET_COMPLETED,
      entityType: 'USER',
      entityId: record.userId,
      entityName: `${record.user.firstName} ${record.user.lastName}`.trim() || record.user.login,
      accountId: record.user.accountId,
      actor: this.selfActor(record.user),
      details: { sessionsRevoked: true },
    });

    this.logger.log(`Password reset completed for user ${record.userId}; sessions revoked.`);
  }

  /**
   * Change a signed-in user's own password.
   *
   * Unlike `complete` this proves the old credential first, so a token lifted
   * from an unlocked machine cannot be used to take the account over. Failure
   * is deliberately one message for both "no local password" and "wrong
   * password": distinguishing them tells an attacker holding a stolen token
   * which accounts are legacy-backed and therefore not worth attacking here.
   *
   * Every refresh token is revoked afterwards, so no session anywhere can be
   * renewed — if the reason for the change was that somebody else held the old
   * password, their session dies at its next refresh.
   *
   * Access tokens are stateless and are *not* revoked: one already issued keeps
   * working until it expires, up to fifteen minutes later. Saying this outright
   * matters, because "signs you out everywhere" is what a user will assume and
   * it is not quite true. Killing the window entirely needs a denylist checked
   * on every request, which is a different design decision from this one.
   */
  async change(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthenticatedError('Sign in again to change your password');

    const wrong = new BusinessRuleError('That is not your current password');

    // A legacy user whose password still lives upstream has no local hash to
    // check against, so there is nothing here to change.
    if (!user.passwordHash) throw wrong;
    if (!(await this.hasher.verify(currentPassword, user.passwordHash))) throw wrong;

    const passwordHash = await this.hasher.hash(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });

    await this.tokens.revokeAllForUser(userId);

    await this.audit.record({
      action: AuditAction.PASSWORD_CHANGED,
      entityType: 'USER',
      entityId: userId,
      entityName: `${user.firstName} ${user.lastName}`.trim() || user.login,
      accountId: user.accountId,
      actor: this.selfActor(user),
      details: { sessionsRevoked: true },
    });

    this.logger.log(`Password changed by user ${userId}; sessions revoked.`);
  }

  /** The user acting on their own credential, for the two unauthenticated steps. */
  private selfActor(user: User) {
    return {
      userId: user.id,
      name: `${user.firstName} ${user.lastName}`.trim() || user.login,
      email: user.email,
      role: user.role as string,
      accountId: user.accountId,
    };
  }

  /**
   * Whether this user's password lives here rather than in the legacy system.
   *
   * See the class comment: EXISTING users are excluded because the legacy
   * fallback in AuthService would overwrite whatever they set.
   */
  private isSelfServiceEligible(user: User): boolean {
    return user.userType !== UserType.EXISTING && user.legacyUserId === null;
  }
}
