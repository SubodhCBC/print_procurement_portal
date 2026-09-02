/**
 * The three portals in the platform. Kept here rather than in a domain module
 * because the request context, guards and logger all need it before any
 * feature module is loaded.
 */
export const Role = {
  ADMIN: 'ADMIN',
  HEAD_OFFICE: 'HEAD_OFFICE',
  SITE_USER: 'SITE_USER',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/**
 * Where a user came from. Mirrors the Prisma `UserType` enum.
 *
 * Kept beside `Role` rather than in the authorization module because the two
 * are read together everywhere: an external user's effective permissions are
 * decided by both, so neither is usable without the other.
 */
export const UserType = {
  EXISTING: 'EXISTING',
  NEW: 'NEW',
  EXTERNAL: 'EXTERNAL',
} as const;

export type UserType = (typeof UserType)[keyof typeof UserType];

export interface AuthenticatedActor {
  readonly userId: string;
  readonly accountId: string;
  /** Absent for ADMIN and account-wide HEAD_OFFICE users. */
  readonly siteId?: string;
  readonly role: Role;
  /** Decides the permission baseline together with `role` — external users
   *  never inherit a site user's rights. See basePermissionsFor(). */
  readonly userType: UserType;
  readonly email: string;
  readonly sessionId: string;
}

/**
 * Ambient per-request state carried in AsyncLocalStorage. Anything that needs
 * the tenant — the Prisma extension, the audit logger, the structured logger —
 * reads it from here instead of threading it through every call signature.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Undefined on public routes (login, health, inbound webhooks). */
  readonly actor?: AuthenticatedActor;
  /**
   * Set only when an ADMIN deliberately steps outside tenant scoping.
   * Every such request is written to the audit log.
   */
  readonly tenantScopeBypass?: boolean;
}
