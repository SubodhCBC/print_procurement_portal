-- Operational preferences for an account (SOW: settings screen).
--
-- A separate table rather than columns on `accounts`: every authentication
-- reads the account row and needs none of this, while these are read on one
-- screen and written a handful of times a year. The hot row stays narrow.
--
-- Every column is NOT NULL with a default, so the row can be created on demand
-- for an account that has never opened the screen and still read as defaults
-- rather than as nulls. The three nullable ones are genuinely optional: an
-- absent notification email falls back to `accounts.contactEmail`, and an
-- absent order prefix means order numbers carry none.

-- CreateTable
CREATE TABLE "account_settings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "orderNumberPrefix" TEXT,
    "enforceMoq" BOOLEAN NOT NULL DEFAULT true,
    "allowBackorders" BOOLEAN NOT NULL DEFAULT false,
    "requireDeliveryNotes" BOOLEAN NOT NULL DEFAULT false,
    "sendOrderConfirmations" BOOLEAN NOT NULL DEFAULT true,
    "notificationEmail" TEXT,
    "sendLowStockAlerts" BOOLEAN NOT NULL DEFAULT true,
    "lowStockAlertThreshold" INTEGER NOT NULL DEFAULT 50,
    "sendMonthlyBillingDigest" BOOLEAN NOT NULL DEFAULT true,
    "sessionTimeoutMinutes" INTEGER NOT NULL DEFAULT 60,
    "enforceTwoFactor" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("id")
);

-- One row per account, and the uniqueness is what makes the upsert on read safe
-- under concurrent first opens of the screen.
-- CreateIndex
CREATE UNIQUE INDEX "account_settings_accountId_key" ON "account_settings"("accountId");

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
