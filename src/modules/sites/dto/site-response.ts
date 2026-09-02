import type { Address } from '@prisma/client';
import type { SiteWithAddresses } from '../sites.service';

/**
 * The API's view of a branch.
 *
 * An explicit whitelist, for the same reason auth-response.ts uses one: a
 * column added to the model later must not reach a client because nobody
 * remembered to exclude it. `monthlyBudget` is serialised as a string because
 * it is a NUMERIC(12,2) — turning it into a JSON number would round it in the
 * client's parser, which is precisely what the decimal type exists to prevent.
 */
export interface AddressView {
  readonly id: string;
  readonly kind: Address['kind'];
  readonly label: string | null;
  readonly recipientName: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postcode: string;
  readonly country: string;
  readonly phone: string | null;
  readonly isDefault: boolean;
}

export interface SiteView {
  readonly id: string;
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly status: SiteWithAddresses['status'];
  readonly monthlyBudget: string | null;
  readonly poRequired: boolean;
  readonly poPrefix: string | null;
  readonly costCentre: string | null;
  readonly legacyOutletId: number | null;
  readonly addresses: readonly AddressView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAddressView(address: Address): AddressView {
  return {
    id: address.id,
    kind: address.kind,
    label: address.label,
    recipientName: address.recipientName,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postcode: address.postcode,
    country: address.country,
    phone: address.phone,
    isDefault: address.isDefault,
  };
}

export function toSiteView(site: SiteWithAddresses): SiteView {
  return {
    id: site.id,
    accountId: site.accountId,
    code: site.code,
    name: site.name,
    status: site.status,
    monthlyBudget: site.monthlyBudget?.toFixed(2) ?? null,
    poRequired: site.poRequired,
    poPrefix: site.poPrefix,
    costCentre: site.costCentre,
    legacyOutletId: site.legacyOutletId,
    addresses: site.addresses.map(toAddressView),
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}
