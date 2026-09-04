import { Injectable, Logger } from '@nestjs/common';
import type { Account, AccountSettings, Prisma } from '@prisma/client';
import { createId, NotFoundError } from '@/common';
import { PrismaService, withTenantScope } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import type { UpdateSettingsDto } from './dto/settings.dto';

export interface AccountWithSettings {
  account: Account;
  settings: AccountSettings;
}

/**
 * An account's operational preferences.
 *
 * The screen behind this is one form over two tables. `accounts` already owned
 * the purchase-order rule, the approval threshold and the customer-facing name
 * long before there was a settings page, and moving them would have broken
 * every reader; the rest lives in `account_settings`. Both are written in one
 * transaction so a half-saved form cannot leave the two disagreeing.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read the settings, creating the row the first time anyone asks.
   *
   * Upserting on read rather than seeding on account creation means accounts
   * that predate this table behave identically to new ones, with no backfill
   * migration to keep in step with the defaults declared in the schema.
   */
  async forAccount(accountId: string): Promise<AccountWithSettings> {
    return withTenantScope(this.prisma, accountId, async (tx) => {
      const account = await tx.account.findFirst({ where: { id: accountId, deletedAt: null } });
      if (!account) throw new NotFoundError('Account not found');

      const settings = await tx.accountSettings.upsert({
        where: { accountId },
        create: { id: createId('ast'), accountId },
        update: {},
      });

      return { account, settings };
    });
  }

  async update(
    accountId: string,
    dto: UpdateSettingsDto,
    actorLabel: string,
  ): Promise<AccountWithSettings> {
    const before = await this.forAccount(accountId);

    const accountData: Prisma.AccountUpdateInput = {};
    if (dto.accountName !== undefined) accountData.name = dto.accountName;
    if (dto.requirePoNumber !== undefined) accountData.requirePoNumber = dto.requirePoNumber;
    if (dto.poPrefix !== undefined) accountData.poPrefix = emptyToNull(dto.poPrefix);
    if (dto.approvalThreshold !== undefined) accountData.approvalThreshold = dto.approvalThreshold;

    const settingsData: Prisma.AccountSettingsUpdateInput = {};
    assign(settingsData, 'currency', dto.currency);
    assign(settingsData, 'timezone', dto.timezone);
    assign(settingsData, 'enforceMoq', dto.enforceMoq);
    assign(settingsData, 'allowBackorders', dto.allowBackorders);
    assign(settingsData, 'requireDeliveryNotes', dto.requireDeliveryNotes);
    assign(settingsData, 'sendOrderConfirmations', dto.sendOrderConfirmations);
    assign(settingsData, 'sendLowStockAlerts', dto.sendLowStockAlerts);
    assign(settingsData, 'lowStockAlertThreshold', dto.lowStockAlertThreshold);
    assign(settingsData, 'sendMonthlyBillingDigest', dto.sendMonthlyBillingDigest);
    assign(settingsData, 'sessionTimeoutMinutes', dto.sessionTimeoutMinutes);
    assign(settingsData, 'enforceTwoFactor', dto.enforceTwoFactor);
    if (dto.orderNumberPrefix !== undefined)
      settingsData.orderNumberPrefix = emptyToNull(dto.orderNumberPrefix);
    if (dto.notificationEmail !== undefined)
      settingsData.notificationEmail = emptyToNull(dto.notificationEmail);

    const after = await withTenantScope(this.prisma, accountId, async (tx) => {
      // One transaction: the approval threshold and the ordering rules are read
      // together on every checkout, and a form that saved one but not the other
      // would leave orders being judged against a rule nobody chose.
      const account =
        Object.keys(accountData).length > 0
          ? await tx.account.update({ where: { id: accountId }, data: accountData })
          : before.account;

      const settings =
        Object.keys(settingsData).length > 0
          ? await tx.accountSettings.update({ where: { accountId }, data: settingsData })
          : before.settings;

      return { account, settings };
    });

    const changed = diff(before, after);
    if (Object.keys(changed).length > 0) {
      await this.audit.record({
        action: AuditAction.ACCOUNT_SETTINGS_UPDATED,
        entityType: 'ACCOUNT',
        entityId: accountId,
        entityName: after.account.name,
        accountId,
        // The fields that moved and what they moved to — an audit line reading
        // only "settings updated" cannot answer who turned approvals off.
        details: changed,
      });
      this.logger.log(
        `Settings updated for account ${accountId} by ${actorLabel}: ${Object.keys(changed).join(', ')}.`,
      );
    }

    return after;
  }
}

/** Copy a value across only when the caller actually sent it. */
function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) target[key] = value;
}

/** A cleared text input arrives as '' and means "unset", not "the empty string". */
function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Only the fields that actually moved, as `{ field: { from, to } }`. */
function diff(before: AccountWithSettings, after: AccountWithSettings) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const compare = (source: 'account' | 'settings', keys: string[]) => {
    for (const key of keys) {
      const a = (before[source] as Record<string, unknown>)[key];
      const b = (after[source] as Record<string, unknown>)[key];
      if (normalise(a) !== normalise(b)) out[key] = { from: normalise(a), to: normalise(b) };
    }
  };
  compare('account', ['name', 'requirePoNumber', 'poPrefix', 'approvalThreshold']);
  compare('settings', [
    'currency',
    'timezone',
    'orderNumberPrefix',
    'enforceMoq',
    'allowBackorders',
    'requireDeliveryNotes',
    'sendOrderConfirmations',
    'notificationEmail',
    'sendLowStockAlerts',
    'lowStockAlertThreshold',
    'sendMonthlyBillingDigest',
    'sessionTimeoutMinutes',
    'enforceTwoFactor',
  ]);
  return out;
}

/**
 * A settings value as a comparable string.
 *
 * Prisma hands back a `Decimal` for the approval threshold, which compares by
 * identity, so two equal thresholds would otherwise read as a change on every
 * save. Everything else here is a string, boolean or number.
 */
function normalise(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Prisma.Decimal, and anything else that knows its own text form.
  return (value as { toString(): string }).toString();
}
