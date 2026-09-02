import { z } from 'zod';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '@/common';

/**
 * A branch code as the customer writes it. Upper-cased on the way in so that
 * "vic-042" and "VIC-042" cannot both exist within one account — the unique
 * index is on the stored value, and a case-only duplicate would defeat it.
 */
const SiteCode = z
  .string()
  .trim()
  .min(1, 'Site code is required')
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, dot, dash or underscore')
  .transform((value) => value.toUpperCase());

/**
 * Money as a string, not a number.
 *
 * A budget is compared against order totals stored as NUMERIC(12,2). Parsing it
 * through a JavaScript float first would round 0.1 + 0.2 into the comparison,
 * so the value stays textual until Prisma hands it to PostgreSQL as a decimal.
 */
const Money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Expected an amount such as "1500.00"');

const AddressInput = z.object({
  kind: z.enum(['BILLING', 'SHIPPING']),
  label: z.string().trim().max(120).optional(),
  recipientName: z.string().trim().max(160).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(),
  postcode: z.string().trim().min(1).max(24),
  country: z
    .string()
    .trim()
    .length(2, 'Use the ISO 3166-1 alpha-2 country code')
    .transform((value) => value.toUpperCase()),
  phone: z.string().trim().max(40).optional(),
  isDefault: z.boolean().default(false),
});

export const CreateSiteSchema = z.object({
  /**
   * Which tenant the site belongs to. Only an ADMIN may set it; for everyone
   * else the controller overrides it with the caller's own account, so a
   * head-office user cannot create a branch inside someone else's business.
   */
  accountId: z.string().trim().max(64).optional(),
  code: SiteCode,
  name: z.string().trim().min(1, 'Site name is required').max(200),
  monthlyBudget: Money.nullish(),
  poRequired: z.boolean().default(false),
  poPrefix: z.string().trim().max(32).nullish(),
  costCentre: z.string().trim().max(64).nullish(),
  addresses: z.array(AddressInput).max(20).default([]),
});

export type CreateSiteDto = z.infer<typeof CreateSiteSchema>;

/**
 * Every field optional, and `code` deliberately absent: a branch code appears
 * on purchase orders and invoices that have already been issued, so changing it
 * is a data-migration conversation, not a PATCH.
 */
export const UpdateSiteSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    monthlyBudget: Money.nullish(),
    poRequired: z.boolean().optional(),
    poPrefix: z.string().trim().max(32).nullish(),
    costCentre: z.string().trim().max(64).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export type UpdateSiteDto = z.infer<typeof UpdateSiteSchema>;

export const ListSitesQuerySchema = z.object({
  accountId: z.string().trim().max(64).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  /** Case-insensitive match against code or name. */
  search: z.string().trim().max(120).optional(),
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
});

export type ListSitesQueryDto = z.infer<typeof ListSitesQuerySchema>;

export const AddSiteAddressSchema = AddressInput;
export type AddSiteAddressDto = z.infer<typeof AddSiteAddressSchema>;
