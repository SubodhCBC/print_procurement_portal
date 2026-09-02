-- Orders (SOW BE-06), and the committed-spend input the cart's budget check
-- has been waiting for.
--
-- ---------------------------------------------------------------------------
-- Two status axes
-- ---------------------------------------------------------------------------
-- `status` is where an order is in fulfilment; `paymentStatus` is whether it has
-- been paid. The statement of work lists "Paid" among the lifecycle states, but
-- folding it in would make DISPATCHED and PAID mutually exclusive — and on Net
-- 30 terms, which is how most of this trade works, an order is routinely
-- delivered a month before it is paid. One axis makes that unrepresentable.
--
-- ---------------------------------------------------------------------------
-- Everything is a snapshot
-- ---------------------------------------------------------------------------
-- The cart deliberately stores no prices, because a rate card can move between
-- adding a line and paying for it. An order is the opposite: at placement every
-- number stops moving. Line items carry their own price, the discount that
-- produced it and the rule it came from; the delivery address is copied as JSON
-- as well as referenced. Re-pricing or re-addressing a historical order is
-- impossible by construction rather than by convention.
--
-- ---------------------------------------------------------------------------
-- What is not modelled yet
-- ---------------------------------------------------------------------------
-- There is no tax column. `total` equals `subtotal` today. GST/VAT treatment
-- depends on the customer's registration and on which jurisdictions the
-- platform will invoice from, neither of which is settled — and a tax field
-- filled with zeroes is worse than an absent one, because downstream code
-- starts trusting it. BE-09 adds it with the invoice engine.
--
-- Stock is not reserved here either. SOW BE-12 owns reservation on placement
-- and release on rejection; until then an order records what was asked for and
-- the stock check at checkout is advisory.

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'PROCESSING', 'DISPATCHED', 'DELIVERED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAYMENT_PENDING', 'PAID', 'REFUNDED');

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "placedById" TEXT NOT NULL,
    "placedByName" TEXT NOT NULL,
    "placedByEmail" TEXT NOT NULL,
    "cartId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "paymentMethod" "PaymentMethod",
    "paymentReference" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "poNumber" TEXT,
    "campaignCode" TEXT,
    "projectCode" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "changeRequestNote" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "catalogSubtotal" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "rateCardId" TEXT,
    "rateCardName" TEXT,
    "billingPeriod" TEXT NOT NULL,
    "shippingAddressId" TEXT,
    "shippingSnapshot" JSONB NOT NULL,
    "recipientName" TEXT,
    "recipientPhone" TEXT,
    "recipientEmail" TEXT,
    "requestedDeliveryDate" TIMESTAMPTZ(3),
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "deliveryNotes" TEXT,
    "dispatchedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "notes" TEXT,
    "termsAcceptedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variantSku" TEXT,
    "uom" "UnitOfMeasure" NOT NULL,
    "packSize" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "catalogUnitPrice" DECIMAL(12,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "priceSource" TEXT NOT NULL,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "bleedMm" DECIMAL(5,2),
    "safeMarginMm" DECIMAL(5,2),
    "customisation" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "actorRole" "PortalRole" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_cartId_key" ON "orders"("cartId");

-- CreateIndex
CREATE INDEX "orders_accountId_createdAt_idx" ON "orders"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_accountId_siteId_createdAt_idx" ON "orders"("accountId", "siteId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_accountId_status_idx" ON "orders"("accountId", "status");

-- CreateIndex
CREATE INDEX "orders_accountId_placedById_createdAt_idx" ON "orders"("accountId", "placedById", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_siteId_billingPeriod_status_idx" ON "orders"("siteId", "billingPeriod", "status");

-- CreateIndex
CREATE INDEX "orders_status_requiresApproval_idx" ON "orders"("status", "requiresApproval");

-- CreateIndex
CREATE INDEX "order_line_items_orderId_idx" ON "order_line_items"("orderId");

-- CreateIndex
CREATE INDEX "order_line_items_productId_idx" ON "order_line_items"("productId");

-- CreateIndex
CREATE INDEX "order_status_events_orderId_createdAt_idx" ON "order_status_events"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_placedById_fkey" FOREIGN KEY ("placedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shippingAddressId_fkey" FOREIGN KEY ("shippingAddressId") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Order numbers
-- ---------------------------------------------------------------------------
--
-- `ORD-2026-000123`, allocated from a sequence.
--
-- **The sequence is global and does not restart each year.** The year in the
-- reference is informational — it tells a human when the order was placed at a
-- glance — while uniqueness comes from the counter alone. Restarting annually
-- would mean either a counter table (a row every order contends on, which
-- serialises checkout) or an advisory lock held across the insert. Neither is
-- worth it for a string whose job is to be unique and quotable.
--
-- **Gaps are accepted.** A sequence does not roll back, so an order write that
-- fails after allocating a number leaves that number unused. The alternative —
-- gapless numbering — requires holding a lock for the length of the
-- transaction, which turns concurrent checkout into a queue. Invoice numbers
-- (BE-09) are a different matter and some jurisdictions do require them to be
-- gapless; that is a decision for the billing engine, not for this sequence.
CREATE SEQUENCE IF NOT EXISTS "order_number_seq" START WITH 1 INCREMENT BY 1;

GRANT USAGE, SELECT ON SEQUENCE "order_number_seq" TO ticketit_app;

CREATE OR REPLACE FUNCTION next_order_number()
  RETURNS text
  LANGUAGE sql
  VOLATILE
  -- Schema-qualified rather than search_path-dependent, for the same reason
  -- app_current_account_id() sets an empty search_path.
  SET search_path = ''
AS $$
  SELECT 'ORD-'
      || to_char(now() AT TIME ZONE 'UTC', 'YYYY')
      || '-'
      || lpad(nextval('public.order_number_seq')::text, 6, '0')
$$;

COMMENT ON FUNCTION next_order_number() IS
  'Allocates the next order reference. Gaps are expected — see the migration.';

GRANT EXECUTE ON FUNCTION next_order_number() TO ticketit_app;

-- ---------------------------------------------------------------------------
-- Value constraints
-- ---------------------------------------------------------------------------
--
-- An order is the record a customer is invoiced against, so these are stated in
-- the database as well as in the service. BE-07 will write to these rows, INT-02
-- will write tracking numbers to them, and a future re-order tool will copy
-- them; none of those passes through the checkout DTO.

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_totals_non_negative"
  CHECK ("subtotal" >= 0 AND "catalogSubtotal" >= 0 AND "total" >= 0);

-- The billing period is the key BE-09 aggregates invoices by and the window a
-- branch's budget is measured over. A malformed one would silently drop an
-- order out of both.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_billing_period_format"
  CHECK ("billingPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- SOW BE-07 is explicit that a rejection carries a mandatory reason. Enforced
-- here so no code path can produce a rejected order that does not say why.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_rejection_has_reason"
  CHECK ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL);

ALTER TABLE "order_line_items"
  ADD CONSTRAINT "order_line_items_quantity_positive"
  CHECK ("quantity" >= 1);

ALTER TABLE "order_line_items"
  ADD CONSTRAINT "order_line_items_prices_non_negative"
  CHECK ("unitPrice" >= 0 AND "lineTotal" >= 0 AND "catalogUnitPrice" >= 0);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- Orders are tenant-owned. The two child tables carry no accountId and are
-- reached through the parent, the same shape as rate_card_items and cart_lines:
-- a denormalised tenant column can drift from the row that owns it.
--
-- Note this is tenant isolation only. Which orders a *user* may see — their own,
-- their site's, or the whole account — is a permission question (ORDER_VIEW_OWN,
-- ORDER_VIEW_SITE, ORDER_VIEW_ACCOUNT) that RLS cannot express, because the
-- scope carries an account and not a user. OrdersService decides it.

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders_tenant_isolation" ON "orders"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "order_line_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_line_items_tenant_isolation" ON "order_line_items"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "orders" o
      WHERE o."id" = "order_line_items"."orderId"
        AND o."accountId" = app_current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "orders" o
      WHERE o."id" = "order_line_items"."orderId"
        AND o."accountId" = app_current_account_id()
    )
  );

ALTER TABLE "order_status_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_status_events_tenant_isolation" ON "order_status_events"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "orders" o
      WHERE o."id" = "order_status_events"."orderId"
        AND o."accountId" = app_current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "orders" o
      WHERE o."id" = "order_status_events"."orderId"
        AND o."accountId" = app_current_account_id()
    )
  );
