-- Master artwork templates (SOW FE-13).
--
-- ---------------------------------------------------------------------------
-- Why a template has versions and a product does not
-- ---------------------------------------------------------------------------
-- `templates` holds the *working copy* — what the builder opens and autosaves.
-- `template_versions` holds immutable snapshots, and `templates.publishedVersionId`
-- points at the one the storefront renders.
--
-- A product can be edited in place because an order line already snapshots the
-- price and description it was bought at. Artwork is different: a buyer
-- personalises a layout, and if a designer moves a text box the next morning
-- the personalisation no longer fits anything. So the thing a buyer acts on is
-- frozen the moment it is published, and the designer keeps working on a copy.
--
-- ---------------------------------------------------------------------------
-- No row-level security here, on purpose
-- ---------------------------------------------------------------------------
-- Templates are the platform operator's, like the catalogue they print onto:
-- TEMPLATE_MANAGE is in no customer role. There is no `accountId` to policy on.
-- Reads are bounded by the route's permission and, for RESTRICTED templates, by
-- `template_account_visibility` — exactly the shape `products` uses.
--
-- The one table here that *could* have carried a tenant column is
-- `template_account_visibility`, and it deliberately does not: it is a join
-- whose whole content is an account id, and policying it would mean an account
-- could not be told which templates it may see.

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TemplateVisibility" AS ENUM ('ALL_ACCOUNTS', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "TemplateOrientation" AS ENUM ('LANDSCAPE', 'PORTRAIT', 'SQUARE');

-- CreateEnum
CREATE TYPE "TemplateDimensionUnit" AS ENUM ('IN', 'MM', 'PX');

-- CreateEnum
CREATE TYPE "TemplateAssetKind" AS ENUM ('THUMBNAIL', 'PREVIEW', 'SOURCE');

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "productId" TEXT,
    "categoryId" TEXT,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "TemplateVisibility" NOT NULL DEFAULT 'ALL_ACCOUNTS',
    "theme" TEXT,
    "orientation" "TemplateOrientation" NOT NULL DEFAULT 'PORTRAIT',
    "aspectRatio" TEXT,
    "widthValue" DECIMAL(10,3) NOT NULL,
    "heightValue" DECIMAL(10,3) NOT NULL,
    "dimensionUnit" "TemplateDimensionUnit" NOT NULL DEFAULT 'IN',
    "bleedMargin" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "safeMargin" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "canvasConfig" JSONB NOT NULL,
    "layers" JSONB NOT NULL,
    "design" JSONB,
    "canvasJson" TEXT,
    "thumbnailAssetId" TEXT,
    "previewAssetId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedVersionId" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdByName" TEXT,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "label" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_assets" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "kind" "TemplateAssetKind" NOT NULL DEFAULT 'SOURCE',
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "altText" TEXT,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "derivativeStatus" "DerivativeStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "thumbnailKey" TEXT,
    "previewKey" TEXT,
    "derivativeError" TEXT,
    "damDocumentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_account_visibility" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_account_visibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "templates_code_key" ON "templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "templates_thumbnailAssetId_key" ON "templates"("thumbnailAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "templates_previewAssetId_key" ON "templates"("previewAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "templates_publishedVersionId_key" ON "templates"("publishedVersionId");

-- CreateIndex
CREATE INDEX "templates_status_visibility_deletedAt_idx" ON "templates"("status", "visibility", "deletedAt");

-- CreateIndex
CREATE INDEX "templates_categoryId_idx" ON "templates"("categoryId");

-- CreateIndex
CREATE INDEX "templates_productId_idx" ON "templates"("productId");

-- CreateIndex
CREATE INDEX "template_versions_templateId_createdAt_idx" ON "template_versions"("templateId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_templateId_version_key" ON "template_versions"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "template_assets_storageKey_key" ON "template_assets"("storageKey");

-- CreateIndex
CREATE INDEX "template_assets_templateId_kind_idx" ON "template_assets"("templateId", "kind");

-- CreateIndex
CREATE INDEX "template_account_visibility_accountId_idx" ON "template_account_visibility"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "template_account_visibility_templateId_accountId_key" ON "template_account_visibility"("templateId", "accountId");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "template_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_previewAssetId_fkey" FOREIGN KEY ("previewAssetId") REFERENCES "template_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_assets" ADD CONSTRAINT "template_assets_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_account_visibility" ADD CONSTRAINT "template_account_visibility_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_account_visibility" ADD CONSTRAINT "template_account_visibility_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants the schema language cannot express
-- ---------------------------------------------------------------------------

-- A published template must have something to publish. Without this a bad
-- transition leaves a template that the storefront lists and then cannot
-- render, and the failure surfaces to a buyer rather than to the operator who
-- caused it.
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_published_has_version"
  CHECK ("status" <> 'PUBLISHED' OR "publishedVersionId" IS NOT NULL);

-- Archiving does *not* clear the pointer — an order personalised from a version
-- must still resolve it — so the check above is deliberately one-directional.

-- A canvas with no area is not a canvas. Zero would divide by zero in every
-- aspect-ratio calculation downstream; negative is meaningless.
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_dimensions_positive"
  CHECK ("widthValue" > 0 AND "heightValue" > 0);

-- Margins may be zero — a full-bleed sticker has no safe area to speak of —
-- but never negative.
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_margins_not_negative"
  CHECK ("bleedMargin" >= 0 AND "safeMargin" >= 0);

-- Versions are counted from one. A zeroth version would sort ahead of the first
-- real one in every history view.
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "template_versions"
  ADD CONSTRAINT "template_versions_version_positive"
  CHECK ("version" >= 1);

-- An asset row that claims a file has to say how big the file is. A zero-byte
-- upload is a failed upload, and recording it as an asset is how a listing
-- renders a broken tile with nothing to explain it.
ALTER TABLE "template_assets"
  ADD CONSTRAINT "template_assets_size_positive"
  CHECK ("sizeBytes" > 0);
