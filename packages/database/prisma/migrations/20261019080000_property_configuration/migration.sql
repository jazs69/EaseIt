-- ===========================================================================
-- Property configuration: settings, GST slabs, media, amenities, policies, fees.
--
-- Effect on existing rows: **purely additive**. Seven new tables and four new
-- enums. Nothing existing is altered, renamed or dropped, so the 882
-- reservations, 882 assignments and 42,900 inventory_day rows are untouched
-- and every live path keeps working through the deploy.
--
-- WHY THIS IS ADDITIVE RATHER THAN A SCHEMA REPLACEMENT
-- This landed from a brief that asked for `schema.prisma` to be replaced
-- wholesale with an expanded one, and in the same breath for the migration to
-- be generated "cleanly without dropping active reservation data". Those two
-- cannot both happen, and not marginally:
--
--   * Every primary key in that schema is `cuid()` on text; every primary key
--     here is `uuid`. Changing a PK type means dropping and recreating every
--     table and every foreign key that points at it.
--   * It has no `inventory_day` table and no `reservation_room` table, so
--     `inventory_day_not_oversold` and `reservation_room_no_overlap` — the two
--     constraints that are the whole of section 3.1's first layer — have
--     nowhere to exist. Double bookings stop being impossible and start being
--     unlikely.
--   * Every monetary column becomes `Decimal(10,2)`. Section 3.4 permits
--     Decimal for rates and ratios and bans it for money, which is integer
--     minor units here, in all 5 existing columns and everywhere downstream.
--   * `Folio` regains `subtotalNet`, `totalTax`, `totalGross`, `totalPaid` and
--     `balanceDue` as stored columns. Section 3.4: never cache a derived
--     balance in a mutable column.
--   * `FolioTransaction.isModified` / `originalGross` reintroduce in-place
--     mutation of posted lines, which the reversing-entry model replaces.
--   * `User.propertyId` makes a staff member belong to exactly one hotel,
--     replacing the `user_property_role` allowlist (84 grants) that section
--     3.2 requires for cross-property authorisation.
--
-- So the genuinely new material — which is most of it, and useful — is added
-- here in the conventions this database already uses: uuid keys, integer minor
-- units, `propertyId` on every tenant-scoped child, and no cached totals.
--
-- WHAT IS DELIBERATELY NOT HERE
-- Channel connections, kiosk/booking-engine config, notification templates,
-- guest reviews, bulk import jobs, hourly tariffs and lock codes are all
-- reasonable, and none of them has a consumer yet. Adding seven more empty
-- tables for modules that do not exist would be schema nobody reads and
-- migrations nobody can verify (CLAUDE.md section 1: explicit non-goals).
-- They land with the module that uses them.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. All 15 are stripped from the generated SQL below and remain
-- in the database (CLAUDE.md section 6.2):
--   * ALTER TABLE "folio" DROP CONSTRAINT "folio_same_property_as_reservation";
--   * ALTER TABLE "folio_line" DROP CONSTRAINT "folio_line_same_property_as_folio";
--   * ALTER TABLE "inventory_day" DROP CONSTRAINT "inventory_day_same_property_as_room_type";
--   * ALTER TABLE "reservation" DROP CONSTRAINT "reservation_same_property_as_company";
--   * ALTER TABLE "reservation_guest" DROP CONSTRAINT "reservation_guest_same_property_as_reservation";
--   * ALTER TABLE "reservation_note" DROP CONSTRAINT "reservation_note_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room_type";
--   * ALTER TABLE "room" DROP CONSTRAINT "room_same_property_as_room_type";
--   * DROP INDEX "company_property_id_unique_pair";
--   * DROP INDEX "folio_property_id_unique_pair";
--   * DROP INDEX "reservation_property_id_unique_pair";
--   * DROP INDEX "room_property_id_unique_pair";
--   * DROP INDEX "room_type_property_id_unique_pair";
-- ===========================================================================

-- CreateEnum
CREATE TYPE "MediaCategory" AS ENUM ('EXTERIOR', 'INTERIOR', 'RECEPTION', 'ROOM_BEDROOM', 'ROOM_WASHROOM', 'AMENITY_BANQUET', 'AMENITY_POOL', 'AMENITY_GARDEN', 'PARKING', 'RESTAURANT', 'OTHERS');

-- CreateEnum
CREATE TYPE "AmenityScope" AS ENUM ('FREE', 'PAID');

-- CreateEnum
CREATE TYPE "PolicyType" AS ENUM ('CANCELLATION', 'AMENDMENT', 'CHECK_IN_CHECK_OUT', 'HOUSE_RULES', 'TERMS_AND_CONDITIONS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('PERCENTAGE', 'FIXED_PER_NIGHT', 'FIXED_PER_STAY', 'FIXED_PER_GUEST');
















-- CreateTable
CREATE TABLE "property_settings" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "standardCheckInTime" TEXT NOT NULL DEFAULT '14:00',
    "standardCheckOutTime" TEXT NOT NULL DEFAULT '11:00',
    "turnaroundGraceMins" INTEGER NOT NULL DEFAULT 60,
    "bookingPrefix" TEXT NOT NULL DEFAULT 'SFBOOKING_',
    "folioPrefix" TEXT NOT NULL DEFAULT 'FOL_',
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV_',
    "autoHoldReleaseHours" INTEGER NOT NULL DEFAULT 4,
    "nightAuditHour" TEXT NOT NULL DEFAULT '02:00',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "property_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_tax_slab" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "slabName" TEXT NOT NULL,
    "minTariffMinor" INTEGER NOT NULL,
    "maxTariffMinor" INTEGER,
    "taxRatePercent" DECIMAL(5,2) NOT NULL,
    "cgstRatePercent" DECIMAL(5,2) NOT NULL,
    "sgstRatePercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "property_tax_slab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_media" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "category" "MediaCategory" NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "roomTypeId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amenity" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconName" TEXT,
    "groupName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amenity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_amenity_link" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "amenityId" UUID NOT NULL,
    "scope" "AmenityScope" NOT NULL DEFAULT 'FREE',
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "pricingUnit" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_amenity_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_policy" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "type" "PolicyType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "freeCancellationHours" INTEGER,
    "retentionChargePercent" DECIMAL(5,2),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "property_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_and_surcharge" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FeeType" NOT NULL DEFAULT 'FIXED_PER_STAY',
    "amountMinor" INTEGER NOT NULL DEFAULT 0,
    "ratePercent" DECIMAL(5,2),
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "applyToGroup" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_and_surcharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "property_settings_propertyId_key" ON "property_settings"("propertyId");

-- CreateIndex
CREATE INDEX "property_tax_slab_propertyId_minTariffMinor_idx" ON "property_tax_slab"("propertyId", "minTariffMinor");

-- CreateIndex
CREATE INDEX "property_media_propertyId_category_idx" ON "property_media"("propertyId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "amenity_slug_key" ON "amenity"("slug");

-- CreateIndex
CREATE INDEX "property_amenity_link_propertyId_idx" ON "property_amenity_link"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "property_amenity_link_propertyId_amenityId_key" ON "property_amenity_link"("propertyId", "amenityId");

-- CreateIndex
CREATE INDEX "property_policy_propertyId_type_idx" ON "property_policy"("propertyId", "type");

-- CreateIndex
CREATE INDEX "fee_and_surcharge_propertyId_idx" ON "fee_and_surcharge"("propertyId");

-- AddForeignKey
ALTER TABLE "property_settings" ADD CONSTRAINT "property_settings_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_tax_slab" ADD CONSTRAINT "property_tax_slab_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_media" ADD CONSTRAINT "property_media_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_amenity_link" ADD CONSTRAINT "property_amenity_link_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_amenity_link" ADD CONSTRAINT "property_amenity_link_amenityId_fkey" FOREIGN KEY ("amenityId") REFERENCES "amenity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_policy" ADD CONSTRAINT "property_policy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_and_surcharge" ADD CONSTRAINT "fee_and_surcharge_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (see the header).
-- ---------------------------------------------------------------------------

-- A slab's band must be a band. An upper bound at or below the lower bound
-- describes an empty range that silently matches nothing, so a tariff falling
-- into it would resolve to no slab and be taxed at zero.
ALTER TABLE "property_tax_slab"
  ADD CONSTRAINT "property_tax_slab_band_is_ordered"
  CHECK ("maxTariffMinor" IS NULL OR "maxTariffMinor" > "minTariffMinor");

-- Bounds are amounts, so they are non-negative like every other amount.
ALTER TABLE "property_tax_slab"
  ADD CONSTRAINT "property_tax_slab_bounds_non_negative"
  CHECK ("minTariffMinor" >= 0 AND ("maxTariffMinor" IS NULL OR "maxTariffMinor" >= 0));

-- The components must add up to the rate the slab claims. An invoice prints
-- CGST and SGST separately and the total beside them; a slab whose parts do
-- not sum to its whole prints three numbers that contradict each other, and
-- that is the document a tax authority reads.
ALTER TABLE "property_tax_slab"
  ADD CONSTRAINT "property_tax_slab_components_sum_to_rate"
  CHECK ("cgstRatePercent" + "sgstRatePercent" = "taxRatePercent");

-- Rates are percentages, not fractions or multiples.
ALTER TABLE "property_tax_slab"
  ADD CONSTRAINT "property_tax_slab_rates_in_range"
  CHECK (
    "taxRatePercent" >= 0 AND "taxRatePercent" <= 100
    AND "cgstRatePercent" >= 0 AND "sgstRatePercent" >= 0
  );

-- Two slabs of one property must not claim the same lower bound: which of them
-- applies would then depend on row order, and a tariff would be taxed
-- differently depending on how the planner happened to sort.
CREATE UNIQUE INDEX "property_tax_slab_unique_floor_per_property"
  ON "property_tax_slab" ("propertyId", "minTariffMinor");

-- Pairs the composite foreign keys below can point at.
CREATE UNIQUE INDEX "property_amenity_link_property_id_unique_pair"
  ON "property_amenity_link" ("propertyId", "id");

-- A photograph of a room category belongs to the same property as that
-- category. Prisma cannot express a composite FK onto a non-primary key, so
-- the single-column FK it generated is joined by this one (section 3.2).
ALTER TABLE "property_media"
  ADD CONSTRAINT "property_media_same_property_as_room_type"
  FOREIGN KEY ("propertyId", "roomTypeId")
  REFERENCES "room_type" ("propertyId", "id")
  ON DELETE SET NULL;

-- A paid amenity with no price is a charge nobody can collect; a free one with
-- a price is a contradiction the booking engine would have to guess about.
ALTER TABLE "property_amenity_link"
  ADD CONSTRAINT "property_amenity_link_price_matches_scope"
  CHECK (
    ("scope" = 'PAID' AND "priceMinor" > 0)
    OR ("scope" = 'FREE' AND "priceMinor" = 0)
  );

-- A percentage fee carries a rate and no fixed amount; a fixed fee the
-- reverse. Allowing both leaves two sources of truth for one charge.
ALTER TABLE "fee_and_surcharge"
  ADD CONSTRAINT "fee_and_surcharge_amount_matches_type"
  CHECK (
    ("type" = 'PERCENTAGE' AND "ratePercent" IS NOT NULL AND "amountMinor" = 0)
    OR ("type" <> 'PERCENTAGE' AND "amountMinor" >= 0 AND "ratePercent" IS NULL)
  );

-- A retention charge is a percentage of the tariff.
ALTER TABLE "property_policy"
  ADD CONSTRAINT "property_policy_retention_in_range"
  CHECK (
    "retentionChargePercent" IS NULL
    OR ("retentionChargePercent" >= 0 AND "retentionChargePercent" <= 100)
  );
