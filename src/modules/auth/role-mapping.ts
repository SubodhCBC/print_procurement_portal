import { Role } from '@/common';

/**
 * The role names present in `webpages_Roles`. All four, verified against the
 * live database — there are exactly four rows and every user holds exactly one.
 */
export const LEGACY_ROLE_NAMES = ['Admin', 'HeadOffice', 'RegionalManager', 'Franchisee'] as const;

export type LegacyRoleName = (typeof LEGACY_ROLE_NAMES)[number];

/**
 * Legacy role -> portal role.
 *
 * The mapping is lossy on purpose: the legacy system distinguishes
 * RegionalManager from HeadOffice, the portal does not yet. Both land on
 * HEAD_OFFICE because a regional manager's job — ordering and approving across
 * more than one site — is the head-office capability, not the site-user one.
 * The original name is preserved on `User.legacyRoleName`, so the distinction
 * is recoverable when the portal grows a role of its own for it.
 */
const ROLE_BY_LEGACY_NAME: Readonly<Record<string, Role>> = {
  admin: Role.ADMIN,
  headoffice: Role.HEAD_OFFICE,
  regionalmanager: Role.HEAD_OFFICE,
  franchisee: Role.SITE_USER,
};

/**
 * Maps a legacy role name onto a portal role.
 *
 * Unknown and missing names fall to SITE_USER, the least privileged role — 30
 * of the 4432 legacy users hold no role row at all, and a role added upstream
 * after this code shipped must never be silently granted more access than the
 * roles we know about. Escalation is a deliberate act, not a default.
 */
export function mapLegacyRole(legacyRoleName: string | null | undefined): Role {
  if (!legacyRoleName) return Role.SITE_USER;
  return ROLE_BY_LEGACY_NAME[legacyRoleName.trim().toLowerCase()] ?? Role.SITE_USER;
}

/**
 * Turns `Users.Client` ("Cellarbrations", "The Bottle-O") into an account slug.
 *
 * The column is free text with inconsistent casing and punctuation across the
 * 214 distinct values, and it is the only tenant discriminator the legacy
 * schema has, so it is normalised before being used as a key.
 */
export function toAccountSlug(legacyClient: string): string {
  const slug = legacyClient
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // A client whose name normalises to nothing would otherwise collide with
  // every other such client in a single empty-slug account.
  return slug.length > 0 ? slug : 'unknown';
}
