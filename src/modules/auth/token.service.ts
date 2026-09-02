import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import { createId, createSecretToken, Role, UnauthenticatedError, type UserType } from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';
import { PrismaService } from '@/database';

/** Claims carried in the access token. Kept small — it travels on every request. */
export interface AccessTokenClaims {
  /** The portal user id (`usr_…`), not the legacy integer id. */
  readonly sub: string;
  readonly accountId: string;
  /** The user's primary site, absent for ADMIN and account-wide HEAD_OFFICE. */
  readonly siteId?: string;
  readonly role: Role;
  /** Needed alongside `role` to derive the permission baseline. */
  readonly userType: UserType;
  readonly email: string;
  /** Ties the access token to the refresh-token family it was minted from. */
  readonly sid: string;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export interface TokenContext {
  readonly ip?: string;
  readonly userAgent?: string;
}

/** `15m`, `900s`, `30d` — already validated by the env schema. */
function durationToSeconds(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration);
  if (!match) throw new Error(`Unparseable duration: ${duration}`);

  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400 };
  return Math.floor(value * (multipliers[unit as keyof typeof multipliers] ?? 1));
}

/**
 * Issues and rotates the token pair.
 *
 * Access tokens are stateless JWTs, short-lived, and never checked against the
 * database — that is the whole point of them. Refresh tokens are opaque random
 * strings stored as SHA-256 digests, so they can be revoked and so a dump of
 * `refresh_tokens` cannot be replayed. A refresh JWT would be neither.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** SHA-256, not Argon2: the token is 256 bits of entropy we generated
   *  ourselves, so it is not brute-forceable and needs no slow hash. */
  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(user: User, context: TokenContext = {}): Promise<IssuedTokens> {
    const sessionId = createId('ses');
    return this.mint(user, sessionId, context);
  }

  private async mint(
    user: User,
    sessionId: string,
    context: TokenContext,
    rotatedFrom?: string,
  ): Promise<IssuedTokens> {
    const accessTtl = durationToSeconds(this.config.auth.accessTtl);
    const refreshTtl = durationToSeconds(this.config.auth.refreshTtl);

    const claims: AccessTokenClaims = {
      sub: user.id,
      accountId: user.accountId,
      // Omitted rather than sent as null so the token stays small and the
      // claim's absence is the single meaning of "no primary site".
      ...(user.siteId ? { siteId: user.siteId } : {}),
      role: user.role,
      userType: user.userType,
      email: user.email,
      sid: sessionId,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.auth.accessSecret,
      expiresIn: accessTtl,
    });

    const refreshToken = createSecretToken(32);
    const id = createId('rft');

    await this.prisma.refreshToken.create({
      data: {
        id,
        userId: user.id,
        tokenHash: this.digest(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
    });

    if (rotatedFrom) {
      await this.prisma.refreshToken.update({
        where: { id: rotatedFrom },
        data: { revokedAt: new Date(), rotatedToId: id },
      });
    }

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.auth.accessSecret,
      });
    } catch {
      throw new UnauthenticatedError('Access token is invalid or has expired');
    }
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * Reuse detection: presenting a token that has already been rotated means two
   * parties hold it, so the entire session is revoked rather than just refusing
   * this one call. Without that, a stolen token stays usable until it expires,
   * because the thief simply keeps rotating it.
   */
  async rotate(
    refreshToken: string,
    context: TokenContext = {},
  ): Promise<{ tokens: IssuedTokens; user: User }> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.digest(refreshToken) },
      include: { user: true },
    });

    if (!existing) throw new UnauthenticatedError('Refresh token is not recognised');

    if (existing.revokedAt) {
      this.logger.warn(
        `Refresh token reuse detected for user ${existing.userId} — revoking all sessions.`,
      );
      await this.revokeAllForUser(existing.userId);
      throw new UnauthenticatedError('Refresh token has already been used');
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError('Refresh token has expired');
    }

    // PENDING counts as not active: an invitation that was issued but never
    // accepted must not be refreshable into a live session.
    if (existing.user.status !== 'ACTIVE' || existing.user.deletedAt) {
      await this.revokeAllForUser(existing.userId);
      throw new UnauthenticatedError('Account is no longer active');
    }

    const tokens = await this.mint(existing.user, createId('ses'), context, existing.id);
    return { tokens, user: existing.user };
  }

  /** Logout. Idempotent: an unknown or already-revoked token is not an error. */
  async revoke(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.digest(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
