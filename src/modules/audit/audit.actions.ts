/**
 * The vocabulary of the audit log.
 *
 * Values are `entity.past_tense_verb`, and they are an API: dashboards filter
 * on them, alerts match on them, and rows already written keep whatever string
 * they were written with. Adding an action is safe. Renaming one orphans every
 * historical entry that used the old name, so treat it the way a permission
 * rename is treated.
 */
export const AuditAction = {
  // --- Accounts -------------------------------------------------------------
  ACCOUNT_CREATED: 'account.created',
  ACCOUNT_UPDATED: 'account.updated',
  ACCOUNT_STATUS_CHANGED: 'account.status_changed',
  ACCOUNT_DEACTIVATED: 'account.deactivated',
  ACCOUNT_SETTINGS_UPDATED: 'account.settings_updated',

  // --- Sites ----------------------------------------------------------------
  SITE_CREATED: 'site.created',
  SITE_UPDATED: 'site.updated',
  SITE_DEACTIVATED: 'site.deactivated',
  SITE_ADDRESS_ADDED: 'site.address_added',

  // --- Users ----------------------------------------------------------------
  USER_UPDATED: 'user.updated',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_DEACTIVATED: 'user.deactivated',
  USER_PROVISIONED_FROM_LEGACY: 'user.provisioned_from_legacy',
  USER_PERMISSION_GRANTED: 'user.permission_granted',
  USER_PERMISSION_REVOKED: 'user.permission_revoked',

  // --- Invitations ----------------------------------------------------------
  INVITATION_SENT: 'invitation.sent',
  INVITATION_REVOKED: 'invitation.revoked',
  INVITATION_ACCEPTED: 'invitation.accepted',

  // --- Catalog --------------------------------------------------------------
  CATEGORY_CREATED: 'category.created',
  CATEGORY_UPDATED: 'category.updated',
  CATEGORY_DEACTIVATED: 'category.deactivated',

  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_STATUS_CHANGED: 'product.status_changed',
  PRODUCT_DELETED: 'product.deleted',
  PRODUCT_OPTIONS_SET: 'product.options_set',
  PRODUCT_VARIANT_CREATED: 'product.variant_created',
  PRODUCT_VARIANT_UPDATED: 'product.variant_updated',
  PRODUCT_VARIANT_DELETED: 'product.variant_deleted',
  PRODUCT_TIERS_SET: 'product.volume_tiers_set',
  PRODUCT_VISIBILITY_SET: 'product.visibility_set',
  PRODUCT_ASSET_ATTACHED: 'product.asset_attached',
  PRODUCT_ASSET_REMOVED: 'product.asset_removed',
  PRODUCT_STOCK_ADJUSTED: 'product.stock_adjusted',
  PRODUCT_STOCK_RECONCILED: 'product.stock_reconciled',
  PRODUCT_IMPORTED: 'product.imported',

  // --- Rate cards -----------------------------------------------------------
  RATE_CARD_CREATED: 'rate_card.created',
  RATE_CARD_UPDATED: 'rate_card.updated',
  RATE_CARD_STATUS_CHANGED: 'rate_card.status_changed',
  RATE_CARD_ITEMS_SET: 'rate_card.items_set',
  RATE_CARD_ITEM_REMOVED: 'rate_card.item_removed',
  RATE_CARD_DELETED: 'rate_card.deleted',

  // --- Orders ---------------------------------------------------------------
  ORDER_PLACED: 'order.placed',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_PAYMENT_RECORDED: 'order.payment_recorded',

  // --- Approvals ------------------------------------------------------------
  APPROVAL_DECIDED: 'approval.decided',
  APPROVAL_RULE_CREATED: 'approval_rule.created',
  APPROVAL_RULE_UPDATED: 'approval_rule.updated',
  APPROVAL_RULE_DELETED: 'approval_rule.deleted',

  // --- Billing --------------------------------------------------------------
  INVOICE_GENERATED: 'invoice.generated',
  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_VOIDED: 'invoice.voided',

  // --- Credentials ----------------------------------------------------------
  PASSWORD_RESET_REQUESTED: 'password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'password.reset_completed',
  /// Changed deliberately by a signed-in user, as opposed to recovered by a
  /// reset token. Worth telling apart in the trail: one is routine hygiene,
  /// the other is the tail end of "I lost my password".
  PASSWORD_CHANGED: 'password.changed',
  // --- Templates ------------------------------------------------------------
  TEMPLATE_CREATED: 'template.created',
  TEMPLATE_UPDATED: 'template.updated',
  TEMPLATE_STATUS_CHANGED: 'template.status_changed',
  TEMPLATE_PUBLISHED: 'template.published',
  TEMPLATE_VERSION_RESTORED: 'template.version_restored',
  TEMPLATE_DUPLICATED: 'template.duplicated',
  TEMPLATE_DELETED: 'template.deleted',
  TEMPLATE_VISIBILITY_SET: 'template.visibility_set',
  TEMPLATE_ASSET_ATTACHED: 'template.asset_attached',
  TEMPLATE_ASSET_REMOVED: 'template.asset_removed',

  // --- Document library (DAM) -----------------------------------------------
  /// Reads are logged as well as writes. A DAM holds documents whose *reading*
  /// is the sensitive act, and "who took the artwork" is unanswerable after the
  /// fact if only uploads were recorded.
  DAM_DOCUMENTS_LISTED: 'dam.documents_listed',
  DAM_DOCUMENT_VIEWED: 'dam.document_viewed',
  DAM_DOCUMENT_DOWNLOADED: 'dam.document_downloaded',
  DAM_DOCUMENT_UPLOADED: 'dam.document_uploaded',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Field names whose values are never written to the audit log, whatever they
 * are nested under.
 *
 * The log records *what changed*, and for these it records only that they
 * changed. An audit trail that captured a password hash or a live invitation
 * token would turn the compliance feature into the breach: audit rows are read
 * by more people, kept far longer, and exported more often than the tables they
 * describe.
 */
export const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'token',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'secret',
  'apiKey',
  'hmacSecret',
  'authorization',
  'cookie',
  'presignedUrl',
  'signedUrl',
]);

export const REDACTED_PLACEHOLDER = '[redacted]';
