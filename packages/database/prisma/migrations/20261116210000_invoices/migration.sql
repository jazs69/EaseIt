-- FO-14: invoices. Additive: two tables, one nullable settings column, three
-- guard triggers. No existing row is changed.

-- AlterTable
ALTER TABLE "property_settings" ADD COLUMN     "gstin" CHAR(15);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL,
    "issuedById" UUID,
    "currency" CHAR(3) NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "paidMinor" INTEGER NOT NULL,
    "document" JSONB NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequence" (
    "propertyId" UUID NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "invoice_sequence_pkey" PRIMARY KEY ("propertyId","fiscalYear")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_folioId_key" ON "invoice"("folioId");

-- CreateIndex
CREATE INDEX "invoice_propertyId_invoiceDate_idx" ON "invoice"("propertyId", "invoiceDate");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_unique_number_per_property" ON "invoice"("propertyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_unique_sequence_per_year" ON "invoice"("propertyId", "fiscalYear", "sequence");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_sequence" ADD CONSTRAINT "invoice_sequence_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- FO-14 invariants, as database facts rather than conventions.
-- ---------------------------------------------------------------------------

-- Every figure is whole minor units and the sequence starts at 1.
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_sequence_positive" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "invoice_total_is_net_plus_tax" CHECK ("totalMinor" = "subtotalMinor" + "taxMinor");

ALTER TABLE "invoice_sequence"
  ADD CONSTRAINT "invoice_sequence_last_positive" CHECK ("lastNumber" >= 1);

-- 1. An issued invoice is never edited. Correcting one is a credit note, a
--    separate document; rewriting the row would change a bill a guest holds.
--    DELETE is left to the cascades (a property or stay removed whole).
CREATE OR REPLACE FUNCTION "invoice_refuse_update"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice % is immutable', OLD."number"
    USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_immutable';
END;
$$;

CREATE TRIGGER "invoice_immutable"
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION "invoice_refuse_update"();

-- 2. No line is added to an invoiced folio. Every folio write already
--    re-checks OPEN under its lock and an invoice needs a CLOSED folio; this
--    is the backstop for a path that forgets. The insert itself is under RLS
--    for the same property, so the invoice row is visible to the check.
CREATE OR REPLACE FUNCTION "folio_line_refuse_invoiced"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "invoice" WHERE "folioId" = NEW."folioId") THEN
    RAISE EXCEPTION 'folio % has been invoiced', NEW."folioId"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'folio_line_not_after_invoice';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "folio_line_not_after_invoice"
  BEFORE INSERT ON "folio_line"
  FOR EACH ROW EXECUTE FUNCTION "folio_line_refuse_invoiced"();

-- 3. An invoiced folio is never reopened (check-in's folio upsert sets OPEN).
CREATE OR REPLACE FUNCTION "folio_refuse_reopen_invoiced"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'CLOSED' AND NEW."status" <> 'CLOSED'
     AND EXISTS (SELECT 1 FROM "invoice" WHERE "folioId" = OLD."id") THEN
    RAISE EXCEPTION 'folio % has been invoiced and stays closed', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'folio_invoiced_stays_closed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "folio_invoiced_stays_closed"
  BEFORE UPDATE OF "status" ON "folio"
  FOR EACH ROW EXECUTE FUNCTION "folio_refuse_reopen_invoiced"();

-- MT-04: tenant row-level security, like every other property-scoped table.
ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "invoice_sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_sequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_sequence"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));
