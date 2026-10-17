-- ===========================================================================
-- Named OTA channels on the `BookingSource` enum.
--
-- Effect on existing rows: NONE. This is purely additive — five new labels on
-- an existing enum type. No row is rewritten, no default changes, and every
-- reservation keeps the source it already had. `DIRECT_WEB` stays the value
-- the seed writes; the report groups it under the "DIRECT WEBSITE" label.
--
-- Why these live beside the source *types* (DIRECT_WEB, WALK_IN, OTA, ...):
-- the booking-source report has to say "Agoda", and `OTA` cannot. Keeping both
-- granularities in one column is a deliberate interim — when the `channels`
-- module lands it owns channel identity as mapping rows (CLAUDE.md section 2)
-- and these become a foreign key. `OTA` is retained for a channel with no
-- member of its own, so nothing is forced into a wrong bucket.
--
-- Deliberately NOT added: a `DIRECT_WEBSITE` member. `DIRECT_WEB` already
-- means that, and two enum values for one concept is the near-synonym trap
-- section 6.1 warns about.
--
-- Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a transaction provided
-- the new value is not *used* in that same transaction. This migration only
-- declares them, so Prisma's transaction wrapper is safe. (The generated
-- script's warning about PG <= 11 does not apply; this database is 17.6.)
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

-- AlterEnum
ALTER TYPE "BookingSource" ADD VALUE 'MAKEMYTRIP';
ALTER TYPE "BookingSource" ADD VALUE 'AGODA';
ALTER TYPE "BookingSource" ADD VALUE 'BOOKING_COM';
ALTER TYPE "BookingSource" ADD VALUE 'EXPEDIA';
ALTER TYPE "BookingSource" ADD VALUE 'CLEARTRIP';

-- The booking-source report groups by source over a date window, per property.
-- Without this it is a sequential scan of every reservation in the portfolio
-- on every dashboard load. Leads with propertyId, as every operational index
-- must (CLAUDE.md section 3.2).
-- Named the way Prisma names an `@@index`, so `migrate diff` does not propose
-- renaming it on every future migration. The snake_case siblings on this table
-- (`reservation_property_id_unique_pair`) are hand-written constraint support
-- that Prisma cannot see; this one it can, so it follows its convention.
CREATE INDEX "reservation_propertyId_source_arrivalDate_idx"
  ON "reservation" ("propertyId", "source", "arrivalDate");
