import { z } from 'zod';

/**
 * The customer-facing account code.
 *
 * Upper-cased on the way in for the same reason a site code is: the unique
 * index is on the stored value, so "acme" and "ACME" would otherwise both be
 * creatable and only one of them would ever be found by a search.
 */
const AccountCode = z
  .string()
  .trim()
  .min(2, 'Account code is required')
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, dot, dash or underscore')
  .transform((value) => value.toUpperCase());

/** Money as a string — see the identical note in site.dto.ts. */
const Money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Expected an amount such as "1500.00"');

export const CreateAccountSchema = z.object({
  accountCode: AccountCode,
  name: z.string().trim().min(1, 'Account name is required').max(200),
  contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  /**
   * Order total above which an order needs approval. `nullish` so omitting it
   * and sending null are different requests — see the note in UpdateAccount.
   */
  approvalThreshold: Money.nullish(),
  requirePoNumber: z.boolean().default(false),
  poPrefix: z.string().trim().max(32).nullish(),
});

export type CreateAccountDto = z.infer<typeof CreateAccountSchema>;

/**
 * `accountCode` is absent, deliberately.
 *
 * It appears on invoices and purchase orders that have already been issued, so
 * changing it is a data-migration conversation rather than a PATCH — the same
 * reasoning that keeps `code` out of UpdateSiteSchema.
 */
export const UpdateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
    contactPhone: z.string().trim().max(40).nullish(),
    // Omitted leaves the threshold alone; explicit null removes it, which means
    // "approve everything automatically". Collapsing the two would make that
    // state unreachable once a threshold had been set.
    approvalThreshold: Money.nullish(),
    requirePoNumber: z.boolean().optional(),
    poPrefix: z.string().trim().max(32).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export type UpdateAccountDto = z.infer<typeof UpdateAccountSchema>;

export const ListAccountsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  /** Case-insensitive match against name, account code or the legacy client. */
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListAccountsQueryDto = z.infer<typeof ListAccountsQuerySchema>;
