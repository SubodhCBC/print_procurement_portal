import type { Prisma, Template, TemplateAsset, TemplateVersion } from '@prisma/client';
import type { TemplateLayerLike } from '../template-status';
import { editableFieldKey, editableLayers } from '../template-status';

/**
 * Template responses.
 *
 * Explicit whitelists, as everywhere else in this API, and two conventions
 * carried through: dimensions are **numbers** rather than the money-style
 * strings, because these are physical measurements a chart and a canvas both do
 * arithmetic on and NUMERIC(10,3) has no rounding trap at these magnitudes; and
 * image URLs are minted per response rather than stored, because a stored URL
 * is either permanent — and therefore a public bucket — or expired by the time
 * anyone opens the row.
 *
 * Field names match the front end's `PrintTemplate` type deliberately. A
 * mapping layer between two shapes that describe the same thing is a place for
 * a rename to go wrong, and there is nothing here worth renaming.
 */

/** Dimensions are stored as NUMERIC; the canvas wants numbers. */
function decimal(value: Prisma.Decimal): number {
  return value.toNumber();
}

export interface TemplateAssetView {
  readonly id: string;
  readonly kind: TemplateAsset['kind'];
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly altText: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly derivativeStatus: TemplateAsset['derivativeStatus'];
  /** Why a resize failed, so a broken tile is visible rather than a mystery. */
  readonly derivativeError: string | null;
  readonly damDocumentId: string | null;
  readonly sortOrder: number;
  /** Short-lived, minted for this response. Absent when signing was not asked for. */
  readonly url?: string;
  readonly thumbnailUrl?: string;
}

export function toAssetView(
  asset: TemplateAsset,
  urls: Readonly<Record<string, string>> = {},
): TemplateAssetView {
  const url = urls[asset.id];
  const thumbnailUrl = urls[`${asset.id}:thumbnail`];

  return {
    id: asset.id,
    kind: asset.kind,
    filename: asset.filename,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    altText: asset.altText,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    derivativeStatus: asset.derivativeStatus,
    derivativeError: asset.derivativeError,
    damDocumentId: asset.damDocumentId,
    sortOrder: asset.sortOrder,
    ...(url ? { url } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

export interface TemplateVersionView {
  readonly id: string;
  readonly version: number;
  readonly label: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
  /** Whether this is the snapshot the storefront currently renders. */
  readonly isPublished: boolean;
}

export function toVersionView(
  version: TemplateVersion,
  publishedVersionId: string | null,
): TemplateVersionView {
  return {
    id: version.id,
    version: version.version,
    label: version.label,
    createdByName: version.createdByName,
    createdAt: version.createdAt.toISOString(),
    isPublished: version.id === publishedVersionId,
  };
}

/**
 * One editable field, as the customiser needs it.
 *
 * Derived from the layers rather than stored separately: two lists of the same
 * thing drift, and the one that drifts is always the one the buyer sees.
 */
export interface TemplateFieldView {
  readonly key: string;
  readonly layerId: string;
  readonly type: string;
  readonly label: string;
  readonly helperText?: string;
  readonly isRequired: boolean;
  /** What the designer put there, shown as the placeholder. */
  readonly defaultValue: string;
}

/**
 * Names the editor gives an unnamed object, which are not labels.
 *
 * The builder defaults a layer's name to its fabric type, and its label to that
 * name. So a designer who marks a text box editable without naming it produces
 * a storefront asking the buyer to fill in a field called "Text" — or, before
 * shapes were filtered out, "Rect" and "Path".
 */
const TYPE_NAMES: ReadonlySet<string> = new Set([
  'text',
  'i-text',
  'textbox',
  'rect',
  'circle',
  'path',
  'line',
  'polygon',
  'image',
  'group',
  'shape',
  'badge',
  'divider',
  'qrcode',
  'barcode',
  'layer',
]);

/**
 * `contactName` -> `Contact name`.
 *
 * Used when the designer left the label as the editor's default. A humanised
 * field key is a worse label than a considered one and a much better label than
 * "Text": the buyer at least learns what they are being asked for.
 */
function humanise(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();

  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function toFieldViews(layers: readonly TemplateLayerLike[]): readonly TemplateFieldView[] {
  return editableLayers(layers).map((layer) => {
    const key = editableFieldKey(layer);
    const given = (layer.label || layer.name || '').trim();
    // A label that is just the object's type tells the buyer nothing, so the
    // field key — which the designer did choose — is used instead.
    const label = given.length > 0 && !TYPE_NAMES.has(given.toLowerCase()) ? given : humanise(key);

    return {
      key,
      layerId: layer.id,
      type: layer.type,
      label,
      ...(layer.helperText ? { helperText: layer.helperText } : {}),
      isRequired: layer.isRequired ?? false,
      defaultValue: layer.content,
    };
  });
}

/** The row a gallery or a picker renders. No design document, by design. */
export interface TemplateSummaryView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: Template['status'];
  readonly visibility: Template['visibility'];
  readonly productId: string | null;
  /** Joined, so a gallery prints a name rather than fetching a product per tile. */
  readonly productName: string | null;
  readonly productSku: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly theme: string | null;
  readonly orientation: Template['orientation'];
  readonly aspectRatio: string | null;
  readonly dimensions: {
    readonly width: number;
    readonly height: number;
    readonly unit: Template['dimensionUnit'];
  };
  readonly bleedMargin: number;
  readonly safeMargin: number;
  readonly version: number;
  readonly publishedVersion: number | null;
  readonly publishedAt: string | null;
  /**
   * How many fields a buyer fills in, and how many layers there are in all.
   *
   * Both counted server-side because a gallery row deliberately carries no
   * design document — sending forty of them to draw forty tiles would be
   * megabytes to render a grid — and a count the client cannot compute is a
   * count the server has to provide.
   */
  readonly editableFieldCount: number;
  readonly layerCount: number;
  readonly thumbnailUrl?: string;
  readonly createdByName: string | null;
  readonly updatedByName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TemplateSummarySource extends Template {
  readonly publishedVersion?: { readonly version: number } | null;
  readonly product?: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly category?: { readonly id: string; readonly code: string; readonly name: string } | null;
}

export function toTemplateSummary(
  template: TemplateSummarySource,
  thumbnailUrl?: string,
): TemplateSummaryView {
  const layers = readLayers(template.layers);

  return {
    id: template.id,
    code: template.code,
    name: template.name,
    description: template.description,
    status: template.status,
    visibility: template.visibility,
    productId: template.productId,
    productName: template.product?.name ?? null,
    productSku: template.product?.sku ?? null,
    categoryId: template.categoryId,
    categoryName: template.category?.name ?? null,
    theme: template.theme,
    orientation: template.orientation,
    aspectRatio: template.aspectRatio,
    dimensions: {
      width: decimal(template.widthValue),
      height: decimal(template.heightValue),
      unit: template.dimensionUnit,
    },
    bleedMargin: decimal(template.bleedMargin),
    safeMargin: decimal(template.safeMargin),
    version: template.version,
    publishedVersion: template.publishedVersion?.version ?? null,
    publishedAt: template.publishedAt?.toISOString() ?? null,
    editableFieldCount: editableLayers(layers).length,
    layerCount: layers.length,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    createdByName: template.createdByName,
    updatedByName: template.updatedByName,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

/** The whole working copy: what the builder opens. */
export interface TemplateDetailView extends TemplateSummaryView {
  readonly canvasConfig: Record<string, unknown>;
  readonly layers: readonly Record<string, unknown>[];
  readonly design: Record<string, unknown> | null;
  readonly canvasJson: string | null;
  readonly fields: readonly TemplateFieldView[];
  readonly assets: readonly TemplateAssetView[];
  readonly versions: readonly TemplateVersionView[];
  readonly restrictedToAccountIds: readonly string[];
}

export interface FullTemplateSource extends TemplateSummarySource {
  readonly assets: readonly TemplateAsset[];
  readonly versions: readonly TemplateVersion[];
  readonly visibleTo: readonly { readonly accountId: string }[];
}

export function toTemplateDetail(
  template: FullTemplateSource,
  urls: Readonly<Record<string, string>> = {},
): TemplateDetailView {
  const layers = readLayers(template.layers);

  return {
    ...toTemplateSummary(template, urls.thumbnail),
    canvasConfig: readObject(template.canvasConfig),
    layers: layers as unknown as readonly Record<string, unknown>[],
    design: template.design === null ? null : readObject(template.design),
    canvasJson: template.canvasJson,
    fields: toFieldViews(layers),
    assets: template.assets.map((asset) => toAssetView(asset, urls)),
    versions: template.versions.map((version) =>
      toVersionView(version, template.publishedVersionId),
    ),
    restrictedToAccountIds: template.visibleTo.map((row) => row.accountId),
  };
}

/**
 * What a buyer gets: the published snapshot, never the working copy.
 *
 * Built from the frozen version rather than from the template row, which is the
 * whole point of having versions — a designer mid-rework must not change what
 * the person on the customiser is looking at.
 */
export interface CustomisableTemplateView {
  readonly templateId: string;
  readonly versionId: string;
  readonly version: number;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly productId: string | null;
  /** From the live row, not the snapshot — see the note in `getCustomisable`. */
  readonly productName: string | null;
  readonly productSku: string | null;
  readonly categoryName: string | null;
  readonly orientation: Template['orientation'];
  readonly aspectRatio: string | null;
  readonly dimensions: {
    readonly width: number;
    readonly height: number;
    readonly unit: Template['dimensionUnit'];
  };
  readonly bleedMargin: number;
  readonly safeMargin: number;
  readonly canvasConfig: Record<string, unknown>;
  readonly layers: readonly Record<string, unknown>[];
  readonly design: Record<string, unknown> | null;
  readonly canvasJson: string | null;
  readonly fields: readonly TemplateFieldView[];
  readonly thumbnailUrl?: string;
  readonly previewUrl?: string;
}

/**
 * The snapshot's own shape.
 *
 * Written by `TemplatesService.snapshot()` and read only here. It is a copy of
 * the template's renderable state at publish time — deliberately not a
 * reference to the row, because a reference is exactly what would let the row
 * move underneath it.
 */
export interface TemplateSnapshot {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly theme: string | null;
  readonly orientation: Template['orientation'];
  readonly aspectRatio: string | null;
  readonly widthValue: number;
  readonly heightValue: number;
  readonly dimensionUnit: Template['dimensionUnit'];
  readonly bleedMargin: number;
  readonly safeMargin: number;
  readonly canvasConfig: Record<string, unknown>;
  readonly layers: readonly Record<string, unknown>[];
  readonly design: Record<string, unknown> | null;
  readonly canvasJson: string | null;
}

export function readSnapshot(value: Prisma.JsonValue): TemplateSnapshot {
  return readObject(value) as unknown as TemplateSnapshot;
}

/** The template row a buyer read carries, with its live references joined. */
export interface CustomisableTemplateSource extends Template {
  readonly product?: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly category?: { readonly id: string; readonly code: string; readonly name: string } | null;
}

export function toCustomisableView(
  template: CustomisableTemplateSource,
  version: TemplateVersion,
  urls: Readonly<Record<string, string>> = {},
): CustomisableTemplateView {
  const snapshot = readSnapshot(version.snapshot);
  const layers = snapshot.layers as unknown as readonly TemplateLayerLike[];

  return {
    templateId: template.id,
    versionId: version.id,
    version: version.version,
    code: snapshot.code,
    name: snapshot.name,
    description: snapshot.description,
    productId: snapshot.productId,
    productName: template.product?.name ?? null,
    productSku: template.product?.sku ?? null,
    categoryName: template.category?.name ?? null,
    orientation: snapshot.orientation,
    aspectRatio: snapshot.aspectRatio,
    dimensions: {
      width: snapshot.widthValue,
      height: snapshot.heightValue,
      unit: snapshot.dimensionUnit,
    },
    bleedMargin: snapshot.bleedMargin,
    safeMargin: snapshot.safeMargin,
    canvasConfig: snapshot.canvasConfig,
    layers: snapshot.layers,
    design: snapshot.design,
    canvasJson: snapshot.canvasJson,
    fields: toFieldViews(layers),
    ...(urls.thumbnail ? { thumbnailUrl: urls.thumbnail } : {}),
    ...(urls.preview ? { previewUrl: urls.preview } : {}),
  };
}

/**
 * Reads the stored layer array.
 *
 * Stored as `Json`, so Prisma types it as `JsonValue` and every read has to
 * narrow it. It was validated by the schema on the way in; this is the
 * narrowing, not a second validation, and a row that somehow holds something
 * else reads as no layers rather than throwing halfway through rendering a
 * gallery of forty.
 */
export function readLayers(value: Prisma.JsonValue): readonly TemplateLayerLike[] {
  return Array.isArray(value) ? (value as unknown as readonly TemplateLayerLike[]) : [];
}

function readObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
