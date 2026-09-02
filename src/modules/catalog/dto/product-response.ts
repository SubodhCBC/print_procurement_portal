import type { CatalogImportJob, ProductAsset, ProductOption, ProductVariant } from '@prisma/client';
import { priceLadder, type PriceBreakdown } from '../product-pricing';
import type { CategoryWithCount } from '../categories.service';
import type { FullProduct } from '../products.service';

/**
 * Catalog responses.
 *
 * Explicit whitelists, as everywhere else. Two conventions carried through from
 * the rest of the API: money is a string because these are NUMERIC(12,2)
 * columns a JSON number would round, and asset URLs are minted per response
 * rather than stored, because a stored URL is either permanent — and therefore
 * a public bucket — or expired by the time anyone opens the row.
 */

export interface CategoryView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly status: CategoryWithCount['status'];
  readonly itemCount: number;
}

export function toCategoryView(category: CategoryWithCount): CategoryView {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
    sortOrder: category.sortOrder,
    status: category.status,
    // Named `itemCount` rather than `productCount` to match the field the admin
    // catalogue screen already reads.
    itemCount: category._count.products,
  };
}

export interface ProductOptionView {
  readonly id: string;
  readonly name: string;
  readonly values: readonly string[];
  readonly sortOrder: number;
}

export function toOptionView(option: ProductOption): ProductOptionView {
  return {
    id: option.id,
    name: option.name,
    values: option.values,
    sortOrder: option.sortOrder,
  };
}

export interface ProductVariantView {
  readonly id: string;
  readonly sku: string;
  readonly attributes: Record<string, string>;
  /** Null when the variant sells at the product's base price. */
  readonly priceOverride: string | null;
  /** What this variant actually costs — the override, or the product's base. */
  readonly effectivePrice: string;
  readonly stockOnHand: number;
  readonly status: ProductVariant['status'];
}

export interface ProductAssetView {
  readonly id: string;
  readonly kind: ProductAsset['kind'];
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly altText: string | null;
  readonly sortOrder: number;
  /** Intrinsic pixel size, so the grid can reserve the box before it loads. */
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  /**
   * Whether the resized copies exist yet. PENDING means the render queue has
   * not got to it; FAILED means it tried and could not, and `derivativeError`
   * says why — surfaced so a missing thumbnail is visibly a failure rather than
   * mistaken for a failed upload.
   */
  readonly derivativeStatus: ProductAsset['derivativeStatus'];
  readonly derivativeError: string | null;
  /**
   * Short-lived presigned links, present only when the caller asked for them.
   * Absent on list responses, where minting a URL per asset per row would be
   * signing work for images most callers never load.
   */
  readonly url?: string;
  readonly thumbnailUrl?: string;
  readonly previewUrl?: string;
}

/** A row of the volume-discount table on the product detail page (FE-03). */
export interface VolumeTierView {
  readonly minQuantity: number;
  readonly discountPercent: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

export interface ProductView {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: { readonly id: string; readonly code: string; readonly name: string };
  readonly status: FullProduct['status'];
  readonly visibility: FullProduct['visibility'];
  readonly basePrice: string;
  readonly moq: number;
  readonly orderMultiple: number;
  readonly packSize: number;
  readonly uom: FullProduct['uom'];
  readonly widthMm: number | null;
  readonly heightMm: number | null;
  readonly depthMm: number | null;
  readonly weightGrams: number | null;
  readonly bleedMm: string | null;
  readonly safeMarginMm: string | null;
  readonly trackInventory: boolean;
  readonly stockOnHand: number;
  readonly lowStockThreshold: number;
  /** Derived, so the catalogue grid does not have to compare two fields. */
  readonly isLowStock: boolean;
  readonly leadTimeDays: number | null;
  readonly tags: readonly string[];
  readonly options: readonly ProductOptionView[];
  readonly variants: readonly ProductVariantView[];
  readonly volumeTiers: readonly VolumeTierView[];
  readonly assets: readonly ProductAssetView[];
  readonly supersededBy: {
    readonly id: string;
    readonly sku: string;
    readonly name: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `assetUrls` maps asset id to a presigned link. Passed in rather than fetched
 * here so that a list of fifty products does not trigger fifty signing calls
 * the caller never asked for.
 */
export function toProductView(
  product: FullProduct,
  assetUrls: Record<string, string> = {},
): ProductView {
  const baseCents = toCents(product.basePrice);

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    status: product.status,
    visibility: product.visibility,
    basePrice: product.basePrice.toFixed(2),
    moq: product.moq,
    orderMultiple: product.orderMultiple,
    packSize: product.packSize,
    uom: product.uom,
    widthMm: product.widthMm,
    heightMm: product.heightMm,
    depthMm: product.depthMm,
    weightGrams: product.weightGrams,
    bleedMm: product.bleedMm?.toFixed(2) ?? null,
    safeMarginMm: product.safeMarginMm?.toFixed(2) ?? null,
    trackInventory: product.trackInventory,
    stockOnHand: product.stockOnHand,
    lowStockThreshold: product.lowStockThreshold,
    isLowStock: product.trackInventory && product.stockOnHand <= product.lowStockThreshold,
    leadTimeDays: product.leadTimeDays,
    tags: product.tags,
    options: product.options.map(toOptionView),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      attributes: (variant.attributes ?? {}) as Record<string, string>,
      priceOverride: variant.priceOverride?.toFixed(2) ?? null,
      effectivePrice: (variant.priceOverride ?? product.basePrice).toFixed(2),
      stockOnHand: variant.stockOnHand,
      status: variant.status,
    })),
    // Priced here rather than stored, so the ladder always reflects the current
    // base price — the reason tiers are a percentage and not a unit price.
    volumeTiers: priceLadder(
      baseCents,
      product.volumeTiers.map((tier) => ({
        minQuantity: tier.minQuantity,
        discountPercent: Number(tier.discountPercent),
      })),
    ).map(toVolumeTierView),
    assets: product.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      filename: asset.filename,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      altText: asset.altText,
      sortOrder: asset.sortOrder,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      derivativeStatus: asset.derivativeStatus,
      derivativeError: asset.derivativeError,
      ...(assetUrls[asset.id] ? { url: assetUrls[asset.id] } : {}),
      ...(assetUrls[`${asset.id}:thumbnail`]
        ? { thumbnailUrl: assetUrls[`${asset.id}:thumbnail`] }
        : {}),
      ...(assetUrls[`${asset.id}:preview`] ? { previewUrl: assetUrls[`${asset.id}:preview`] } : {}),
    })),
    supersededBy: product.supersededBy
      ? {
          id: product.supersededBy.id,
          sku: product.supersededBy.sku,
          name: product.supersededBy.name,
        }
      : null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function toVolumeTierView(row: PriceBreakdown): VolumeTierView {
  return {
    minQuantity: row.quantity,
    discountPercent: row.discountPercent.toFixed(2),
    unitPrice: fromCents(row.unitPriceCents),
    lineTotal: fromCents(row.lineTotalCents),
  };
}

/**
 * Decimal to integer cents.
 *
 * Via the string form, not `Number(decimal)`. Prisma's Decimal is exact and its
 * string form is exact; routing through a float first is the one step that can
 * lose the cent this whole convention exists to protect.
 */
function toCents(value: { toFixed(digits: number): string }): number {
  return Math.round(Number(value.toFixed(2)) * 100);
}

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * A bulk import run, as the API exposes it.
 *
 * `payload` — the uploaded rows — is never returned: it can be ten thousand
 * objects, the caller already has it, and echoing it on every poll would make a
 * status check the most expensive request in the system. `results` comes back
 * only from the single-job endpoint, which is where somebody is actually
 * reading the per-row outcomes.
 */
export interface ImportJobView {
  readonly id: string;
  readonly status: CatalogImportJob['status'];
  readonly dryRun: boolean;
  readonly updateExisting: boolean;
  readonly totalRows: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
  /** Set only when the run itself broke, as opposed to individual rows failing. */
  readonly error: string | null;
  readonly requestedById: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  /** Per-row outcomes. Present only when explicitly requested. */
  readonly results?: unknown;
}

/** Everything an import job exposes except the submitted rows. */
export type ImportJobSummaryRow = Omit<CatalogImportJob, 'payload' | 'results'> & {
  results?: unknown;
};

export function toImportJobView(job: ImportJobSummaryRow, includeResults = false): ImportJobView {
  return {
    id: job.id,
    status: job.status,
    dryRun: job.dryRun,
    updateExisting: job.updateExisting,
    totalRows: job.totalRows,
    created: job.created,
    updated: job.updated,
    skipped: job.skipped,
    failed: job.failed,
    error: job.error,
    requestedById: job.requestedById,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    ...(includeResults ? { results: job.results ?? null } : {}),
  };
}
