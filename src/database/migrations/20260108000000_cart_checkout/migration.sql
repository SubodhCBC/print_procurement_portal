-- Cart and checkout validation (SOW BE-05).
--
-- ---------------------------------------------------------------------------
-- Why the cart stores no prices
-- ---------------------------------------------------------------------------
-- A basket is re-priced on every read, through the same PricingService the
-- product grid uses. A rate card can be activated, corrected or expire between
-- adding a line and paying for it, and a price stored on the line would be a
-- quote the system had silently stopped honouring — discovered by the customer
-- when the invoice disagrees with what they saw.
--
-- Prices are snapshotted exactly once: onto the order line, at the moment BE-06
-- turns a cart into an order. That is the point at which the number becomes a
-- commitment, and the only point at which it should stop moving.
--
-- ---------------------------------------------------------------------------
-- Why quantities are stored as typed, not as rounded
-- ---------------------------------------------------------------------------
-- A product sold in multiples of 500 with an MOQ of 500 cannot be bought at
-- 120. The cart keeps the 120 and reports the adjustment at validation, rather
-- than writing 500 in and letting the buyer discover it on the invoice.
-- Silently shipping four times what someone asked for is the worse failure.

-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('OPEN', 'CHECKED_OUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('NET_30_INVOICE', 'P_CARD', 'ACH');

-- CreateTable
CREATE TABLE "carts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteId" TEXT,
    "status" "CartStatus" NOT NULL DEFAULT 'OPEN',
    "poNumber" TEXT,
    "campaignCode" TEXT,
    "notes" TEXT,
    "requestedDeliveryDate" TIMESTAMPTZ(3),
    "shippingAddressId" TEXT,
    "billingAddressId" TEXT,
    "paymentMethod" "PaymentMethod",
    "termsAcceptedAt" TIMESTAMPTZ(3),
    "checkedOutAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_lines" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "customisation" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carts_accountId_userId_status_idx" ON "carts"("accountId", "userId", "status");

-- CreateIndex
CREATE INDEX "carts_accountId_siteId_status_idx" ON "carts"("accountId", "siteId", "status");

-- CreateIndex
CREATE INDEX "cart_lines_cartId_idx" ON "cart_lines"("cartId");

-- CreateIndex
CREATE INDEX "cart_lines_productId_idx" ON "cart_lines"("productId");

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_shippingAddressId_fkey" FOREIGN KEY ("shippingAddressId") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_billingAddressId_fkey" FOREIGN KEY ("billingAddressId") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One open basket per user per branch
-- ---------------------------------------------------------------------------
--
-- A head-office buyer ordering for three branches keeps three baskets, because
-- the branch decides the budget, the purchase-order rule and the delivery
-- address. Two open baskets for the *same* branch is a different thing: it is
-- the double-submit that leaves half an order behind, and the second tab
-- quietly overwriting the first.
--
-- NULLS NOT DISTINCT because `siteId` is nullable while a head-office user has
-- not picked a branch yet. Without it, PostgreSQL treats every NULL as unique
-- and a user could accumulate unlimited unbranched baskets — exactly the state
-- this index exists to prevent.
CREATE UNIQUE INDEX "carts_one_open_per_user_site"
  ON "carts" ("userId", "siteId")
  NULLS NOT DISTINCT
  WHERE ("status" = 'OPEN');

-- ---------------------------------------------------------------------------
-- Value constraints
-- ---------------------------------------------------------------------------
--
-- The DTO rejects these first, but the cart is also written by the service's
-- merge path and will later be written by re-order (FE-05), neither of which
-- passes through the add-to-cart schema.

-- Zero is not "remove the line" — removal is a DELETE. A zero-quantity line
-- would price at zero and ship nothing.
ALTER TABLE "cart_lines"
  ADD CONSTRAINT "cart_lines_quantity_positive"
  CHECK ("quantity" >= 1);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- Baskets are tenant-owned. `cart_lines` carries no accountId and is reached
-- through its parent, the same shape as `rate_card_items`: a denormalised
-- tenant column can drift from the row that owns it, and a boundary that can
-- drift is not a boundary.
--
-- Note this is tenant isolation, not per-user isolation. RLS cannot express
-- "only this user's basket" because the tenant scope carries an account, not a
-- user. Whose basket a request may touch is decided in CartService, which
-- resolves the cart from the authenticated user rather than from a path
-- parameter — so there is no id for one colleague to guess another's with.

ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "carts_tenant_isolation" ON "carts"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "cart_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cart_lines_tenant_isolation" ON "cart_lines"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "carts" c
      WHERE c."id" = "cart_lines"."cartId"
        AND c."accountId" = app_current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "carts" c
      WHERE c."id" = "cart_lines"."cartId"
        AND c."accountId" = app_current_account_id()
    )
  );
