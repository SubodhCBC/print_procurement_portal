import type { User } from '@prisma/client';
import type { Role } from '@/common';
import type { IssuedTokens } from '../token.service';

/**
 * The user as the API exposes them.
 *
 * Built by an explicit whitelist rather than by spreading the row and deleting
 * fields: a column added to the model later — a password hash, an internal
 * flag — must not appear in an API response because someone forgot to exclude
 * it. Adding a field here is a deliberate act.
 */
export interface AuthenticatedUserView {
  readonly id: string;
  readonly login: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: Role;
  readonly accountId: string;
  readonly mustChangePassword: boolean;
  readonly isHeadOfficeAdmin: boolean;
  readonly lastLoginAt: string | null;
}

export interface LoginResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly user: AuthenticatedUserView;
}

export function toUserView(user: User): AuthenticatedUserView {
  return {
    id: user.id,
    login: user.loginDisplay,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    accountId: user.accountId,
    mustChangePassword: user.mustChangePassword,
    isHeadOfficeAdmin: user.isHeadOfficeAdmin,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

export function toLoginResponse(tokens: IssuedTokens, user: User): LoginResponse {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: 'Bearer',
    expiresIn: tokens.expiresIn,
    user: toUserView(user),
  };
}
