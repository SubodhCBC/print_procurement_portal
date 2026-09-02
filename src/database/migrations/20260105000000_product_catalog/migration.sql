-- The product catalog (SOW BE-03).
--
-- ---------------------------------------------------------------------------
-- Global, not tenant-owned
-- ---------------------------------------------------------------------------
-- None of these tables carries an accountId, and only one of them gets an RLS
-- policy. The catalog belongs to the platform operator: SOW section 1 gives the
-- system administrator "complete control over global catalog", and BE-04 makes
-- per-customer pricing and visibility a rate-card concern rather than a
-- data-ownership one.
--
-- The exception is product_account_visibility, which exists precisely to say
-- "this account may see this restricted product". That one is tenant-owned and
-- is policied below — without it a head-office user could read the table and
-- learn which other customers hold the same contract-specific line.
--
-- Everything else is filtered in application code, in one place
-- (visibilityFilter() in products.service.ts). A bug there shows a restricted
-- product to the wrong customer; it cannot leak another customer's data,
-- because there is none in these tables.
--
-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- pg_trgm is already installed (20260101000000_init_extensions). The catalog
-- search is ILIKE '%term%' over name and sku, which no B-tree can serve, so two
-- GIN trigram indexes are added at the end of this migration by hand — Prisma
-- cannot express them.

-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'UNAVAILABLE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ProductVisibility" AS ENUM ('ALL_ACCOUNTS', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('EACH', 'PACK', 'BOX', 'ROLL', 'SET', 'SQUARE_METRE');

-- CreateEnum
CREATE TYPE "ProductAssetKind" AS ENUM ('IMAGE', 'ARTWORK', 'SPEC_SHEET');

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "categoryId" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "ProductVisibility" NOT NULL DEFAULT 'ALL_ACCOUNTS',
    "basePrice" DECIMAL(12,2) NOT NULL,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "orderMultiple" INTEGER NOT NULL DEFAULT 1,
    "packSize" INTEGER NOT NULL DEFAULT 1,
    "uom" "UnitOfMeasure" NOT NULL DEFAULT 'EACH',
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "depthMm" INTEGER,
    "weightGrams" INTEGER,
    "bleedMm" DECIMAL(5,2),
    "safeMarginMm" DECIMAL(5,2),
    "trackInventory" BOOLEAN NOT NULL DEFAULT true,
    "stockOnHand" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER,
    "supersededById" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_options" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "values" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "priceOverride" DECIMAL(12,2),
    "stockOnHand" INTEGER NOT NULL DEFAULT 0,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_volume_tiers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_volume_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_assets" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" "ProductAssetKind" NOT NULL DEFAULT 'IMAGE',
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "altText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_account_visibility" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_account_visibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_code_key" ON "product_categories"("code");

-- CreateIndex
CREATE INDEX "product_categories_status_sortOrder_idx" ON "product_categories"("status", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_categoryId_status_idx" ON "products"("categoryId", "status");

-- CreateIndex
CREATE INDEX "products_status_name_idx" ON "products"("status", "name");

-- CreateIndex
CREATE INDEX "products_visibility_idx" ON "products"("visibility");

-- CreateIndex
CREATE INDEX "product_options_productId_sortOrder_idx" ON "product_options"("productId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "product_options_productId_name_key" ON "product_options"("productId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "product_variants_productId_status_idx" ON "product_variants"("productId", "status");

-- CreateIndex
CREATE INDEX "product_volume_tiers_productId_minQuantity_idx" ON "product_volume_tiers"("productId", "minQuantity");

-- CreateIndex
CREATE UNIQUE INDEX "product_volume_tiers_productId_minQuantity_key" ON "product_volume_tiers"("productId", "minQuantity");

-- CreateIndex
CREATE UNIQUE INDEX "product_assets_storageKey_key" ON "product_assets"("storageKey");

-- CreateIndex
CREATE INDEX "product_assets_productId_kind_sortOrder_idx" ON "product_assets"("productId", "kind", "sortOrder");

-- CreateIndex
CREATE INDEX "product_account_visibility_accountId_idx" ON "product_account_visibility"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "product_account_visibility_productId_accountId_key" ON "product_account_visibility"("productId", "accountId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_volume_tiers" ADD CONSTRAINT "product_volume_tiers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_assets" ADD CONSTRAINT "product_assets_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_account_visibility" ADD CONSTRAINT "product_account_visibility_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_account_visibility" ADD CONSTRAINT "product_account_visibility_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- One tenant-owned table in this migration. See
-- 20260103000100_row_level_security for how the policies work and why they are
-- attached to the unprivileged ticketit_app role rather than FORCEd.
ALTER TABLE "product_account_visibility" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_account_visibility_tenant_isolation" ON "product_account_visibility"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

-- ---------------------------------------------------------------------------
-- Catalog search
-- ---------------------------------------------------------------------------
--
-- Trigram indexes for the catalogue search box, which is a substring match on
-- name and SKU. `ILIKE '%banner%'` cannot use a B-tree at all — it degrades to a
-- sequential scan the moment the catalog is bigger than a demo — and these are
-- what keep it index-backed.
CREATE INDEX "products_name_trgm_idx" ON "products" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "products_sku_trgm_idx" ON "products" USING GIN ("sku" gin_trgm_ops);
