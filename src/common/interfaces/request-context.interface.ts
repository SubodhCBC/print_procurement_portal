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

export interface AuthenticatedActor {
  readonly userId: string;
  readonly accountId: string;
  /** Absent for ADMIN and account-wide HEAD_OFFICE users. */
  readonly siteId?: string;
  readonly role: Role;
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
