-- ===========================================================================
-- Multi-guest reservations, corporate billing, and desk payment detail.
--
-- Effect on existing rows: additive. The 883 seeded reservations gain NULL
-- companyId / paymentMethod / paymentRemark and have no `reservation_guest`
-- rows — which is accurate, because nothing recorded accompanying guests
-- before now. Guest 1 for those bookings remains on `reservation` as it
-- always has.
--
-- `company.gstin` is unique PER PROPERTY, not globally. The brief specified a
-- global unique, which is a cross-tenant coupling bug: two hotels in this
-- portfolio booking the same corporate client — the ordinary case — would
-- collide and the second could not create its own record (CLAUDE.md section
-- 3.2). The cost is one row per property per company, which is correct anyway
-- since billing address and contact are negotiated per hotel.
--
-- The composite foreign keys at the end are this repository's standing pattern
-- for tenant coherence. They make it structurally impossible for a reservation
-- at property A to reference a company or a guest row belonging to property B
-- — something a plain single-column FK permits. Prisma cannot express a
-- foreign key onto a non-primary key, so these are hand-written and are the
-- reason every migration since 20261016140000 has had drops stripped from it.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. They are stripped from the generated SQL, never from the
-- database (CLAUDE.md section 6.2):
--   * ALTER TABLE "inventory_day" DROP CONSTRAINT "inventory_day_same_property_as_room_type";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room_type";
--   * ALTER TABLE "room" DROP CONSTRAINT "room_same_property_as_room_type";
--   * DROP INDEX "reservation_property_id_unique_pair";
--   * DROP INDEX "room_property_id_unique_pair";
--   * DROP INDEX "room_type_property_id_unique_pair";
-- ===========================================================================

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'OTHER');
-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');
-- AlterTable
ALTER TABLE "reservation" ADD COLUMN     "companyId" UUID,
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "paymentRemark" TEXT;
-- CreateTable
CREATE TABLE "reservation_guest" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "countryCode" CHAR(2),
    "gender" "Gender",
    "dateOfBirth" DATE,
    "nationality" TEXT,
    "occupation" TEXT,
    "govtIdType" "GovtIdType",
    "govtIdNumber" TEXT,
    "specialRequest" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "reservation_guest_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "gstin" CHAR(15) NOT NULL,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "reservation_guest_propertyId_reservationId_idx" ON "reservation_guest"("propertyId", "reservationId");
-- CreateIndex
CREATE UNIQUE INDEX "reservation_guest_propertyId_reservationId_ordinal_key" ON "reservation_guest"("propertyId", "reservationId", "ordinal");
-- CreateIndex
CREATE INDEX "company_propertyId_legalName_idx" ON "company"("propertyId", "legalName");
-- CreateIndex
CREATE UNIQUE INDEX "company_propertyId_gstin_key" ON "company"("propertyId", "gstin");
-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "reservation_guest" ADD CONSTRAINT "reservation_guest_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Tenant coherence, hand-written (see the header).
-- ---------------------------------------------------------------------------

-- The pair a composite FK can point at.
CREATE UNIQUE INDEX "company_property_id_unique_pair" ON "company" ("propertyId", "id");

-- A reservation's company must belong to the same property as the reservation.
ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_same_property_as_company"
  FOREIGN KEY ("propertyId", "companyId")
  REFERENCES "company" ("propertyId", "id")
  ON DELETE SET NULL;

-- A guest row must belong to the same property as its reservation.
ALTER TABLE "reservation_guest"
  ADD CONSTRAINT "reservation_guest_same_property_as_reservation"
  FOREIGN KEY ("propertyId", "reservationId")
  REFERENCES "reservation" ("propertyId", "id")
  ON DELETE CASCADE;

-- An ordinal is a position in the guest list, starting at 1.
ALTER TABLE "reservation_guest"
  ADD CONSTRAINT "reservation_guest_ordinal_positive"
  CHECK ("ordinal" >= 1);
