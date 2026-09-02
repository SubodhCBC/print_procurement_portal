-- Rate cards: negotiated per-account pricing (SOW BE-04).
--
-- ---------------------------------------------------------------------------
-- Why these tables are tenant-owned when the catalog is not
-- ---------------------------------------------------------------------------
-- The product catalog is global and deliberately outside RLS: it belongs to the
-- platform operator. A rate card is the opposite — it is one customer's
-- negotiated contract, and one account reading another's is precisely the
-- disclosure Row-Level Security exists to prevent. So `rate_cards` carries an
-- accountId and a policy, and the two child tables are policied through it.
--
-- The children are reached by an EXISTS subquery rather than by copying
-- accountId down into them. A denormalised copy can disagree with its parent,
-- and a tenant boundary that can drift is not a boundary. The subquery is a
-- primary-key lookup; a rate card has tens of items, not millions.
--
-- ---------------------------------------------------------------------------
-- Why the overlap rule is a constraint and not a service check
-- ---------------------------------------------------------------------------
-- At most one card may be ACTIVE for an account at any instant, or the price a
-- customer pays is ambiguous. A check in the service would pass for both of two
-- administrators activating two cards in the same second, and the account would
-- end up with two live contracts and no defined winner. An EXCLUDE constraint
-- makes that unrepresentable, and needs btree_gist to mix the equality column
-- (accountId) with the range one (the effective window).

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "RateCardStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "status" "RateCardStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(3),
    "defaultDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_items" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fixedPrice" DECIMAL(12,2),
    "discountPercent" DECIMAL(5,2),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_card_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_tiers" (
    "id" TEXT NOT NULL,
    "rateCardItemId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_card_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_cards_accountId_status_effectiveFrom_idx" ON "rate_cards"("accountId", "status", "effectiveFrom");

-- CreateIndex
CREATE INDEX "rate_cards_status_effectiveTo_idx" ON "rate_cards"("status", "effectiveTo");

-- CreateIndex
CREATE INDEX "rate_card_items_productId_idx" ON "rate_card_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_items_rateCardId_productId_key" ON "rate_card_items"("rateCardId", "productId");

-- CreateIndex
CREATE INDEX "rate_card_tiers_rateCardItemId_minQuantity_idx" ON "rate_card_tiers"("rateCardItemId", "minQuantity");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_tiers_rateCardItemId_minQuantity_key" ON "rate_card_tiers"("rateCardItemId", "minQuantity");

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_items" ADD CONSTRAINT "rate_card_items_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_items" ADD CONSTRAINT "rate_card_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_tiers" ADD CONSTRAINT "rate_card_tiers_rateCardItemId_fkey" FOREIGN KEY ("rateCardItemId") REFERENCES "rate_card_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One live contract per customer
-- ---------------------------------------------------------------------------
--
-- `[)` — lower bound inclusive, upper exclusive — so a card that ends on the
-- 1st and one that starts on the 1st are not both in force for that instant.
-- A NULL upper bound is an unbounded range, which is what "open-ended" means.
--
-- DRAFT and ARCHIVED cards are exempt: several drafts may be under negotiation
-- at once, and the archive is a history that necessarily overlaps itself.
ALTER TABLE "rate_cards"
  ADD CONSTRAINT "rate_cards_no_overlapping_active"
  EXCLUDE USING gist (
    "accountId" WITH =,
    tstzrange("effectiveFrom", "effectiveTo", '[)') WITH &&
  )
  WHERE ("status" = 'ACTIVE' AND "deletedAt" IS NULL);

-- ---------------------------------------------------------------------------
-- Value constraints
-- ---------------------------------------------------------------------------
--
-- Restated here rather than left to Zod. The DTOs are the first line, but the
-- importer, a future admin script and a hand-run UPDATE all reach these tables
-- without passing through a controller, and a negative price or a 150% discount
-- reaching an invoice is not a bug anyone wants to find from a customer.

ALTER TABLE "rate_cards"
  ADD CONSTRAINT "rate_cards_window_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

ALTER TABLE "rate_cards"
  ADD CONSTRAINT "rate_cards_default_discount_range"
  CHECK ("defaultDiscountPercent" >= 0 AND "defaultDiscountPercent" <= 100);

-- Exactly one pricing rule per item, or neither. Both at once would need a
-- precedence rule that nobody reading the signed contract could predict, so it
-- is refused rather than resolved.
ALTER TABLE "rate_card_items"
  ADD CONSTRAINT "rate_card_items_one_pricing_rule"
  CHECK (num_nonnulls("fixedPrice", "discountPercent") <= 1);

ALTER TABLE "rate_card_items"
  ADD CONSTRAINT "rate_card_items_fixed_price_non_negative"
  CHECK ("fixedPrice" IS NULL OR "fixedPrice" >= 0);

ALTER TABLE "rate_card_items"
  ADD CONSTRAINT "rate_card_items_discount_range"
  CHECK ("discountPercent" IS NULL OR ("discountPercent" >= 0 AND "discountPercent" <= 100));

ALTER TABLE "rate_card_tiers"
  ADD CONSTRAINT "rate_card_tiers_min_quantity_positive"
  CHECK ("minQuantity" >= 1);

ALTER TABLE "rate_card_tiers"
  ADD CONSTRAINT "rate_card_tiers_discount_range"
  CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- Same shape as every other tenant-owned table: one permissive policy covering
-- ALL commands, with WITH CHECK stated as well as USING so a write cannot place
-- a row in another account either.
--
-- Administration is cross-tenant by nature — listing every customer's rate
-- cards is what the pricing admin screen does — and, as with `accounts`, those
-- reads run outside `withTenantScope` and are gated by PRICING_MANAGE, which no
-- customer role holds. Everything scoped to a single account still opens that
-- account's scope, so RLS covers the ordinary path.

ALTER TABLE "rate_cards" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rate_cards_tenant_isolation" ON "rate_cards"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

-- Reached through the parent rather than through a copied accountId: a
-- denormalised tenant column can drift from the row that owns it, and a
-- boundary that can drift is not a boundary.
ALTER TABLE "rate_card_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rate_card_items_tenant_isolation" ON "rate_card_items"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "rate_cards" c
      WHERE c."id" = "rate_card_items"."rateCardId"
        AND c."accountId" = app_current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "rate_cards" c
      WHERE c."id" = "rate_card_items"."rateCardId"
        AND c."accountId" = app_current_account_id()
    )
  );

ALTER TABLE "rate_card_tiers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rate_card_tiers_tenant_isolation" ON "rate_card_tiers"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM "rate_card_items" i
      JOIN "rate_cards" c ON c."id" = i."rateCardId"
      WHERE i."id" = "rate_card_tiers"."rateCardItemId"
        AND c."accountId" = app_current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "rate_card_items" i
      JOIN "rate_cards" c ON c."id" = i."rateCardId"
      WHERE i."id" = "rate_card_tiers"."rateCardItemId"
        AND c."accountId" = app_current_account_id()
    )
  );
