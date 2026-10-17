-- ===========================================================================
-- Real check-in / check-out instants on `reservation`.
--
-- Effect on existing rows: additive and nullable, so nothing is rewritten. A
-- booking that has not arrived yet legitimately has neither value.
--
-- These are instants, unlike `arrivalDate` / `departureDate` which are booked
-- calendar dates. The hourly Day view of the reservation calendar positions
-- blocks against them; without them it could only assume every guest arrives
-- at the property's standard desk time.
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

-- AlterTable
ALTER TABLE "reservation" ADD COLUMN     "checkedInAt" TIMESTAMPTZ(6),
ADD COLUMN     "checkedOutAt" TIMESTAMPTZ(6);
