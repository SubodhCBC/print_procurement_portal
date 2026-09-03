-- Stock reservation (SOW BE-12).
--
-- ---------------------------------------------------------------------------
-- Why two counts and not one
-- ---------------------------------------------------------------------------
-- `stockOnHand` is what is physically on the shelf. `stockReserved` is what has
-- been promised to orders that have not shipped. What anyone else can buy is
-- the difference.
--
-- Decrementing a single count at placement would be simpler and wrong: a
-- warehouse stocktake reconciles against what is really on the floor, and a
-- shelf figure already reduced by unshipped orders would never match it. The
-- operator would then "correct" it, and the correction would double-count.
--
-- ---------------------------------------------------------------------------
-- Why the reservation is a conditional UPDATE
-- ---------------------------------------------------------------------------
-- Reserving is the one place in this system where two requests genuinely race
-- for the same scarce thing. A read-then-write check passes for both of two
-- buyers taking the last three units, and both are told yes.
--
-- So the service reserves with a single statement carrying its own guard —
-- `UPDATE ... SET "stockReserved" = "stockReserved" + n WHERE "stockOnHand" -
-- "stockReserved" >= n` — and treats a row count of zero as "someone else got
-- there first". PostgreSQL serialises the two updates on the row lock, so
-- exactly one of them can succeed. The CHECK constraint below is the backstop
-- that makes a mistake in that statement a loud failure rather than an
-- oversell.

-- CreateEnum
CREATE TYPE "OrderStockState" AS ENUM ('NONE', 'RESERVED', 'CONSUMED', 'RELEASED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "stockState" "OrderStockState" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "stockReserved" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "reorderQuantity" INTEGER,
ADD COLUMN     "stockReserved" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- The invariants reservation depends on
-- ---------------------------------------------------------------------------
--
-- These are the whole point of the feature, so they are held by the database
-- rather than by the service that normally maintains them. A reconciliation
-- import, a hand-run UPDATE during an incident, and BE-11's inbound webhooks
-- will all write these columns without passing through ProductsService.
--
-- `stockReserved <= stockOnHand` is the one that matters: the moment it can be
-- violated, "available" goes negative and the system starts promising units it
-- does not have. Note this makes a stocktake that finds *fewer* units than are
-- already promised fail loudly instead of silently overselling — which is the
-- correct outcome, and the reconciliation endpoint reports it as a variance the
-- operator has to resolve.

ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_reserved_non_negative"
  CHECK ("stockReserved" >= 0);

ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_reserved_within_hand"
  CHECK ("stockReserved" <= "stockOnHand");

ALTER TABLE "products"
  ADD CONSTRAINT "products_reorder_quantity_positive"
  CHECK ("reorderQuantity" IS NULL OR "reorderQuantity" >= 1);

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_stock_reserved_non_negative"
  CHECK ("stockReserved" >= 0);

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_stock_reserved_within_hand"
  CHECK ("stockReserved" <= "stockOnHand");
