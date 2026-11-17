-- GP-02 reusable guest profiles; GP-07 direct billing (the city ledger).
--
-- Effect on existing rows:
--   * reservation_guest gains a nullable "guestProfileId"; every row reads
--     NULL (no stay is linked to a profile until a clerk links it).
--   * "PaymentMethod" gains CITY_LEDGER; no existing line uses it.
--   * Two new tables, empty. Triggers are added for the new tables and one
--     deferred check on folio_line inserts that only fires for CITY_LEDGER.
--   * One permission is added and granted to the PROPERTY_ADMIN and
--     SUPER_ADMIN templates. No custom role gains it.
-- CreateEnum
CREATE TYPE "CompanyLedgerEntryKind" AS ENUM ('TRANSFER', 'PAYMENT');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'CITY_LEDGER';

-- AlterTable
ALTER TABLE "reservation_guest" ADD COLUMN     "guestProfileId" UUID;

-- CreateTable
CREATE TABLE "guest_profile" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "phone" TEXT,
    "countryCode" CHAR(2),
    "emailNormalized" TEXT,
    "phoneNormalized" TEXT,
    "preferences" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guest_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_ledger_entry" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "kind" "CompanyLedgerEntryKind" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "postingDate" DATE NOT NULL,
    "reservationId" UUID,
    "folioLineId" UUID,
    "paymentMethod" "PaymentMethod",
    "reference" TEXT,
    "remark" TEXT,
    "postedById" UUID,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_profile_propertyId_lastName_firstName_idx" ON "guest_profile"("propertyId", "lastName", "firstName");

-- CreateIndex
CREATE INDEX "guest_profile_propertyId_emailNormalized_idx" ON "guest_profile"("propertyId", "emailNormalized");

-- CreateIndex
CREATE INDEX "guest_profile_propertyId_phoneNormalized_idx" ON "guest_profile"("propertyId", "phoneNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "company_ledger_entry_folioLineId_key" ON "company_ledger_entry"("folioLineId");

-- CreateIndex
CREATE INDEX "company_ledger_entry_propertyId_companyId_postingDate_idx" ON "company_ledger_entry"("propertyId", "companyId", "postingDate");

-- CreateIndex
CREATE UNIQUE INDEX "company_ledger_entry_propertyId_idempotencyKey_key" ON "company_ledger_entry"("propertyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "reservation_guest_propertyId_guestProfileId_idx" ON "reservation_guest"("propertyId", "guestProfileId");

-- AddForeignKey
ALTER TABLE "reservation_guest" ADD CONSTRAINT "reservation_guest_guestProfileId_fkey" FOREIGN KEY ("guestProfileId") REFERENCES "guest_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_profile" ADD CONSTRAINT "guest_profile_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_ledger_entry" ADD CONSTRAINT "company_ledger_entry_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_ledger_entry" ADD CONSTRAINT "company_ledger_entry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_ledger_entry" ADD CONSTRAINT "company_ledger_entry_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_ledger_entry" ADD CONSTRAINT "company_ledger_entry_folioLineId_fkey" FOREIGN KEY ("folioLineId") REFERENCES "folio_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written guarantees (Prisma cannot express these). Never remove.
--
-- `CITY_LEDGER` was added to "PaymentMethod" above. PostgreSQL forbids using
-- a new enum value in the transaction that added it, so every reference to
-- it below compares the column's TEXT form, which does not use the value.
-- ===========================================================================

-- A ledger entry's sign and fields are fixed by its kind.
ALTER TABLE "company_ledger_entry"
  ADD CONSTRAINT "company_ledger_entry_shape_matches_kind" CHECK (
    ("kind" = 'TRANSFER'
       AND "amountMinor" > 0
       AND "reservationId" IS NOT NULL
       AND "folioLineId" IS NOT NULL
       AND "paymentMethod" IS NULL)
    OR
    ("kind" = 'PAYMENT'
       AND "amountMinor" < 0
       AND "reservationId" IS NULL
       AND "folioLineId" IS NULL
       AND "paymentMethod" IS NOT NULL
       AND "paymentMethod"::text <> 'CITY_LEDGER'
       AND "idempotencyKey" IS NOT NULL)
  );

-- Append-only, like folio_line: a mistake is corrected by a new entry.
-- Deleting is left to the property and reservation cascades.
CREATE OR REPLACE FUNCTION "company_ledger_entry_refuse_update"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'company_ledger_entry is append-only; post a new entry instead'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'company_ledger_entry_append_only';
END;
$$;

CREATE TRIGGER "company_ledger_entry_append_only"
  BEFORE UPDATE ON "company_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION "company_ledger_entry_refuse_update"();

-- Every row an entry points at belongs to the entry's own property
-- (section 3.2). The service already checks; this is the backstop.
CREATE OR REPLACE FUNCTION "company_ledger_entry_same_property"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "company"
                  WHERE "id" = NEW."companyId" AND "propertyId" = NEW."propertyId") THEN
    RAISE EXCEPTION 'company_ledger_entry: company is not of this property'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'company_ledger_entry_same_property';
  END IF;
  IF NEW."reservationId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "reservation"
        WHERE "id" = NEW."reservationId" AND "propertyId" = NEW."propertyId"
          AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'company_ledger_entry: the stay is not of this property and company'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'company_ledger_entry_same_property';
  END IF;
  IF NEW."folioLineId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "folio_line" l JOIN "folio" f ON f."id" = l."folioId"
        WHERE l."id" = NEW."folioLineId" AND l."propertyId" = NEW."propertyId"
          AND f."reservationId" = NEW."reservationId"
          AND l."kind" = 'PAYMENT' AND l."paymentMethod"::text = 'CITY_LEDGER'
          AND -l."amountMinor" = NEW."amountMinor") THEN
    RAISE EXCEPTION 'company_ledger_entry: the transfer does not match its folio line'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'company_ledger_entry_same_property';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "company_ledger_entry_same_property"
  BEFORE INSERT ON "company_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION "company_ledger_entry_same_property"();

-- A CITY_LEDGER folio line never exists without the receivable it moved the
-- balance to: checked at COMMIT, so the line and its entry are written in
-- either order inside one transaction.
CREATE OR REPLACE FUNCTION "folio_line_city_ledger_has_entry"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."paymentMethod"::text = 'CITY_LEDGER' AND NOT EXISTS (
       SELECT 1 FROM "company_ledger_entry" WHERE "folioLineId" = NEW."id") THEN
    RAISE EXCEPTION 'folio line % is billed to the city ledger with no ledger entry', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'folio_line_city_ledger_has_entry';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "folio_line_city_ledger_has_entry"
  AFTER INSERT ON "folio_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "folio_line_city_ledger_has_entry"();

-- A guest row links only to a profile of its own property.
CREATE OR REPLACE FUNCTION "reservation_guest_profile_same_property"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."guestProfileId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "guest_profile"
        WHERE "id" = NEW."guestProfileId" AND "propertyId" = NEW."propertyId") THEN
    RAISE EXCEPTION 'reservation_guest: guest profile is not of this property'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_guest_profile_same_property';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "reservation_guest_profile_same_property"
  BEFORE INSERT OR UPDATE OF "guestProfileId" ON "reservation_guest"
  FOR EACH ROW EXECUTE FUNCTION "reservation_guest_profile_same_property"();

-- MT-04: tenant row-level security, like every other property-scoped table.
ALTER TABLE "guest_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guest_profile" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "guest_profile"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "company_ledger_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_ledger_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "company_ledger_entry"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

-- The new permission, so custom roles can grant it without a re-seed, and the
-- administrator templates hold it (the seed keeps both in sync too).
INSERT INTO "permission" ("id", "key", "label", "description", "category", "sensitive")
VALUES (gen_random_uuid(), 'direct_billing:manage', 'Manage direct billing',
        'Bill a stay''s balance to its company account, and record the company''s payments.',
        'BILLING', true)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT r."id", p."id"
  FROM "role" r CROSS JOIN "permission" p
 WHERE r."key" IN ('PROPERTY_ADMIN', 'SUPER_ADMIN') AND r."propertyId" IS NULL
   AND p."key" = 'direct_billing:manage'
ON CONFLICT DO NOTHING;
