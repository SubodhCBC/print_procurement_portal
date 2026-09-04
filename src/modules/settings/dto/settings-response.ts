import type { Account, AccountSettings } from '@prisma/client';

/**
 * What the settings screen reads.
 *
 * Deliberately flat, and deliberately mixes the two tables behind it: the
 * screen is one form, and which of `accounts` or `account_settings` a field
 * happens to live in is a storage detail the client should not have to model.
 */
export interface SettingsView {
  accountId: string;
  accountCode: string;
  /// Shown as the store name.
  accountName: string;

  currency: string;
  timezone: string;

  orderNumberPrefix: string | null;
  enforceMoq: boolean;
  allowBackorders: boolean;
  requireDeliveryNotes: boolean;

  requirePoNumber: boolean;
  poPrefix: string | null;
  /// A string, like every other money value here — see the money note in the
  /// reporting DTOs. Null means no order needs approval.
  approvalThreshold: string | null;

  sendOrderConfirmations: boolean;
  /// Already resolved: the account's contact address when no override is set,
  /// so the client never has to reimplement the fallback.
  notificationEmail: string | null;
  /// Whether that address is an override or the inherited account contact.
  notificationEmailInherited: boolean;
  sendLowStockAlerts: boolean;
  lowStockAlertThreshold: number;
  sendMonthlyBillingDigest: boolean;

  sessionTimeoutMinutes: number;
  /// Recorded but not enforced — there is no second-factor enrolment yet. The
  /// flag says so, rather than leaving the client to promise otherwise.
  enforceTwoFactor: boolean;
  twoFactorEnforceable: boolean;

  updatedAt: string;
}

export function toSettingsView(account: Account, settings: AccountSettings): SettingsView {
  return {
    accountId: account.id,
    accountCode: account.accountCode,
    accountName: account.name,

    currency: settings.currency,
    timezone: settings.timezone,

    orderNumberPrefix: settings.orderNumberPrefix,
    enforceMoq: settings.enforceMoq,
    allowBackorders: settings.allowBackorders,
    requireDeliveryNotes: settings.requireDeliveryNotes,

    requirePoNumber: account.requirePoNumber,
    poPrefix: account.poPrefix,
    approvalThreshold: account.approvalThreshold?.toString() ?? null,

    sendOrderConfirmations: settings.sendOrderConfirmations,
    notificationEmail: settings.notificationEmail ?? account.contactEmail,
    notificationEmailInherited: settings.notificationEmail === null,
    sendLowStockAlerts: settings.sendLowStockAlerts,
    lowStockAlertThreshold: settings.lowStockAlertThreshold,
    sendMonthlyBillingDigest: settings.sendMonthlyBillingDigest,

    sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
    enforceTwoFactor: settings.enforceTwoFactor,
    twoFactorEnforceable: false,

    updatedAt: settings.updatedAt.toISOString(),
  };
}
