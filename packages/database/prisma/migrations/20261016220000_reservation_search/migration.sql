-- ===========================================================================
-- Omnibar reservation search: OTA reference, government ID, and search indexes.
--
-- Effect on existing rows: additive and nullable, so nothing is rewritten.
-- Every existing reservation gets NULL for both new columns. The unique index
-- on (propertyId, otaBookingId) is satisfied trivially, because Postgres
-- treats NULLs as distinct — all 878 seeded rows coexist.
--
-- `otaBookingId` is not only a search key. CLAUDE.md section 5 requires
-- inbound OTA ingestion to be idempotent on the channel's reservation id, and
-- that needs a UNIQUE constraint rather than a plain index: without it a
-- retried webhook creates a second copy of the same booking and the hotel
-- oversells. Scoped per property, like every other unique constraint on
-- operational data (section 3.2).
--
-- `govtIdNumber` holds guest PII (Aadhaar / passport / PAN / licence). It is
-- plaintext because the front desk searches by the last digits of a card a
-- guest is holding, and a one-way hash cannot answer a partial match. The API
-- never returns it whole — the search response carries `XXXX-XXXX-1234` and a
-- last-four — and never logs it (section 5). It moves to an encrypted column
-- with an access audit trail when a `guests` module lands.
--
-- Index choice: btree, each leading with propertyId. They serve exact and
-- prefix matches; a mid-string `contains` still scans, which is fine against
-- ~900 reservations per property once propertyId has narrowed the set. A
-- pg_trgm GIN index is the escalation if that changes — not worth its write
-- cost at ten hotels (section 6.4).
--
-- Deliberately NOT added, though the brief listed them:
--   * `assignedRoomNumber` — a denormalised copy of `room.roomNumber`, already
--     reachable through reservation_room.room_id. Section 3.4 forbids caching
--     a derived value in a mutable column, and a room move (a core front-desk
--     operation) would silently desynchronise it. Room search joins instead.
--   * `guestName` — the table already has guestFirstName / guestLastName. One
--     merged column would be a third name able to disagree with the two it
--     came from; the search tokenises the query across both instead.
--   * A `Guest` model — guest identity is denormalised onto the reservation
--     today. Normalising it is the `frontdesk` guest-profile work, and adding
--     a half-built Guest table now would create two sources of guest truth.
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
ALTER TABLE "reservation" ADD COLUMN     "govtIdNumber" TEXT,
ADD COLUMN     "otaBookingId" TEXT;

-- CreateIndex
CREATE INDEX "reservation_propertyId_guestPhone_idx" ON "reservation"("propertyId", "guestPhone");

-- CreateIndex
CREATE INDEX "reservation_propertyId_govtIdNumber_idx" ON "reservation"("propertyId", "govtIdNumber");

-- CreateIndex
CREATE INDEX "reservation_propertyId_guestLastName_idx" ON "reservation"("propertyId", "guestLastName");

-- CreateIndex
CREATE INDEX "reservation_propertyId_guestFirstName_idx" ON "reservation"("propertyId", "guestFirstName");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_propertyId_otaBookingId_key" ON "reservation"("propertyId", "otaBookingId");
