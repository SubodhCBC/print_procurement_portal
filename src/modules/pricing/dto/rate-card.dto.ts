import { z } from 'zod';

/**
 * Money as a string, and percentages as strings too — both are NUMERIC columns
 * and a JSON number would be rounded by the client's parser on the way in.
 * The same rule as product.dto.ts and account.dto.ts.
 */
const Money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Expected an amount such as "12.50"');

/** 0–100 with at most two decimals, to match NUMERIC(5,2). */
const Percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Expected a percentage such as "15" or "17.24"')
  .refine((value) => Number(value) <= 100, 'A discount cannot exceed 100%');

const RateCardStatus = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);

/**
 * A contract's own volume ladder for one product.
 *
 * Percentages rather than unit prices, for the same reason the catalogue ladder
 * is: a base price change has to carry through the whole ladder instead of
 * leaving stale absolute numbers behind.
 */
export const RateCardTierSchema = z.object({
  minQuantity: z.coerce.number().int().min(1).max(10_000_000),
  discountPercent: Percent,
});

/**
 * One product's terms.
 *
 * `fixedPrice` and `discountPercent` are mutually exclusive — see the refine
 * below and the matching CHECK constraint in the migration. Tiers are refused
 * alongside a fixed price because a fixed price ignores every ladder, and
 * accepting rows that can never apply would leave the admin screen showing a
 * negotiated break that the quote does not honour.
 */
export const RateCardItemSchema = z
  .object({
    productId: z.string().trim().min(1, 'A product is required').max(64),
    fixedPrice: Money.nullish(),
    discountPercent: Percent.nullish(),
    tiers: z.array(RateCardTierSchema).max(20).default([]),
  })
  .refine(
    (value) => !(value.fixedPrice != null && value.discountPercent != null),
    'Set either a fixed price or a discount percentage, not both',
  )
  .refine(
    (value) => !(value.fixedPrice != null && value.tiers.length > 0),
    'A fixed contract price applies at every quantity, so it cannot carry volume tiers',
  )
  .refine(
    (value) => new Set(value.tiers.map((tier) => tier.minQuantity)).size === value.tiers.length,
    'Two tiers cannot start at the same quantity',
  );

export type RateCardItemDto = z.infer<typeof RateCardItemSchema>;

const rateCardFields = {
  name: z.string().trim().min(1, 'A rate card name is required').max(200),
  notes: z.string().trim().max(4000).nullish(),
  /**
   * Coerced from an ISO string. `effectiveTo` is exclusive, so a card ending on
   * the 1st and one starting on the 1st are never both in force — the same
   * bound the EXCLUDE constraint uses.
   */
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullish(),
  defaultDiscountPercent: Percent.default('0'),
};

/**
 * A card is always created as DRAFT.
 *
 * Activation is a separate, audited transition, because it is the moment the
 * card starts deciding what a customer pays — and because it is the write the
 * overlap constraint has to arbitrate. Letting `create` set ACTIVE would hide
 * that behind an ordinary POST.
 */
export const CreateRateCardSchema = z
  .object({
    accountId: z.string().trim().min(1, 'An account is required').max(64),
    ...rateCardFields,
    items: z.array(RateCardItemSchema).max(2_000).default([]),
  })
  .refine(
    (value) => value.effectiveTo == null || value.effectiveTo > value.effectiveFrom,
    'The card must end after it starts',
  );

export type CreateRateCardDto = z.infer<typeof CreateRateCardSchema>;

/**
 * `accountId` is absent, deliberately: moving a signed contract to a different
 * customer is not a PATCH. Archive it and write a new one.
 */
export const UpdateRateCardSchema = z
  .object({
    name: rateCardFields.name.optional(),
    notes: rateCardFields.notes,
    effectiveFrom: rateCardFields.effectiveFrom.optional(),
    effectiveTo: rateCardFields.effectiveTo,
    defaultDiscountPercent: Percent.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export type UpdateRateCardDto = z.infer<typeof UpdateRateCardSchema>;

export const ChangeRateCardStatusSchema = z.object({
  status: RateCardStatus,
  /** Recorded on the audit entry — "renegotiated", "expired", "signed 12 Jan". */
  reason: z.string().trim().max(500).optional(),
});

export type ChangeRateCardStatusDto = z.infer<typeof ChangeRateCardStatusSchema>;

/**
 * Bulk item editor. Replaces the named products' terms and leaves the rest of
 * the card alone.
 *
 * `replaceAll` is the "paste the whole price list" case: every product not in
 * the payload is removed from the card. Off by default, because a partial
 * upload that silently deleted 400 negotiated lines is not recoverable from the
 * UI.
 */
export const SetRateCardItemsSchema = z.object({
  items: z.array(RateCardItemSchema).min(1, 'Nothing to set').max(2_000),
  replaceAll: z.boolean().default(false),
});

export type SetRateCardItemsDto = z.infer<typeof SetRateCardItemsSchema>;

export const ListRateCardsQuerySchema = z.object({
  /** Administrators only; a customer always sees their own account. */
  accountId: z.string().trim().max(64).optional(),
  status: RateCardStatus.optional(),
  /** Case-insensitive match against the card name. */
  search: z.string().trim().max(120).optional(),
  /** Only cards in force at this instant. Defaults to off, not to "now". */
  activeAt: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListRateCardsQueryDto = z.infer<typeof ListRateCardsQuerySchema>;

export const ListRateCardItemsQuerySchema = z.object({
  /** Case-insensitive match against product name or SKU. */
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListRateCardItemsQueryDto = z.infer<typeof ListRateCardItemsQuerySchema>;

/**
 * A quote request: what this account pays for these products at these
 * quantities.
 *
 * Batched because the caller is a product grid or a cart, both of which need
 * every line at once. One request per tile would put the rate-card lookup on
 * the critical path fifty times for a single page.
 */
export const QuoteSchema = z.object({
  lines: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(64),
        quantity: z.coerce.number().int().min(1).max(10_000_000),
      }),
    )
    .min(1, 'Nothing to quote')
    .max(200, 'Quote at most 200 lines at a time'),
  /**
   * Price as of this instant rather than now. Administrators only — it is how
   * "what will this customer pay when the new card starts" is answered, and it
   * must not let a customer price themselves against an expired contract.
   */
  at: z.coerce.date().optional(),
  /**
   * Administrators pricing on behalf of a customer. Ignored for everyone else,
   * who are always quoted against their own account.
   */
  accountId: z.string().trim().max(64).optional(),
});

export type QuoteDto = z.infer<typeof QuoteSchema>;
