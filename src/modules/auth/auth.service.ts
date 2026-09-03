import { Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AppError, ErrorCode, ForbiddenError, UnauthenticatedError } from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';
import { PrismaService } from '@/database';
import { PermissionService } from '@/modules/authorization';
import type { AuthenticatedUserRecord } from './dto/auth-response';
import { LegacyUserRepository, type LegacyUserRecord } from './legacy-user.repository';
import { verifyLegacyPassword } from './password/legacy-password.verifier';
import { PasswordHasherService } from './password/password-hasher.service';
import { TokenService, type IssuedTokens, type TokenContext } from './token.service';
import { UserProvisioningService } from './user-provisioning.service';

export interface LoginResult {
  readonly tokens: IssuedTokens;
  readonly user: User;
  /** True when this login provisioned the user into the portal database. */
  readonly provisioned: boolean;
  /** Which database actually verified the password. Surfaced for logging. */
  readonly verifiedAgainst: 'portal' | 'legacy';
}

/** 401 with a distinct code so clients can tell a bad password from a lockout. */
class InvalidCredentialsError extends AppError {
  constructor() {
    super(ErrorCode.INVALID_CREDENTIALS, 401, 'Login or password is incorrect');
  }
}

/**
 * The two-database authentication flow.
 *
 *   First login       login -> legacy lookup -> verify against legacy hash ->
 *                     replicate into the portal database (re-hashed with
 *                     Argon2id) -> issue tokens
 *
 *   Later logins      login -> portal lookup -> verify locally -> issue tokens
 *                     (legacy is not touched at all)
 *
 * The legacy database is the source of truth for provisioning; the portal
 * database becomes the source of truth for authentication from the second
 * login onwards. The one crossing between them after provisioning is the
 * fallback below, for when a password is changed in the legacy system.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly legacyUsers: LegacyUserRepository,
    private readonly hasher: PasswordHasherService,
    private readonly provisioning: UserProvisioningService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(login: string, password: string, context: TokenContext = {}): Promise<LoginResult> {
    const normalisedLogin = login.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { login: normalisedLogin },
    });

    return existing
      ? this.loginExistingUser(existing, password, context)
      : this.loginFirstTime(login.trim(), password, context);
  }

  // --- First login: legacy is the authority ---------------------------------

  private async loginFirstTime(
    login: string,
    password: string,
    context: TokenContext,
  ): Promise<LoginResult> {
    const record = await this.legacyUsers.findByLogin(login);

    // Unknown login and wrong password are the same error on purpose: telling
    // an unauthenticated caller which logins exist hands them a user list.
    if (!record) throw new InvalidCredentialsError();

    const verification = await verifyLegacyPassword(password, {
      bcryptHash: record.bcryptHash,
      membershipHash: record.membershipHash,
    });
    if (!verification.valid) throw new InvalidCredentialsError();

    // Checked only after the password, so a deactivated account cannot be
    // distinguished from a non-existent one without valid credentials.
    this.assertActive(record);

    const user = await this.provisionAndIssue(record, password);

    this.logger.log(
      `First login for legacy user ${record.legacyUserId} (${verification.scheme}); ` +
        `provisioned as ${user.id}.`,
    );

    return {
      tokens: await this.tokens.issue(user, context),
      user,
      provisioned: true,
      verifiedAgainst: 'legacy',
    };
  }

  // --- Later logins: the portal database is the authority -------------------

  private async loginExistingUser(
    user: User,
    password: string,
    context: TokenContext,
  ): Promise<LoginResult> {
    if (user.deletedAt) throw new InvalidCredentialsError();

    const localMatch =
      user.passwordHash !== null && (await this.hasher.verify(password, user.passwordHash));

    if (localMatch) {
      if (user.status !== 'ACTIVE') {
        throw new ForbiddenError('This account has been deactivated. Contact your administrator.');
      }

      const refreshed = await this.refreshIfStale(user, password);
      return {
        tokens: await this.tokens.issue(refreshed, context),
        user: refreshed,
        provisioned: false,
        verifiedAgainst: 'portal',
      };
    }

    // The local hash rejected. That is usually just a wrong password — but it
    // is also exactly what an upstream password change looks like, because the
    // portal never learns about one. Re-check legacy before rejecting.
    return this.retryAgainstLegacy(user, password, context);
  }

  /**
   * Second chance against legacy after a local mismatch.
   *
   * Bounded by design: it only runs for a user who already exists locally and
   * whose local hash just failed, so a password-guessing attack pays one legacy
   * round trip per attempt and no more — the throttler in front of the login
   * route is what actually limits the rate.
   */
  private async retryAgainstLegacy(
    user: User,
    password: string,
    context: TokenContext,
  ): Promise<LoginResult> {
    if (!this.config.legacyDatabase.authFallbackEnabled) {
      throw new InvalidCredentialsError();
    }

    let record: LegacyUserRecord | undefined;
    try {
      record = await this.legacyUsers.findByLogin(user.loginDisplay);
    } catch (error) {
      // Legacy is down. The local hash already said no, so this is almost
      // certainly a genuinely wrong password; answer 401 rather than 503 and
      // avoid turning a legacy outage into a portal-wide login failure.
      this.logger.warn(
        `Legacy fallback unavailable while re-checking user ${user.id}; rejecting the login.`,
        error instanceof Error ? error.message : String(error),
      );
      throw new InvalidCredentialsError();
    }

    if (!record) throw new InvalidCredentialsError();

    const verification = await verifyLegacyPassword(password, {
      bcryptHash: record.bcryptHash,
      membershipHash: record.membershipHash,
    });
    if (!verification.valid) throw new InvalidCredentialsError();

    this.assertActive(record);

    // The password changed upstream: adopt the new one locally so the next
    // login is served from the portal database again.
    const updated = await this.provisionAndIssue(record, password);

    this.logger.log(
      `Local hash for user ${user.id} was stale; re-synced from legacy after a ` +
        `successful ${verification.scheme} verification.`,
    );

    return {
      tokens: await this.tokens.issue(updated, context),
      user: updated,
      provisioned: false,
      verifiedAgainst: 'legacy',
    };
  }

  // --- Shared helpers -------------------------------------------------------

  private async provisionAndIssue(record: LegacyUserRecord, password: string): Promise<User> {
    const passwordHash = await this.hasher.hash(password);
    return this.provisioning.syncFromLegacy(record, passwordHash);
  }

  /**
   * Refreshes the replica when it has aged past the configured TTL, so a role
   * change or deactivation upstream is picked up without waiting for the user's
   * password to change.
   *
   * Deliberately after local verification and best-effort: legacy being
   * unreachable must not fail a login that already succeeded. It also upgrades
   * the stored hash when the Argon2 cost parameters have been raised.
   */
  private async refreshIfStale(user: User, password: string): Promise<User> {
    const needsRehash = user.passwordHash !== null && this.hasher.needsRehash(user.passwordHash);
    const stale = this.provisioning.isStale(user, this.config.legacyDatabase.userSyncTtlSeconds);

    if (!stale && !needsRehash) return user;

    let record: LegacyUserRecord | undefined;
    if (stale) {
      try {
        record = await this.legacyUsers.findByLogin(user.loginDisplay);
      } catch {
        // Already logged in the repository; the login proceeds on stale data.
        record = undefined;
      }
    }

    const passwordHash = needsRehash ? await this.hasher.hash(password) : undefined;

    if (!record) {
      if (!passwordHash) return user;
      return this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
    }

    // A user deleted or deactivated upstream loses access at the next refresh.
    if (!record.isActive) {
      await this.provisioning.syncFromLegacy(record, undefined);
      await this.tokens.revokeAllForUser(user.id);
      throw new ForbiddenError('This account has been deactivated. Contact your administrator.');
    }

    return this.provisioning.syncFromLegacy(record, passwordHash);
  }

  private assertActive(record: LegacyUserRecord): void {
    if (!record.isActive) {
      throw new ForbiddenError('This account has been deactivated. Contact your administrator.');
    }
  }

  // --- Session lifecycle ----------------------------------------------------

  async refresh(refreshToken: string, context: TokenContext = {}): Promise<LoginResult> {
    const { tokens, user } = await this.tokens.rotate(refreshToken, context);
    return { tokens, user, provisioned: false, verifiedAgainst: 'portal' };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  async findActiveUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user || user.deletedAt || user.status !== 'ACTIVE') {
      throw new UnauthenticatedError('Account is no longer active');
    }
    return user;
  }

  /**
   * The user plus the account, site and effective permissions every session
   * response carries.
   *
   * Kept in the service rather than in the controller because login, refresh
   * and /auth/me must all describe a session the same way — a client that got
   * permissions from one of the three and not the others would silently lose
   * them the moment its access token rotated.
   */
  async describeUser(user: User): Promise<AuthenticatedUserRecord> {
    const [account, site, effective] = await Promise.all([
      this.prisma.account.findUniqueOrThrow({
        where: { id: user.accountId },
        select: { id: true, name: true, accountCode: true, poPrefix: true, requirePoNumber: true },
      }),
      user.siteId
        ? this.prisma.site.findUnique({
            where: { id: user.siteId },
            select: {
              id: true,
              code: true,
              name: true,
              poPrefix: true,
              poRequired: true,
              monthlyBudget: true,
            },
          })
        : Promise.resolve(null),
      this.permissions.resolve({
        userId: user.id,
        accountId: user.accountId,
        role: user.role,
        userType: user.userType,
      }),
    ]);

    return {
      user,
      account,
      site,
      permissions: [...effective.accountWide].sort(),
    };
  }

  /** Records the successful login. Never allowed to fail the request. */
  async markLoggedIn(userId: string): Promise<void> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record lastLoginAt for ${userId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
