import type { AccountWithCounts } from '../accounts.service';

/**
 * An account as the API exposes it.
 *
 * Matches the reference portal's `Account` shape, with `slug` and
 * `legacyClient` added because support needs them to reconcile a portal account
 * against the legacy `Users.Client` value it came from. An explicit whitelist,
 * for the reason given in auth-response.ts.
 *
 * `approvalThreshold` is a string for the same reason a site budget is: it is a
 * NUMERIC(12,2), and a JSON number would be rounded by the client's parser.
 */
export interface AccountView {
  readonly id: string;
  readonly accountCode: string;
  readonly slug: string;
  readonly name: string;
  readonly status: AccountWithCounts['status'];
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly approvalThreshold: string | null;
  readonly requirePoNumber: boolean;
  readonly poPrefix: string | null;
  /** The raw legacy `Users.Client`; null for an account created in the portal. */
  readonly legacyClient: string | null;
  readonly sitesCount: number;
  readonly usersCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAccountView(account: AccountWithCounts): AccountView {
  return {
    id: account.id,
    accountCode: account.accountCode,
    slug: account.slug,
    name: account.name,
    status: account.status,
    contactEmail: account.contactEmail,
    contactPhone: account.contactPhone,
    approvalThreshold: account.approvalThreshold?.toFixed(2) ?? null,
    requirePoNumber: account.requirePoNumber,
    poPrefix: account.poPrefix,
    legacyClient: account.legacyClient,
    sitesCount: account._count.sites,
    usersCount: account._count.users,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}
