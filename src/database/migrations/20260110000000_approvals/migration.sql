-- Hierarchical approval workflow (SOW BE-07).
--
-- ---------------------------------------------------------------------------
-- Rules are conditions, not a workflow
-- ---------------------------------------------------------------------------
-- Each rule says "when an order looks like this, someone at tier N must approve
-- it". Several can match one order; their tiers are collected, sorted and
-- walked in turn. That is deliberately simpler than a graph, because a
-- customer's finance policy is a list of thresholds and exceptions rather than
-- a flowchart — and a graph would let an administrator build an unreachable
-- state that nobody notices until an order is stuck in it.
--
-- A rule with no conditions matches every order, which is how "everything needs
-- head-office sign-off" is expressed.
--
-- ---------------------------------------------------------------------------
-- Steps snapshot their rule
-- ---------------------------------------------------------------------------
-- A step copies the approver its rule named. Retiring or editing a rule must
-- not rewrite who a past decision was addressed to, and `ruleId` is nullable so
-- a rule can be deleted without erasing the history of what it once required.
--
-- ---------------------------------------------------------------------------
-- Resubmission starts a fresh request
-- ---------------------------------------------------------------------------
-- When an approver asks for changes the request stops at CHANGES_REQUESTED and
-- is never resumed: the order it was deciding on no longer exists in that form,
-- and a tier-two approver who already said yes to a $900 order must not find
-- themselves having approved the $9,000 one it became.

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalStepStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "approval_rules" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "minTotal" DECIMAL(12,2),
    "categoryId" TEXT,
    "requesterRole" "PortalRole",
    "siteId" TEXT,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "approverRole" "PortalRole",
    "approverUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "approval_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "currentTier" INTEGER NOT NULL DEFAULT 1,
    "totalAtRequest" DECIMAL(12,2) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "ruleId" TEXT,
    "tier" INTEGER NOT NULL,
    "approverRole" "PortalRole",
    "approverUserId" TEXT,
    "status" "ApprovalStepStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "comment" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_rules_accountId_active_tier_idx" ON "approval_rules"("accountId", "active", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_orderId_key" ON "approval_requests"("orderId");

-- CreateIndex
CREATE INDEX "approval_requests_accountId_status_currentTier_idx" ON "approval_requests"("accountId", "status", "currentTier");

-- CreateIndex
CREATE INDEX "approval_steps_requestId_tier_idx" ON "approval_steps"("requestId", "tier");

-- CreateIndex
CREATE INDEX "approval_steps_approverUserId_status_idx" ON "approval_steps"("approverUserId", "status");

-- AddForeignKey
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "approval_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Value constraints
-- ---------------------------------------------------------------------------

-- A rule that names no approver would strand every order it matched, with
-- nobody able to decide and no error to say why. Refused at the database, not
-- only in the DTO, because the rules table is exactly the kind of thing that
-- gets seeded by a migration or fixed by hand.
ALTER TABLE "approval_rules"
  ADD CONSTRAINT "approval_rules_has_an_approver"
  CHECK (num_nonnulls("approverRole", "approverUserId") = 1);

-- Tiers are walked lowest first and must be positive; tier 0 would sort ahead
-- of the first round and open before the request existed.
ALTER TABLE "approval_rules"
  ADD CONSTRAINT "approval_rules_tier_positive"
  CHECK ("tier" >= 1);

ALTER TABLE "approval_rules"
  ADD CONSTRAINT "approval_rules_min_total_non_negative"
  CHECK ("minTotal" IS NULL OR "minTotal" >= 0);

ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_tier_positive"
  CHECK ("tier" >= 1);

-- Same rule as on the order: a decision that refuses must say why.
ALTER TABLE "approval_steps"
  ADD CONSTRAINT "approval_steps_refusal_has_comment"
  CHECK ("status" NOT IN ('REJECTED', 'CHANGES_REQUESTED') OR "comment" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- Rules and requests are tenant-owned. Steps carry no accountId and are reached
-- through their request, the same shape as every other child table here.
--
-- Which approver may act on a step is not a tenant question and is not
-- expressible in a policy — it depends on the actor's role and on per-user
-- grants. ApprovalService decides it.

ALTER TABLE "approval_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_rules_tenant_isolation" ON "approval_rules"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_requests_tenant_isolation" ON "approval_requests"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "approval_steps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_steps_tenant_isolation" ON "approval_steps"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "approval_requests" r
      WHERE r."id" = "approval_steps"."requestId"
        AND r."accountId" = app_current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "approval_requests" r
      WHERE r."id" = "approval_steps"."requestId"
        AND r."accountId" = app_current_account_id()
    )
  );
