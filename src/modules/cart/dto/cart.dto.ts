import { z } from 'zod';

/**
 * Personalisation captured by the template customiser: artwork field values,
 * finish choices, an uploaded asset key.
 *
 * Deliberately opaque — a record of JSON values rather than a modelled shape.
 * The template builder decides what a field is, and pinning the schema here
 * would mean a backend release every time a designer adds a text box. BE-06
 * snapshots it onto the order line and INT-01 sends it to production; neither
 * interprets it either.
 *
 * Bounded, though: a cart line is not a file store.
 */
const Customisation = z
  .record(z.string().max(120), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 100, 'At most 100 customisation fields');

const Quantity = z.coerce.number().int().min(1, 'Quantity must be at least 1').max(10_000_000);

export const AddCartLineSchema = z.object({
  productId: z.string().trim().min(1, 'A product is required').max(64),
  /** Required when the product has options; the service checks that. */
  variantId: z.string().trim().max(64).nullish(),
  /**
   * As the buyer typed it. Rounding to the MOQ and order multiple is reported
   * at validation, not applied here — see the note in the migration.
   */
  quantity: Quantity,
  customisation: Customisation.nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export type AddCartLineDto = z.infer<typeof AddCartLineSchema>;

export const UpdateCartLineSchema = z
  .object({
    quantity: Quantity.optional(),
    customisation: Customisation.nullish(),
    notes: z.string().trim().max(1000).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export type UpdateCartLineDto = z.infer<typeof UpdateCartLineSchema>;

const PaymentMethod = z.enum(['NET_30_INVOICE', 'P_CARD', 'ACH']);

/**
 * The checkout stepper's fields (FE-04), all optional so each step can save as
 * the buyer moves through it rather than only at the end.
 *
 * `acceptTerms` is a boolean in and a timestamp out: what has to be recorded is
 * *when* the buyer accepted, and asking the client for that instant would let
 * it send any value it liked.
 */
export const SetCheckoutDetailsSchema = z
  .object({
    /** Which branch the order is for. Head-office buyers choose; site users cannot. */
    siteId: z.string().trim().max(64).nullish(),
    poNumber: z.string().trim().max(64).nullish(),
    campaignCode: z.string().trim().max(64).nullish(),
    notes: z.string().trim().max(4000).nullish(),
    requestedDeliveryDate: z.coerce.date().nullish(),
    shippingAddressId: z.string().trim().max(64).nullish(),
    billingAddressId: z.string().trim().max(64).nullish(),
    paymentMethod: PaymentMethod.nullish(),
    acceptTerms: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to set');

export type SetCheckoutDetailsDto = z.infer<typeof SetCheckoutDetailsSchema>;

export const CartQuerySchema = z.object({
  /**
   * Which branch's basket. Defaults to the caller's own site; a head-office
   * buyer keeps one basket per branch they order for.
   */
  siteId: z.string().trim().max(64).optional(),
});

export type CartQueryDto = z.infer<typeof CartQuerySchema>;

export const ValidateCartQuerySchema = CartQuerySchema.extend({
  /**
   * Also check the details the stepper collects — address, payment, terms.
   * Off by default so the cart page does not complain about an address the
   * buyer has not reached the step for yet.
   */
  forCheckout: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
});

export type ValidateCartQueryDto = z.infer<typeof ValidateCartQuerySchema>;
