import { Role, UserType } from '../interfaces/request-context.interface';

/**
 * Every permission the platform checks.
 *
 * The names in the APPLICATION_* and DAM_* groups are taken verbatim from the
 * architecture document so that a permission discussed with the client and a
 * permission in the code are the same string. The module groups below them
 * cover the work packages in the statement of work.
 *
 * Adding a permission is safe. Renaming one is a breaking change: values are
 * persisted in `user_permission_grants.permission`, so a rename needs a data
 * migration, which is exactly why they are stored as text rather than as a
 * database enum.
 */
export const Permission = {
  // --- Application-wide -----------------------------------------------------
  APPLICATION_VIEW: 'APPLICATION_VIEW',
  APPLICATION_CREATE: 'APPLICATION_CREATE',
  APPLICATION_EDIT: 'APPLICATION_EDIT',
  APPLICATION_DELETE: 'APPLICATION_DELETE',

  // --- Document Access Management -------------------------------------------
  DAM_VIEW: 'DAM_VIEW',
  DAM_UPLOAD: 'DAM_UPLOAD',
  DAM_DOWNLOAD: 'DAM_DOWNLOAD',
  DAM_DELETE: 'DAM_DELETE',
  /// Held by external users who may reach named documents and nothing else.
  /// Always paired with a per-document grant carrying that document's id.
  EXTERNAL_DOCUMENT_ACCESS: 'EXTERNAL_DOCUMENT_ACCESS',

  // --- Catalog and pricing ---------------------------------------------------
  CATALOG_VIEW: 'CATALOG_VIEW',
  CATALOG_MANAGE: 'CATALOG_MANAGE',
  PRICING_VIEW: 'PRICING_VIEW',
  PRICING_MANAGE: 'PRICING_MANAGE',

  // --- Ordering --------------------------------------------------------------
  ORDER_CREATE: 'ORDER_CREATE',
  /// Orders the user placed themselves.
  ORDER_VIEW_OWN: 'ORDER_VIEW_OWN',
  /// Every order for the sites the user is attached to.
  ORDER_VIEW_SITE: 'ORDER_VIEW_SITE',
  /// Every order in the account, regardless of site.
  ORDER_VIEW_ACCOUNT: 'ORDER_VIEW_ACCOUNT',
  ORDER_CANCEL: 'ORDER_CANCEL',
  /// Move an order through fulfilment — into production, dispatched, delivered.
  /// The platform operator's, not the customer's: a buyer marking their own
  /// order delivered would break every delivery metric BE-10 reports on, and
  /// later these transitions come from the print producer and the 3PL rather
  /// than from a person at all.
  ORDER_MANAGE: 'ORDER_MANAGE',
  /// Approve, reject or request changes on an order awaiting a decision.
  APPROVAL_ACT: 'APPROVAL_ACT',

  // --- Templates -------------------------------------------------------------
  /// Personalise a published template and order from it.
  TEMPLATE_USE: 'TEMPLATE_USE',
  /// Create, edit and publish master templates in the builder studio.
  TEMPLATE_MANAGE: 'TEMPLATE_MANAGE',

  // --- Billing, inventory, reporting ----------------------------------------
  BILLING_VIEW: 'BILLING_VIEW',
  BILLING_MANAGE: 'BILLING_MANAGE',
  INVENTORY_VIEW: 'INVENTORY_VIEW',
  INVENTORY_MANAGE: 'INVENTORY_MANAGE',
  REPORT_VIEW: 'REPORT_VIEW',
  AUDIT_VIEW: 'AUDIT_VIEW',

  // --- Administration --------------------------------------------------------
  USER_INVITE: 'USER_INVITE',
  USER_MANAGE: 'USER_MANAGE',
  SITE_MANAGE: 'SITE_MANAGE',
  ACCOUNT_MANAGE: 'ACCOUNT_MANAGE',
  INTEGRATION_MANAGE: 'INTEGRATION_MANAGE',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * A site user: browse the catalog, personalise a template, place an order for
 * their own branch, and see what they ordered.
 */
const SITE_USER_PERMISSIONS: readonly Permission[] = [
  Permission.APPLICATION_VIEW,
  Permission.CATALOG_VIEW,
  Permission.PRICING_VIEW,
  Permission.ORDER_CREATE,
  Permission.ORDER_VIEW_OWN,
  Permission.ORDER_VIEW_SITE,
  Permission.TEMPLATE_USE,
  Permission.DAM_VIEW,
  Permission.DAM_DOWNLOAD,
];

/**
 * Head office: everything a site user can do, across every site in the account,
 * plus approvals, billing visibility and user administration within the tenant.
 *
 * Deliberately excludes CATALOG_MANAGE, PRICING_MANAGE and INTEGRATION_MANAGE:
 * the global catalog, rate cards and webhooks are the platform operator's, not
 * the customer's.
 */
const HEAD_OFFICE_PERMISSIONS: readonly Permission[] = [
  ...SITE_USER_PERMISSIONS,
  Permission.APPLICATION_CREATE,
  Permission.APPLICATION_EDIT,
  Permission.ORDER_VIEW_ACCOUNT,
  Permission.ORDER_CANCEL,
  Permission.APPROVAL_ACT,
  Permission.BILLING_VIEW,
  Permission.INVENTORY_VIEW,
  Permission.REPORT_VIEW,
  Permission.AUDIT_VIEW,
  Permission.USER_INVITE,
  Permission.USER_MANAGE,
  Permission.SITE_MANAGE,
  Permission.DAM_UPLOAD,
];

/**
 * External users — clients, vendors, partners, temporary collaborators.
 *
 * A closed list rather than a subtraction from the site-user set: least
 * privilege has to be the default for this category, and a permission added to
 * SITE_USER_PERMISSIONS later must not silently reach external users too.
 *
 * Anything beyond this is granted one row at a time in `user_permission_grants`
 * — which is what EXTERNAL_DOCUMENT_ACCESS is for.
 */
const EXTERNAL_PERMISSIONS: readonly Permission[] = [
  Permission.APPLICATION_VIEW,
  Permission.ORDER_VIEW_OWN,
  Permission.DAM_VIEW,
  Permission.EXTERNAL_DOCUMENT_ACCESS,
];

const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [Role.ADMIN]: ALL_PERMISSIONS,
  [Role.HEAD_OFFICE]: HEAD_OFFICE_PERMISSIONS,
  [Role.SITE_USER]: SITE_USER_PERMISSIONS,
};

/**
 * The permissions a user holds by virtue of who they are, before any per-user
 * grant is applied.
 *
 * `userType` overrides `role` for external users on purpose. An external
 * collaborator is invited with the SITE_USER role because that is the shape of
 * their access — one site, no administration — but they must not inherit a site
 * user's catalog and ordering rights just because the role names match. Keeping
 * them on the same role avoids a fourth role that the statement of work does
 * not have and that every downstream switch would have to learn.
 */
export function basePermissionsFor(role: Role, userType: UserType): ReadonlySet<Permission> {
  if (userType === UserType.EXTERNAL) return new Set(EXTERNAL_PERMISSIONS);
  return new Set(ROLE_PERMISSIONS[role] ?? SITE_USER_PERMISSIONS);
}

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}
