-- Consolidated monthly billing (SOW BE-09).
--
-- ---------------------------------------------------------------------------
-- Draft, then frozen
-- ---------------------------------------------------------------------------
-- A DRAFT invoice recomputes from the orders every time anyone regenerates it
-- and holds no number. Issuing allocates the number and freezes every line.
-- Nothing after that changes what a customer was billed; a mistake becomes a
-- credit note, which is what a finance team expects and what an auditor asks
-- for.
--
-- ---------------------------------------------------------------------------
-- Which orders land on an invoice
-- ---------------------------------------------------------------------------
-- Orders whose own `billingPeriod` is the period, and which have reached
-- DISPATCHED or DELIVERED when the invoice is generated. Both halves are
-- deliberate: the period comes from the order rather than from the shipment, so
-- it agrees with the branch's budget for that month; and only shipped goods are
-- billed, because invoicing something still in production is how a credit note
-- gets created.
--
-- ---------------------------------------------------------------------------
-- What is not modelled yet
-- ---------------------------------------------------------------------------
-- `tax` exists and is always zero. The column is here so the PDF, the CSV and
-- the XLSX all have a place for it and none of them needs restructuring later,
-- but the treatment depends on the customer's registration and on which
-- jurisdictions the platform invoices from — neither settled. A tax figure that
-- was computed from a guess would be worse than one that is visibly zero.

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "billingPeriod" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "siteCount" INTEGER NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMPTZ(3),
    "dueAt" TIMESTAMPTZ(3),
    "paidAt" TIMESTAMPTZ(3),
    "paymentReference" TEXT,
    "voidReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "orderedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" TEXT NOT NULL,
    "siteCode" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "costCentre" TEXT,
    "poNumber" TEXT,
    "campaignCode" TEXT,
    "itemCount" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "invoices_accountId_billingPeriod_idx" ON "invoices"("accountId", "billingPeriod");

-- CreateIndex
CREATE INDEX "invoices_status_billingPeriod_idx" ON "invoices"("status", "billingPeriod");

-- CreateIndex
CREATE INDEX "invoice_lines_invoiceId_siteId_idx" ON "invoice_lines"("invoiceId", "siteId");

-- CreateIndex
CREATE INDEX "invoice_lines_orderId_idx" ON "invoice_lines"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_invoiceId_orderId_key" ON "invoice_lines"("invoiceId", "orderId");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Gapless invoice numbers
-- ---------------------------------------------------------------------------
--
-- Order numbers come from a PostgreSQL sequence and are allowed to have gaps —
-- a sequence does not roll back, and making them gapless would mean holding a
-- lock for the length of a checkout, turning concurrent orders into a queue.
--
-- Invoice numbers are the opposite case on both counts. Several jurisdictions
-- require them to be unbroken, and issuing happens in an operator-driven batch
-- once a month rather than on every customer request — so the row lock that
-- would be unacceptable on checkout costs nothing here.
--
-- One row per year, taken with `SELECT ... FOR UPDATE` inside the issuing
-- transaction. If the transaction rolls back, so does the increment, and the
-- number is handed out again.
--
-- A voided invoice keeps its number. A number that simply disappears is exactly
-- what a tax audit asks about, and "voided" is an answer while "missing" is not.

INSERT INTO "invoice_sequences" ("year", "lastNumber", "updatedAt")
VALUES (EXTRACT(YEAR FROM now() AT TIME ZONE 'UTC')::int, 0, now())
ON CONFLICT ("year") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Value constraints
-- ---------------------------------------------------------------------------

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_billing_period_format"
  CHECK ("billingPeriod" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_totals_non_negative"
  CHECK ("subtotal" >= 0 AND "tax" >= 0 AND "total" >= 0);

-- A draft has no number; anything past draft must have one. This is the rule
-- that makes "issued" mean something, so it is held here rather than trusted to
-- the service that normally maintains it.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_issued_has_number"
  CHECK (
    ("status" = 'DRAFT' AND "invoiceNumber" IS NULL)
    OR ("status" <> 'DRAFT' AND "invoiceNumber" IS NOT NULL)
  );

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_void_has_reason"
  CHECK ("status" <> 'VOID' OR "voidReason" IS NOT NULL);

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_amount_non_negative"
  CHECK ("amount" >= 0);

-- One draft per account per period. Regenerating recomputes that draft rather
-- than accumulating a pile of them, and two drafts for the same month would
-- leave an operator guessing which one to issue.
--
-- Partial, so it does not constrain issued or voided invoices: a period can
-- legitimately end up with a voided invoice and its replacement.
CREATE UNIQUE INDEX "invoices_one_draft_per_period"
  ON "invoices" ("accountId", "billingPeriod")
  WHERE ("status" = 'DRAFT');

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- Invoices are tenant-owned. Lines carry no accountId and are reached through
-- their invoice, the same shape as every other child table here.
--
-- `invoice_sequences` is deliberately *not* policied and carries no tenant
-- column: invoice numbers are unique across the platform, not per customer, and
-- a per-tenant counter would hand the same number to two accounts.

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoices_tenant_isolation" ON "invoices"
  FOR ALL
  USING ("accountId" = app_current_account_id())
  WITH CHECK ("accountId" = app_current_account_id());

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoice_lines_tenant_isolation" ON "invoice_lines"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "invoices" i
      WHERE i."id" = "invoice_lines"."invoiceId"
        AND i."accountId" = app_current_account_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "invoices" i
      WHERE i."id" = "invoice_lines"."invoiceId"
        AND i."accountId" = app_current_account_id()
    )
  );
