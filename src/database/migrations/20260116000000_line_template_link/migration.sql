-- Links a personalised basket or order line back to the artwork it came from.
--
-- Before this, a line carried `customisation` — {"businessName": "Apex"} — and
-- nothing that said which template those values belonged to. An operator
-- looking at the order saw the answers without the question, and could not have
-- told a printer what to put them on.
--
-- ---------------------------------------------------------------------------
-- Why the version and not just the template
-- ---------------------------------------------------------------------------
-- A template is a moving draft; a version is frozen. Pointing at the template
-- alone would mean the artwork under a placed order changed every time a
-- designer saved. The version is what the buyer actually saw, and it is
-- immutable, so a reference to it is as good as a copy and costs nothing.
--
-- ---------------------------------------------------------------------------
-- Why the two tables delete differently
-- ---------------------------------------------------------------------------
-- `cart_lines` CASCADE. If a template really is destroyed, a basket line
-- personalised from it is unorderable, and leaving it behind with a null
-- template would be a bag of values nobody can place on a page.
--
-- `order_line_items` RESTRICT. An order is a record of what was bought, and a
-- null here would quietly erase what was printed — the one thing these columns
-- exist to prevent. Templates are soft-deleted in normal operation, so this
-- only ever blocks a hard delete of something a customer has actually ordered.
-- That is the correct outcome: it should be impossible.

-- AlterTable
ALTER TABLE "cart_lines" ADD COLUMN     "templateId" TEXT,
ADD COLUMN     "templateVersionId" TEXT;

-- AlterTable
ALTER TABLE "order_line_items" ADD COLUMN     "templateId" TEXT,
ADD COLUMN     "templateVersionId" TEXT;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Both columns or neither.
--
-- A template id with no version is a line whose artwork cannot be pinned down;
-- a version with no template is a reference with no subject. Neither is a state
-- any code path should be able to produce, so the database refuses it rather
-- than trusting four call sites to agree.
ALTER TABLE "cart_lines"
  ADD CONSTRAINT "cart_lines_template_pair"
  CHECK (("templateId" IS NULL) = ("templateVersionId" IS NULL));

ALTER TABLE "order_line_items"
  ADD CONSTRAINT "order_line_items_template_pair"
  CHECK (("templateId" IS NULL) = ("templateVersionId" IS NULL));

-- The fulfilment lookup: every line printed from one template, and every line
-- printed from one version of it. Read when an operator asks "what else is
-- waiting on this artwork" and by INT-01 when it batches a production run.
CREATE INDEX "order_line_items_templateVersionId_idx"
  ON "order_line_items"("templateVersionId");
