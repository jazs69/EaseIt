-- ===========================================================================
-- Internal notes on a reservation, as authored rows.
--
-- Effect on existing rows: additive, and nothing is backfilled. The existing
-- `reservation.notes` free-text field is left exactly where it is and keeps
-- its meaning (the note captured at booking). Copying it into this table would
-- have to invent an author and a timestamp for text that has neither, and a
-- fabricated byline on an internal note is worse than no byline.
--
-- WHY A TABLE AND NOT THE EXISTING COLUMN
-- `reservation.notes` is one string. Two clerks appending to it overwrite each
-- other, and it records neither who wrote what nor when. The drawer shows a
-- running log with an author and a time, so notes become rows.
--
-- WHY `authorName` IS STORED ALONGSIDE `authorUserId`
-- The id is the reference; the name is what the byline showed at the time. A
-- staff member who leaves, or whose account is renamed, must not blank or
-- silently rewrite the attribution on a note written months earlier. This is
-- the same reasoning as `audit_log.actorUserId` carrying its own snapshot
-- fields rather than joining live rows.
--
-- APPEND-ONLY
-- Enforced by contract in the domain layer, like `folio_line`: an internal
-- note is part of how a property explains a decision later, and history that
-- can be edited in place is worth less than none.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. They are stripped from the generated SQL below and remain in
-- the database (CLAUDE.md section 6.2):
--   * ALTER TABLE "folio" DROP CONSTRAINT "folio_same_property_as_reservation";
--   * ALTER TABLE "folio_line" DROP CONSTRAINT "folio_line_same_property_as_folio";
--   * ALTER TABLE "inventory_day" DROP CONSTRAINT "inventory_day_same_property_as_room_type";
--   * ALTER TABLE "reservation" DROP CONSTRAINT "reservation_same_property_as_company";
--   * ALTER TABLE "reservation_guest" DROP CONSTRAINT "reservation_guest_same_property_as_reservation";
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

-- CreateTable
CREATE TABLE "reservation_note" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "authorUserId" UUID,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservation_note_propertyId_reservationId_createdAt_idx" ON "reservation_note"("propertyId", "reservationId", "createdAt");

-- AddForeignKey
ALTER TABLE "reservation_note" ADD CONSTRAINT "reservation_note_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (see the header).
-- ---------------------------------------------------------------------------

-- A note belongs to the same property as the reservation it is written
-- against. Prisma cannot express a composite foreign key onto a non-primary
-- key, so the single-column FK above is joined by this one; together they make
-- a note on another hotel's booking structurally impossible rather than merely
-- unlikely (CLAUDE.md section 3.2).
ALTER TABLE "reservation_note"
  ADD CONSTRAINT "reservation_note_same_property_as_reservation"
  FOREIGN KEY ("propertyId", "reservationId")
  REFERENCES "reservation" ("propertyId", "id")
  ON DELETE CASCADE;

-- A note with no text is a row that says nothing and still occupies the log.
ALTER TABLE "reservation_note"
  ADD CONSTRAINT "reservation_note_body_not_blank"
  CHECK (length(btrim("body")) > 0);
