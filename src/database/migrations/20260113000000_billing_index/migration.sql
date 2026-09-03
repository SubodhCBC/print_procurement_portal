-- The composite index the monthly billing run needs (SOW BE-13).
--
-- `BillingService.generate()` asks for every order in one account, in one
-- period, at a billable status. The existing index leads with `siteId` — which
-- serves the branch budget query — and a B-tree cannot skip its leading column,
-- so the billing run was falling back to the `accountId, createdAt` index and
-- filtering the rest in memory.
--
-- Two indexes rather than one reordered: the budget query runs on every cart
-- validation, which is far hotter than a monthly invoice run, and taking
-- `siteId` out of the lead would slow the common path to speed up the rare one.

-- CreateIndex
CREATE INDEX "orders_accountId_billingPeriod_status_idx" ON "orders"("accountId", "billingPeriod", "status");
