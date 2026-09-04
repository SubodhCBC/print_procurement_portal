import { z } from 'zod';

/**
 * Request shapes for the template module (SOW FE-13).
 *
 * The layer and canvas schemas mirror the builder's own document model rather
 * than inventing a server-side one. A template is a *design*, and a design is
 * exactly what the editor that draws it says it is; a second, subtly different
 * model here would mean every new control the designer gains breaks a save
 * until somebody remembers to widen a schema.
 *
 * What is *not* passthrough is the part this system has opinions about: the
 * layer's identity, its label, and whether a buyer may change it. Those are
 * validated strictly, because they are what the customiser and the print
 * payload both read.
 */

// --- The design document -------------------------------------------------------

/**
 * One drawable element.
 *
 * `style`, geometry and the extra keys a future control adds are passed through
 * unread — see the note above. `isEditableBySiteUser` is the field that matters
 * to this system: it is the difference between a buyer personalising a template
 * and a buyer redesigning it.
 */
export const TemplateLayerSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    type: z.string().trim().min(1).max(40),
    name: z.string().trim().max(200).default(''),
    label: z.string().trim().max(200).default(''),
    helperText: z.string().trim().max(500).optional(),
    /**
     * The designer's decision, and the only thing standing between a locked
     * layer and a buyer who edits the request by hand. Defaulted to `false`:
     * a layer whose editability was omitted is locked, because the safe
     * direction for a missing flag is the restrictive one.
     */
    isEditableBySiteUser: z.boolean().default(false),
    /**
     * Gives the field a meaning shared across templates — `businessName` is the
     * same question on a poster and on a business card — so a buyer's details
     * can be pre-filled rather than retyped for every order.
     */
    fieldKey: z.string().trim().min(1).max(60).optional(),
    isRequired: z.boolean().optional(),
    content: z.string().max(20_000).default(''),
  })
  .passthrough();

export type TemplateLayerDto = z.infer<typeof TemplateLayerSchema>;

export const CanvasConfigSchema = z
  .object({
    backgroundColor: z.string().trim().max(120).default('#FFFFFF'),
    backgroundImageUrl: z.string().trim().max(2000).optional(),
    bgGradient: z.string().trim().max(500).optional(),
    bgPattern: z.string().trim().max(500).optional(),
  })
  .passthrough();

/**
 * The editor's structured document — groups, masks, gradients, filters.
 *
 * Stored whole and unread. This system renders nothing; it stores what the
 * builder wrote and hands it back byte for byte. Parsing it into a server-side
 * model would buy nothing and cost a deployment every time the editor gained a
 * feature.
 *
 * The cap is the guard that matters: a design document is kilobytes, and
 * something megabyte-sized is either a bug or an attempt to use the database as
 * a file store. Images belong in object storage, reached by key.
 */
export const DesignDocumentSchema = z.record(z.unknown());

const MAX_LAYERS = 500;

// --- Create and update ---------------------------------------------------------

const DimensionUnit = z.enum(['IN', 'MM', 'PX']);
const Orientation = z.enum(['LANDSCAPE', 'PORTRAIT', 'SQUARE']);

const templateBody = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),

  /** The product this artwork prints onto. Optional while a design is roughed out. */
  productId: z.string().trim().max(64).optional(),
  categoryId: z.string().trim().max(64).optional(),

  theme: z.string().trim().max(60).optional(),
  orientation: Orientation.default('PORTRAIT'),
  aspectRatio: z.string().trim().max(20).optional(),

  /** Positive by database constraint too — a canvas with no area is not a canvas. */
  widthValue: z.coerce.number().positive().max(100_000),
  heightValue: z.coerce.number().positive().max(100_000),
  dimensionUnit: DimensionUnit.default('IN'),
  bleedMargin: z.coerce.number().min(0).max(1000).default(0),
  safeMargin: z.coerce.number().min(0).max(1000).default(0),

  canvasConfig: CanvasConfigSchema.default({ backgroundColor: '#FFFFFF' }),
  layers: z.array(TemplateLayerSchema).max(MAX_LAYERS).default([]),
  design: DesignDocumentSchema.optional(),
  canvasJson: z.string().max(4_000_000).optional(),
};

export const CreateTemplateSchema = z.object({
  /**
   * Optional: generated from the name when omitted, which is what the builder's
   * "New template" button wants. Supplied when an operator is migrating a
   * library and needs to keep its codes.
   */
  code: z.string().trim().min(1).max(60).optional(),
  ...templateBody,
});

export type CreateTemplateDto = z.infer<typeof CreateTemplateSchema>;

/**
 * A save from the builder — including an autosave.
 *
 * Every field is optional because an autosave sends what changed, and the
 * canvas is the only thing that usually did. `expectedVersion` is the part that
 * is not optional in spirit: see the note on it.
 */
export const UpdateTemplateSchema = z
  .object({
    code: z.string().trim().min(1).max(60).optional(),
    name: templateBody.name.optional(),
    description: templateBody.description,
    productId: templateBody.productId,
    categoryId: templateBody.categoryId,
    theme: templateBody.theme,
    orientation: Orientation.optional(),
    aspectRatio: templateBody.aspectRatio,
    widthValue: z.coerce.number().positive().max(100_000).optional(),
    heightValue: z.coerce.number().positive().max(100_000).optional(),
    dimensionUnit: DimensionUnit.optional(),
    bleedMargin: z.coerce.number().min(0).max(1000).optional(),
    safeMargin: z.coerce.number().min(0).max(1000).optional(),
    canvasConfig: CanvasConfigSchema.optional(),
    layers: z.array(TemplateLayerSchema).max(MAX_LAYERS).optional(),
    design: DesignDocumentSchema.optional(),
    canvasJson: z.string().max(4_000_000).optional(),

    /**
     * The version the editor believes it is editing.
     *
     * Omitting it means "I do not care what happened since I loaded this", and
     * that is a real choice a recovery tool might make — so it is allowed
     * rather than required. But the builder always sends it, because two
     * designers with one template open is an ordinary Tuesday and silently
     * keeping whichever save landed last is how an afternoon's work disappears
     * with nothing to show it ever existed.
     */
    expectedVersion: z.coerce.number().int().min(1).optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedVersion'), {
    message: 'A save must change something.',
  });

export type UpdateTemplateDto = z.infer<typeof UpdateTemplateSchema>;

// --- Lifecycle -----------------------------------------------------------------

export const ChangeTemplateStatusSchema = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
});

export type ChangeTemplateStatusDto = z.infer<typeof ChangeTemplateStatusSchema>;

export const PublishTemplateSchema = z.object({
  /** Shown in the version history — "Q4 rebrand", "Legal-approved copy". */
  label: z.string().trim().max(200).optional(),
});

export type PublishTemplateDto = z.infer<typeof PublishTemplateSchema>;

/**
 * Cuts a restore point without publishing.
 *
 * The builder does this on every explicit save — as opposed to an autosave —
 * because an explicit save is the moment a designer decided something was worth
 * keeping. Publishing also cuts one; this is the same snapshot without the
 * consequence of moving customers onto it.
 */
export const SnapshotTemplateSchema = z.object({
  label: z.string().trim().max(200).optional(),
});

export type SnapshotTemplateDto = z.infer<typeof SnapshotTemplateSchema>;

export const DuplicateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  code: z.string().trim().min(1).max(60).optional(),
});

export type DuplicateTemplateDto = z.infer<typeof DuplicateTemplateSchema>;

export const RestoreVersionSchema = z.object({
  /**
   * Restoring copies an old snapshot back over the draft. It never deletes the
   * versions in between: the point of a history is that it does not lose the
   * thing you restored *from*.
   */
  version: z.coerce.number().int().min(1),
});

export type RestoreVersionDto = z.infer<typeof RestoreVersionSchema>;

export const SetTemplateVisibilitySchema = z
  .object({
    visibility: z.enum(['ALL_ACCOUNTS', 'RESTRICTED']),
    accountIds: z.array(z.string().trim().min(1).max(64)).max(500).default([]),
  })
  .refine((body) => body.visibility === 'ALL_ACCOUNTS' || body.accountIds.length > 0, {
    message: 'A RESTRICTED template with no accounts listed would be visible to nobody.',
    path: ['accountIds'],
  });

export type SetTemplateVisibilityDto = z.infer<typeof SetTemplateVisibilitySchema>;

// --- Listing -------------------------------------------------------------------

export const ListTemplatesQuerySchema = z.object({
  categoryId: z.string().trim().max(64).optional(),
  productId: z.string().trim().max(64).optional(),
  /** Omitted, an operator sees everything and a customer sees published only. */
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  theme: z.string().trim().max(60).optional(),
  search: z.string().trim().max(120).optional(),
  /**
   * Presign one tile per row. Off by default for the same reason the catalogue
   * does it: signing every image for a caller that never opens one is work for
   * nobody. A gallery asks; a picker that only needs names does not.
   */
  withThumbnails: z
    .union([z.boolean(), z.string()])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListTemplatesQueryDto = z.infer<typeof ListTemplatesQuerySchema>;

// --- Assets --------------------------------------------------------------------

const AssetKind = z.enum(['THUMBNAIL', 'PREVIEW', 'SOURCE']);

/**
 * Step one of the upload: ask where to put the file.
 *
 * The same two-step the catalogue uses. The browser PUTs straight to storage
 * with the returned URL and then calls `POST /assets` with the key it was
 * given — so a 12MB cover image never passes through this process, and a
 * half-finished upload leaves no row behind claiming it succeeded.
 */
export const PresignTemplateAssetSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z
    .string()
    .trim()
    .min(1)
    .max(120)
    /**
     * Images only, and checked here rather than at attach time.
     *
     * A presigned URL is a bearer token for a write: whatever content type it
     * is signed for is what the browser may upload. Signing one for an
     * arbitrary type would turn this endpoint into "upload anything to our
     * bucket" for anyone holding TEMPLATE_MANAGE.
     */
    .refine((value) => value.startsWith('image/'), {
      message:
        'Template assets are images. Use image/png, image/jpeg, image/webp or image/svg+xml.',
    }),
  kind: AssetKind.default('SOURCE'),
});

export type PresignTemplateAssetDto = z.infer<typeof PresignTemplateAssetSchema>;

export const AttachTemplateAssetSchema = z.object({
  /** The key handed back by the presign call, not one the client invented. */
  storageKey: z.string().trim().min(1).max(1024),
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  sizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  kind: AssetKind.default('SOURCE'),
  altText: z.string().trim().max(300).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  /**
   * Set when the file came from the DAM rather than a direct upload, so the
   * origin of every asset is answerable without inferring it from a key.
   */
  damDocumentId: z.string().trim().max(200).optional(),
});

export type AttachTemplateAssetDto = z.infer<typeof AttachTemplateAssetSchema>;

// --- Personalisation -----------------------------------------------------------

/**
 * What a buyer submits from the customiser.
 *
 * Values are checked against the *published* template's editable layers by
 * `acceptCustomisation`, which rebuilds the record rather than passing this one
 * through — an unknown key cannot survive a rebuild by accident.
 */
export const CustomiseTemplateSchema = z.object({
  fields: z.record(z.string().trim().max(60), z.unknown()).default({}),
});

export type CustomiseTemplateDto = z.infer<typeof CustomiseTemplateSchema>;
