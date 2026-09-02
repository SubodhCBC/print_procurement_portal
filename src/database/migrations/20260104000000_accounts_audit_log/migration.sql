-- Account administration and the immutable audit log.
--
-- Two things, and they belong together because the audit log is what makes the
-- first one accountable: every account change is recorded by the same service
-- that will record product, pricing and order changes when those modules land.
--
-- Adding the audit log now rather than alongside orders is deliberate. SOW
-- BE-06 requires it on *every* entity mutation, and a cross-cutting concern
-- retrofitted after the mutations exist has to be threaded back through every
-- service by hand — which is exactly how the Row-Level Security gap happened.
--
-- Accounts grow the fields the admin portal needs: a customer-facing code, a
-- status, contact details, the approval threshold that drives SOW BE-07, and
-- account-wide purchase-order defaults that a site may override.
--
-- Authored with `prisma migrate diff` so it can be reviewed as SQL, then
-- amended for the accountCode backfill and the RLS policy. Applied with
-- `npm run db:deploy`.

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('ACCOUNT', 'SITE', 'USER', 'INVITATION', 'PERMISSION', 'PRODUCT', 'RATE_CARD', 'ORDER', 'TEMPLATE', 'INTEGRATION', 'SYSTEM');

-- AlterTable: accounts
--
-- `legacyClient` becomes nullable because an account can now be created here
-- rather than derived from a legacy `Users.Client` value.
ALTER TABLE "accounts" ADD COLUMN     "approvalThreshold" DECIMAL(12,2),
ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "poPrefix" TEXT,
ADD COLUMN     "requirePoNumber" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
ALTER COLUMN "legacyClient" DROP NOT NULL;

-- accountCode is added in three steps rather than as a bare NOT NULL column,
-- which would fail against any table that already has rows. Accounts created
-- before this migration were auto-provisioned from a legacy login and have no
-- customer-facing code, so the slug — already unique, already derived from the
-- client name — is the only sensible seed. Uppercasing preserves uniqueness
-- because a slug is only [a-z0-9-].
ALTER TABLE "accounts" ADD COLUMN "accountCode" TEXT;
UPDATE "accounts" SET "accountCode" = UPPER("slug") WHERE "accountCode" IS NULL;
ALTER TABLE "accounts" ALTER COLUMN "accountCode" SET NOT NULL;

-- AlterTable: users
--
-- SOW BE-02 requires a spend cap per user as well as per site: a branch budget
-- is not a purchasing limit for each person able to spend it.
ALTER TABLE "users" ADD COLUMN     "department" TEXT,
ADD COLUMN     "monthlyBudgetCap" DECIMAL(12,2),
ADD COLUMN     "poPrefix" TEXT;

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" "AuditEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- All three lead with accountId because every read is tenant-scoped and the RLS
-- policy filters on it, so an index that does not start there cannot serve the
-- policy's predicate. DESC on createdAt matches the only order the log is ever
-- read in: newest first.
CREATE INDEX "audit_log_entries_accountId_createdAt_idx" ON "audit_log_entries"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entries_accountId_entityType_entityId_idx" ON "audit_log_entries"("accountId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_entries_accountId_actorId_createdAt_idx" ON "audit_log_entries"("accountId", "actorId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_accountCode_key" ON "accounts"("accountCode");

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
--
-- SET NULL rather than CASCADE: an audit entry must outlive its actor. The
-- actor's name, email and role are copied onto the row for exactly this reason.
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- Every new tenant-owned table needs its own policy. See
-- 20260103000100_row_level_security for how this works and why the policies are
-- attached to the unprivileged ticketit_app role rather than FORCEd.
ALTER TABLE "audit_log_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_entries_tenant_isolation" ON "audit_log_entries"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());
