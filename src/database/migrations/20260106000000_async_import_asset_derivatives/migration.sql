-- Asynchronous catalogue import, and image derivatives for product assets.
--
-- Two loose ends from the catalogue module (BE-03), closed together because
-- both are the same shape: work too slow to do inside a request, moved onto a
-- queue with a row to poll.
--
-- ---------------------------------------------------------------------------
-- catalog_import_jobs
-- ---------------------------------------------------------------------------
-- The submitted rows live in `payload` here rather than in the queue job.
-- BullMQ keeps job data in Redis and retains completed jobs for a day, and a
-- ten-thousand-row spreadsheet has no business sitting there. The queue message
-- carries the job id and nothing else — the general rule for anything bulky.
--
-- Tenant-owned and policied: the catalogue it writes to is global, but the
-- record of who loaded what is not, and an operator should see their own
-- imports rather than everyone's.
--
-- ---------------------------------------------------------------------------
-- product_assets derivatives
-- ---------------------------------------------------------------------------
-- Two resized copies per image — a grid thumbnail and a detail preview — and
-- the intrinsic pixel size so the front end can reserve the right box before
-- the image loads. The original is never touched: a derivative must never
-- become the source of truth for artwork that goes to print.
--
-- `derivativeStatus` defaults to NOT_APPLICABLE, which is correct for every
-- existing row: ARTWORK and SPEC_SHEET assets have no derivatives, and the
-- IMAGE assets that predate this migration are back-filled to PENDING below so
-- the sweep picks them up.

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DerivativeStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "product_assets" ADD COLUMN     "derivativeError" TEXT,
ADD COLUMN     "derivativeStatus" "DerivativeStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "heightPx" INTEGER,
ADD COLUMN     "previewKey" TEXT,
ADD COLUMN     "thumbnailKey" TEXT,
ADD COLUMN     "widthPx" INTEGER;

-- CreateTable
CREATE TABLE "catalog_import_jobs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "requestedById" TEXT,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "updateExisting" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_import_jobs_accountId_createdAt_idx" ON "catalog_import_jobs"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "catalog_import_jobs_status_idx" ON "catalog_import_jobs"("status");

-- CreateIndex
CREATE INDEX "product_assets_derivativeStatus_idx" ON "product_assets"("derivativeStatus");

-- AddForeignKey
ALTER TABLE "catalog_import_jobs" ADD CONSTRAINT "catalog_import_jobs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_import_jobs" ADD CONSTRAINT "catalog_import_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "products_name_trgm_idx" RENAME TO "products_name_idx";

-- RenameIndex
ALTER INDEX "products_sku_trgm_idx" RENAME TO "products_sku_idx";


-- Existing images join the queue. Without this back-fill they would keep
-- NOT_APPLICABLE for ever and never get a thumbnail, because the derivative job
-- is only enqueued when an asset is attached.
UPDATE "product_assets"
SET "derivativeStatus" = 'PENDING'
WHERE "kind" = 'IMAGE';

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- See 20260103000100_row_level_security for how the policies work and why they
-- attach to the unprivileged ticketit_app role rather than being FORCEd.
ALTER TABLE "catalog_import_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "catalog_import_jobs_tenant_isolation" ON "catalog_import_jobs"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());
