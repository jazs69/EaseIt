-- ===========================================================================
-- Provenance for a company's legal name.
--
-- Effect on existing rows: additive, defaulted to UNVERIFIED — which is
-- accurate for every company saved so far, because nothing had asked a
-- provider anything.
--
-- Why this column exists at all: the GSTIN lookup can now run against a mock
-- provider that returns invented taxpayer names so the booking form works
-- without paid API credits. Without recording where a name came from, a
-- company created from mock data becomes indistinguishable from a verified one
-- the instant the request ends — and the whole hazard of a fabricated legal
-- name is that it looks exactly like a real one. An invoice generator can now
-- refuse to print a MOCK name, which is the point.
--
-- `mock` is additionally refused in production by the environment schema, so
-- the column should only ever see MOCK in development.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. They are stripped from the generated SQL, never from the
-- database (CLAUDE.md section 6.2):
--   * ALTER TABLE "inventory_day" DROP CONSTRAINT "inventory_day_same_property_as_room_type";
--   * ALTER TABLE "reservation" DROP CONSTRAINT "reservation_same_property_as_company";
--   * ALTER TABLE "reservation_guest" DROP CONSTRAINT "reservation_guest_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room_type";
--   * ALTER TABLE "room" DROP CONSTRAINT "room_same_property_as_room_type";
--   * DROP INDEX "company_property_id_unique_pair";
--   * DROP INDEX "reservation_property_id_unique_pair";
--   * DROP INDEX "room_property_id_unique_pair";
--   * DROP INDEX "room_type_property_id_unique_pair";
-- ===========================================================================

-- CreateEnum
CREATE TYPE "GstinVerification" AS ENUM ('UNVERIFIED', 'MOCK', 'VERIFIED');

-- AlterTable
ALTER TABLE "company" ADD COLUMN     "gstinProvider" TEXT,
ADD COLUMN     "gstinVerification" "GstinVerification" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "gstinVerifiedAt" TIMESTAMPTZ(6);
