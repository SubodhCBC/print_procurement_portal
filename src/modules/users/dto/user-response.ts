import type { Invitation, UserPermissionGrant } from '@prisma/client';
import type { Permission, Role, UserType } from '@/common';
import type { UserWithSites } from '../users.service';

/**
 * Administrative view of a user.
 *
 * Richer than the `AuthenticatedUserView` the auth module returns for /auth/me,
 * and separate from it on purpose: that one describes "you" to a client that
 * already knows who it is, this one describes "them" to an administrator. A
 * single shared shape would have to be the union of both, and every field added
 * for the admin screen would then be published to every logged-in user.
 *
 * Both are explicit whitelists. `passwordHash` and `legacyFingerprint` exist on
 * the row and must never be serialised.
 */
export interface UserSummaryView {
  readonly id: string;
  readonly identityUserId: string;
  readonly accountId: string;
  readonly login: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  readonly role: Role;
  readonly userType: UserType;
  readonly status: UserWithSites['status'];
  readonly site: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly additionalSiteIds: readonly string[];
  readonly isHeadOfficeAdmin: boolean;
  readonly mustChangePassword: boolean;
  /** Present only for a user replicated from the legacy system. */
  readonly legacyUserId: number | null;
  readonly lastLoginAt: string | null;
  readonly activatedAt: string | null;
  readonly createdAt: string;
}

export function toUserSummaryView(user: UserWithSites): UserSummaryView {
  return {
    id: user.id,
    identityUserId: user.identityUserId,
    accountId: user.accountId,
    login: user.loginDisplay,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    role: user.role,
    userType: user.userType,
    status: user.status,
    site: user.site,
    additionalSiteIds: user.siteAccess.map((access) => access.siteId),
    isHeadOfficeAdmin: user.isHeadOfficeAdmin,
    mustChangePassword: user.mustChangePassword,
    legacyUserId: user.legacyUserId,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    activatedAt: user.activatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface PermissionGrantView {
  readonly id: string;
  readonly permission: string;
  readonly effect: UserPermissionGrant['effect'];
  readonly resourceId: string | null;
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly grantedById: string | null;
  readonly createdAt: string;
}

export function toGrantView(grant: UserPermissionGrant): PermissionGrantView {
  return {
    id: grant.id,
    permission: grant.permission,
    effect: grant.effect,
    resourceId: grant.resourceId,
    reason: grant.reason,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    grantedById: grant.grantedById,
    createdAt: grant.createdAt.toISOString(),
  };
}

/**
 * An invitation as the API exposes it.
 *
 * `tokenHash` is absent, and so is anything derived from it. The token is shown
 * exactly once, in the email; there is deliberately no endpoint that can read
 * it back, because an administrator who can retrieve a live invitation token
 * can take over the invited account.
 */
export interface InvitationView {
  readonly id: string;
  readonly accountId: string;
  readonly siteId: string | null;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: Role;
  readonly userType: UserType;
  readonly status: Invitation['status'];
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly invitedById: string | null;
  readonly createdAt: string;
}

export function toInvitationView(invitation: Invitation): InvitationView {
  return {
    id: invitation.id,
    accountId: invitation.accountId,
    siteId: invitation.siteId,
    email: invitation.email,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
    role: invitation.role,
    userType: invitation.userType,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
    invitedById: invitation.invitedById,
    createdAt: invitation.createdAt.toISOString(),
  };
}

/** The permissions the caller actually holds, for /users/me/permissions. */
export interface EffectivePermissionsView {
  readonly userId: string;
  readonly role: Role;
  readonly userType: UserType;
  readonly permissions: readonly Permission[];
}
