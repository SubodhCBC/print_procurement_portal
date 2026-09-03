import type { PrismaClient, UnitOfMeasure } from '@prisma/client';
import { createId } from '@/common';
import { loadConfig } from '@/config';

/**
 * A working catalogue for local development.
 *
 * The products mirror the shape of the print collateral this portal actually
 * sells — signs, banners, flyers, cards, catalogues — with the option axes,
 * volume ladders and stock levels the shop and admin screens read. Without
 * these, every catalogue screen renders an empty state and there is nothing to
 * verify an integration against.
 *
 * No assets are attached. Product images live in object storage and are served
 * as presigned links; seeding a key with no object behind it would produce
 * tiles that 404 rather than tiles that fall back cleanly.
 *
 * Idempotent: categories upsert on `code` and products on `sku`, and the
 * child rows of a product are replaced rather than appended, so a second run
 * does not double a volume ladder.
 */

interface SeedCategory {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly sortOrder: number;
}

const CATEGORIES: readonly SeedCategory[] = [
  {
    code: 'SIGNS',
    name: 'Signs & Posters',
    description:
      'Yard signs, acrylic office signs, aluminium composite boards and high-gloss posters',
    sortOrder: 10,
  },
  {
    code: 'BANNERS',
    name: 'Banners & Displays',
    description: 'Retractable roll-up banners, mesh outdoor banners and step-and-repeat backdrops',
    sortOrder: 20,
  },
  {
    code: 'FLYERS',
    name: 'Flyers & Brochures',
    description: 'Tri-fold promotional brochures, club flyers and bi-fold product guides',
    sortOrder: 30,
  },
  {
    code: 'CARDS',
    name: 'Business Cards & Stationery',
    description: 'Soft-touch, linen and foil-stamped business cards, letterheads and envelopes',
    sortOrder: 40,
  },
  {
    code: 'CATALOGUES',
    name: 'Catalogues & Booklets',
    description: 'Saddle-stitched catalogues, price lists and multi-page product booklets',
    sortOrder: 50,
  },
  {
    code: 'TEMPLATES',
    name: 'Template Design Services',
    description: 'Bespoke design starters and reusable brand layouts for site teams',
    sortOrder: 60,
  },
];

interface SeedProduct {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly categoryCode: string;
  readonly basePrice: string;
  readonly moq: number;
  readonly orderMultiple: number;
  readonly packSize: number;
  readonly uom: UnitOfMeasure;
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly bleedMm?: string;
  readonly safeMarginMm?: string;
  readonly trackInventory: boolean;
  readonly stockOnHand: number;
  readonly stockReserved?: number;
  readonly lowStockThreshold: number;
  readonly reorderQuantity?: number;
  readonly leadTimeDays: number;
  readonly tags: readonly string[];
  readonly options?: readonly { name: string; values: readonly string[] }[];
  readonly volumeTiers?: readonly { minQuantity: number; discountPercent: string }[];
}

const PRODUCTS: readonly SeedProduct[] = [
  {
    sku: 'SGN-YARD-CORO-1824',
    name: 'Corrugated Yard & Lawn Signs (18" x 24")',
    description:
      'Weatherproof 4mm corrugated fluted plastic yard signs. Full-colour UV direct print with metal H-wire ground stakes included.',
    categoryCode: 'SIGNS',
    basePrice: '65.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 5,
    uom: 'PACK',
    widthMm: 610,
    heightMm: 457,
    bleedMm: '3',
    safeMarginMm: '5',
    trackInventory: true,
    stockOnHand: 240,
    stockReserved: 15,
    lowStockThreshold: 40,
    reorderQuantity: 200,
    leadTimeDays: 2,
    tags: ['signs', 'outdoor', 'personalisable'],
    options: [
      { name: 'Size', values: ['18" x 24"', '24" x 36"'] },
      { name: 'Material', values: ['4mm Corrugated', '3mm Aluminium Composite'] },
      { name: 'Finish', values: ['Matte', 'Gloss UV'] },
    ],
    volumeTiers: [
      { minQuantity: 10, discountPercent: '5.00' },
      { minQuantity: 25, discountPercent: '10.00' },
      { minQuantity: 50, discountPercent: '15.00' },
    ],
  },
  {
    sku: 'BAN-ROLLUP-3380',
    name: 'Retractable Pull-Up Banner Stand (33" x 80")',
    description:
      'Premium aluminium retractable stand with a printed vinyl graphic and padded carry bag. Replacement graphics available separately.',
    categoryCode: 'BANNERS',
    basePrice: '149.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 1,
    uom: 'EACH',
    widthMm: 838,
    heightMm: 2032,
    bleedMm: '5',
    safeMarginMm: '10',
    trackInventory: true,
    stockOnHand: 62,
    stockReserved: 4,
    lowStockThreshold: 12,
    reorderQuantity: 50,
    leadTimeDays: 3,
    tags: ['banners', 'displays', 'personalisable'],
    options: [
      { name: 'Size', values: ['33" x 80"', '39" x 80"'] },
      { name: 'Base', values: ['Standard Aluminium', 'Deluxe Wide-Foot'] },
    ],
    volumeTiers: [
      { minQuantity: 5, discountPercent: '7.50' },
      { minQuantity: 20, discountPercent: '12.50' },
    ],
  },
  {
    sku: 'FLY-TRI-FOLD-1000',
    name: 'Gloss Tri-Fold Promotional Brochure',
    description:
      '150gsm gloss art paper, folded to DL. Full colour both sides, scored and machine-folded.',
    categoryCode: 'FLYERS',
    basePrice: '95.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 250,
    uom: 'PACK',
    widthMm: 297,
    heightMm: 210,
    bleedMm: '3',
    safeMarginMm: '4',
    trackInventory: true,
    stockOnHand: 130,
    lowStockThreshold: 25,
    reorderQuantity: 150,
    leadTimeDays: 2,
    tags: ['flyers', 'brochures', 'personalisable'],
    options: [
      { name: 'Paper', values: ['150gsm Gloss', '170gsm Silk', '250gsm Uncoated'] },
      { name: 'Fold', values: ['Tri-fold', 'Z-fold', 'Bi-fold'] },
    ],
    volumeTiers: [
      { minQuantity: 4, discountPercent: '6.00' },
      { minQuantity: 12, discountPercent: '12.00' },
    ],
  },
  {
    sku: 'CRD-SOFT-TOUCH-500',
    name: 'Executive Soft-Touch Business Cards',
    description:
      '450gsm board with a soft-touch laminate both sides. Boxed in 500s, ready for branch distribution.',
    categoryCode: 'CARDS',
    basePrice: '48.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 500,
    uom: 'BOX',
    widthMm: 90,
    heightMm: 55,
    bleedMm: '3',
    safeMarginMm: '4',
    trackInventory: true,
    stockOnHand: 18,
    stockReserved: 6,
    lowStockThreshold: 20,
    reorderQuantity: 100,
    leadTimeDays: 2,
    tags: ['stationery', 'cards', 'personalisable'],
    options: [
      { name: 'Finish', values: ['Soft-Touch Matte', 'Gloss Laminate', 'Spot UV'] },
      { name: 'Corners', values: ['Square', 'Rounded 3mm'] },
    ],
    volumeTiers: [
      { minQuantity: 5, discountPercent: '8.00' },
      { minQuantity: 15, discountPercent: '14.00' },
    ],
  },
  {
    sku: 'PST-GLOSS-1824',
    name: 'Gloss Indoor Promotional Posters',
    description: '200gsm gloss poster stock for in-store promotional windows and back-of-house.',
    categoryCode: 'SIGNS',
    basePrice: '48.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 25,
    uom: 'PACK',
    widthMm: 420,
    heightMm: 594,
    bleedMm: '3',
    safeMarginMm: '5',
    trackInventory: true,
    stockOnHand: 310,
    lowStockThreshold: 50,
    reorderQuantity: 250,
    leadTimeDays: 3,
    tags: ['posters', 'in-store', 'personalisable'],
    options: [{ name: 'Size', values: ['A2', 'A1', 'A0'] }],
    volumeTiers: [
      { minQuantity: 8, discountPercent: '6.00' },
      { minQuantity: 20, discountPercent: '11.00' },
    ],
  },
  {
    sku: 'BRO-TRI-A4',
    name: 'Tri-Fold Corporate Brochure (A4)',
    description:
      '170gsm silk, A4 folded to DL, with a matt laminate outer. The standard group compliance leaflet.',
    categoryCode: 'FLYERS',
    basePrice: '92.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 100,
    uom: 'PACK',
    widthMm: 297,
    heightMm: 210,
    bleedMm: '3',
    safeMarginMm: '5',
    trackInventory: true,
    stockOnHand: 76,
    lowStockThreshold: 20,
    leadTimeDays: 4,
    tags: ['brochures', 'corporate'],
    volumeTiers: [
      { minQuantity: 5, discountPercent: '5.00' },
      { minQuantity: 15, discountPercent: '10.00' },
    ],
  },
  {
    sku: 'CAT-SADDLE-A4',
    name: 'Full-Colour Product Catalogue (A4, Saddle-Stitched)',
    description:
      '32-page saddle-stitched A4 catalogue, 130gsm silk text with a 250gsm cover. Seasonal range guide.',
    categoryCode: 'CATALOGUES',
    basePrice: '210.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 50,
    uom: 'PACK',
    widthMm: 210,
    heightMm: 297,
    bleedMm: '3',
    safeMarginMm: '6',
    trackInventory: true,
    stockOnHand: 44,
    stockReserved: 8,
    lowStockThreshold: 10,
    leadTimeDays: 7,
    tags: ['catalogues', 'seasonal'],
    options: [{ name: 'Extent', values: ['16pp', '32pp', '48pp'] }],
    volumeTiers: [
      { minQuantity: 3, discountPercent: '5.00' },
      { minQuantity: 10, discountPercent: '12.00' },
    ],
  },
  {
    sku: 'TPL-DESIGN-BASE',
    name: 'Bespoke Template Design Starter',
    description:
      'A studio-built master template for a site team to personalise. Priced per design, print-on-demand — nothing is held in stock.',
    categoryCode: 'TEMPLATES',
    basePrice: '0.00',
    moq: 1,
    orderMultiple: 1,
    packSize: 1,
    uom: 'EACH',
    // Print-on-demand: no shelf to run out of, so stock is not counted.
    trackInventory: false,
    stockOnHand: 0,
    lowStockThreshold: 0,
    leadTimeDays: 1,
    tags: ['templates', 'design', 'personalisable'],
  },
];

export async function seedDevCatalog(prisma: PrismaClient): Promise<void> {
  if (loadConfig().app.isProduction) {
    throw new Error('The development seed refuses to run against a production configuration.');
  }

  const categoryIds = new Map<string, string>();

  for (const category of CATEGORIES) {
    const row = await prisma.productCategory.upsert({
      where: { code: category.code },
      update: {
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        status: 'ACTIVE',
      },
      create: {
        id: createId('cat'),
        code: category.code,
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        status: 'ACTIVE',
      },
    });
    categoryIds.set(category.code, row.id);
  }

  for (const product of PRODUCTS) {
    const categoryId = categoryIds.get(product.categoryCode);
    if (!categoryId) throw new Error(`Unknown category code ${product.categoryCode}`);

    const fields = {
      name: product.name,
      description: product.description,
      categoryId,
      // ACTIVE rather than the DRAFT a real create starts at: a seeded
      // catalogue exists to be browsed, and a draft is invisible to every
      // non-admin caller.
      status: 'ACTIVE' as const,
      visibility: 'ALL_ACCOUNTS' as const,
      basePrice: product.basePrice,
      moq: product.moq,
      orderMultiple: product.orderMultiple,
      packSize: product.packSize,
      uom: product.uom,
      widthMm: product.widthMm ?? null,
      heightMm: product.heightMm ?? null,
      bleedMm: product.bleedMm ?? null,
      safeMarginMm: product.safeMarginMm ?? null,
      trackInventory: product.trackInventory,
      stockOnHand: product.stockOnHand,
      stockReserved: product.stockReserved ?? 0,
      lowStockThreshold: product.lowStockThreshold,
      reorderQuantity: product.reorderQuantity ?? null,
      leadTimeDays: product.leadTimeDays,
      tags: [...product.tags],
      deletedAt: null,
    };

    const row = await prisma.product.upsert({
      where: { sku: product.sku },
      update: fields,
      create: { id: createId('prd'), sku: product.sku, ...fields },
    });

    // Replaced rather than appended: upserting each tier on its own would leave
    // a ladder edited between runs carrying rows this seed no longer defines.
    await prisma.productVolumeTier.deleteMany({ where: { productId: row.id } });
    if (product.volumeTiers?.length) {
      await prisma.productVolumeTier.createMany({
        data: product.volumeTiers.map((tier) => ({
          id: createId('vtr'),
          productId: row.id,
          minQuantity: tier.minQuantity,
          discountPercent: tier.discountPercent,
        })),
      });
    }

    // Variants first, because they reference option values: an option cannot be
    // replaced while a variant depends on one of its values.
    await prisma.productVariant.deleteMany({ where: { productId: row.id } });
    await prisma.productOption.deleteMany({ where: { productId: row.id } });

    if (product.options?.length) {
      await prisma.productOption.createMany({
        data: product.options.map((option, index) => ({
          id: createId('opt'),
          productId: row.id,
          name: option.name,
          values: [...option.values],
          sortOrder: index * 10,
        })),
      });

      // A configurable product with no variant cannot be bought at all — the
      // cart refuses it, because a line with options and no configuration
      // reaches production with nothing saying what to print. So every
      // combination the option axes describe gets one.
      const combinations = expand(product.options);

      await prisma.productVariant.createMany({
        data: combinations.map((attributes, index) => ({
          id: createId('var'),
          productId: row.id,
          sku: variantSku(product.sku, attributes, index),
          attributes,
          // Null: the variant sells at the product's base price. A seeded
          // override would be a made-up number in every price the shop shows.
          priceOverride: null,
          stockOnHand: product.trackInventory
            ? Math.ceil(product.stockOnHand / combinations.length)
            : 0,
          status: 'ACTIVE',
          sortOrder: index * 10,
        })),
      });
    }
  }

  const variantCount = await prisma.productVariant.count({ where: { deletedAt: null } });

  console.log(
    `[seed] catalogue: ${CATEGORIES.length} categories, ${PRODUCTS.length} products ` +
      `(${PRODUCTS.filter((p) => p.trackInventory).length} stock-tracked), ${variantCount} variants`,
  );
}

/** Every combination of the option axes, in the order the axes are declared. */
function expand(
  options: readonly { name: string; values: readonly string[] }[],
): Record<string, string>[] {
  return options.reduce<Record<string, string>[]>(
    (combinations, option) =>
      combinations.flatMap((combination) =>
        option.values.map((value) => ({ ...combination, [option.name]: value })),
      ),
    [{}],
  );
}

/**
 * A stable, readable variant SKU: the product's, plus an initial per chosen
 * value. Uniqueness is global, so the index is appended rather than trusted to
 * the initials, which collide for values like "Matte" and "Matt".
 */
function variantSku(productSku: string, attributes: Record<string, string>, index: number): string {
  const suffix = Object.values(attributes)
    .map((value) =>
      value
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 4)
        .toUpperCase(),
    )
    .join('-');

  return `${productSku}-${suffix || 'STD'}-${index + 1}`;
}
