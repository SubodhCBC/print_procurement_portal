import type { Account, Prisma, Site, User } from '@prisma/client';
import type { Permission, Role, UserType } from '@/common';
import type { IssuedTokens } from '../token.service';

/**
 * The user row together with the two rows the portal always renders beside it.
 *
 * Loaded in one query rather than fetched by the client afterwards: every
 * screen shows the account name and the branch a user is ordering for, so a
 * session that reported only ids would force a second round trip before the
 * first frame could be drawn.
 */
export interface AuthenticatedUserRecord {
  readonly user: User;
  readonly account: Pick<Account, 'id' | 'name' | 'accountCode' | 'poPrefix' | 'requirePoNumber'>;
  readonly site: Pick<
    Site,
    'id' | 'code' | 'name' | 'poPrefix' | 'poRequired' | 'monthlyBudget'
  > | null;
  /** Account-wide effective permissions — the role baseline plus per-user grants. */
  readonly permissions: readonly Permission[];
}

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
  /** `firstName lastName`, falling back to the login when both are blank. */
  readonly fullName: string;
  readonly role: Role;
  readonly userType: UserType;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountCode: string;
  /** Null for ADMIN and for account-wide HEAD_OFFICE users. */
  readonly siteId: string | null;
  readonly siteCode: string | null;
  readonly siteName: string | null;
  readonly phone: string | null;
  readonly department: string | null;
  /** The user's own ceiling, else the site's, else null for uncapped. */
  readonly monthlyBudgetCap: number | null;
  /** The user's override, else the site's, else the account default. */
  readonly poPrefix: string | null;
  readonly poRequired: boolean;
  readonly mustChangePassword: boolean;
  readonly isHeadOfficeAdmin: boolean;
  readonly lastLoginAt: string | null;
  /**
   * What this user may do, so the client can hide what it must not offer.
   * Advisory only — every route re-checks server side.
   */
  readonly permissions: readonly Permission[];
}

export interface LoginResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly user: AuthenticatedUserView;
}

export function toUserView(record: AuthenticatedUserRecord): AuthenticatedUserView {
  const { user, account, site, permissions } = record;

  const fullName = `${user.firstName} ${user.lastName}`.trim();

  return {
    id: user.id,
    login: user.loginDisplay,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: fullName.length > 0 ? fullName : user.loginDisplay,
    role: user.role,
    userType: user.userType,
    accountId: user.accountId,
    accountName: account.name,
    accountCode: account.accountCode,
    siteId: site?.id ?? null,
    siteCode: site?.code ?? null,
    siteName: site?.name ?? null,
    phone: user.phone,
    department: user.department,
    // The user's own cap wins when set — see the schema note on User.
    // monthlyBudgetCap: a branch budget is not a per-buyer limit.
    monthlyBudgetCap: toNumber(user.monthlyBudgetCap) ?? toNumber(site?.monthlyBudget),
    // Most specific wins: user override, then the site's contractual prefix,
    // then the account default.
    poPrefix: user.poPrefix ?? site?.poPrefix ?? account.poPrefix ?? null,
    poRequired: site?.poRequired ?? account.requirePoNumber,
    mustChangePassword: user.mustChangePassword,
    isHeadOfficeAdmin: user.isHeadOfficeAdmin,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    permissions,
  };
}

export function toLoginResponse(
  tokens: IssuedTokens,
  record: AuthenticatedUserRecord,
): LoginResponse {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: 'Bearer',
    expiresIn: tokens.expiresIn,
    user: toUserView(record),
  };
}

/**
 * Prisma returns `Decimal` for money columns. JSON.stringify would emit it as
 * an object, so it is converted here rather than left for the serialiser to
 * mangle into `{"s":1,"e":3,"d":[8500]}`.
 */
function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = value.toNumber();
  return Number.isFinite(parsed) ? parsed : null;
}
