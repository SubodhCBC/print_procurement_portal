import { Injectable } from '@nestjs/common';
import {
  basePermissionsFor,
  getRequestContext,
  isPermission,
  type AuthenticatedActor,
  type Permission,
  type RequestContext,
  type Role,
  type UserType,
} from '@/common';
import { PrismaService } from '@/database';

/**
 * The parts of an actor that decide their permissions.
 *
 * Narrower than AuthenticatedActor on purpose: the login and refresh responses
 * have to report a user's permissions before any access token exists, so there
 * is no session id or bearer identity to hand over yet. Everything the
 * resolution below actually reads is here.
 */
export interface PermissionSubject {
  readonly userId: string;
  readonly accountId: string;
  readonly role: Role;
  readonly userType: UserType;
}

/**
 * What a user may actually do, once their per-user grants have been applied on
 * top of the role baseline.
 */
export interface EffectivePermissions {
  /** Holds this permission everywhere it is checked. */
  has(permission: Permission): boolean;
  /**
   * Holds this permission for one specific object — a DAM document, a site.
   *
   * An account-wide grant satisfies a resource check, so a head-office user who
   * holds DAM_DOWNLOAD outright does not need a row per document. The reverse
   * is not true: a grant naming a resource says nothing about any other.
   */
  hasOn(permission: Permission, resourceId: string): boolean;
  /** Everything held account-wide. For /auth/me and for debugging. */
  readonly accountWide: ReadonlySet<Permission>;
}

/**
 * Resolved once per request and reused.
 *
 * Keyed on the RequestContext object rather than on a user id so the entry
 * dies with the request, and so two requests from the same user never share a
 * snapshot — a grant revoked mid-flight must not stay live because an earlier
 * request cached it. A WeakMap because nothing here should keep a finished
 * request alive.
 */
const perRequestCache = new WeakMap<RequestContext, Promise<EffectivePermissions>>();

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The actor's effective permissions.
   *
   * One indexed query per request, and only for requests that actually check a
   * permission — a route guarded by role alone never reaches here. Most users
   * have no grant rows at all, so this is usually an empty result on a covering
   * index; if it ever stops being cheap, the natural next step is a short-lived
   * Redis entry keyed by user id and invalidated on grant writes.
   */
  async resolve(actor: PermissionSubject): Promise<EffectivePermissions> {
    const context = getRequestContext();
    if (!context) return this.load(actor);

    const cached = perRequestCache.get(context);
    if (cached) return cached;

    const pending = this.load(actor);
    perRequestCache.set(context, pending);
    return pending;
  }

  private async load(actor: PermissionSubject): Promise<EffectivePermissions> {
    const base = new Set(basePermissionsFor(actor.role, actor.userType));

    const rows = await this.prisma.userPermissionGrant.findMany({
      where: {
        userId: actor.userId,
        // Redundant next to userId, and deliberately so: application-level
        // tenant scoping is the first line of defence, and a grant row that
        // somehow pointed at another account must not be honoured.
        accountId: actor.accountId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { permission: true, effect: true, resourceId: true },
    });

    const accountWideDenies = new Set<Permission>();
    const allowOn = new Map<Permission, Set<string>>();
    const denyOn = new Map<Permission, Set<string>>();

    for (const row of rows) {
      // A grant naming a permission this build no longer knows about is
      // ignored rather than trusted. Renaming a permission leaves exactly this
      // kind of orphan behind, and the safe reading of an unknown grant is "no".
      if (!isPermission(row.permission)) continue;
      const permission = row.permission;

      if (row.resourceId === null) {
        if (row.effect === 'DENY') accountWideDenies.add(permission);
        else base.add(permission);
        continue;
      }

      const target = row.effect === 'DENY' ? denyOn : allowOn;
      const existing = target.get(permission);
      if (existing) existing.add(row.resourceId);
      else target.set(permission, new Set([row.resourceId]));
    }

    // Applied last so DENY always beats ALLOW, whatever order the rows arrived
    // in. A revocation that could be defeated by row ordering is not one.
    for (const permission of accountWideDenies) base.delete(permission);

    return {
      accountWide: base,
      has: (permission) => base.has(permission),
      hasOn: (permission, resourceId) => {
        if (denyOn.get(permission)?.has(resourceId)) return false;
        if (allowOn.get(permission)?.has(resourceId)) return true;
        return base.has(permission);
      },
    };
  }

  /** Convenience for service-layer checks on a specific object. */
  async can(
    actor: AuthenticatedActor,
    permission: Permission,
    resourceId?: string,
  ): Promise<boolean> {
    const effective = await this.resolve(actor);
    return resourceId === undefined
      ? effective.has(permission)
      : effective.hasOn(permission, resourceId);
  }
}
