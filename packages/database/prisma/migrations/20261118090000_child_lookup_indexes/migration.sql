-- PF-03: indexes for child rows looked up by their parent id alone.
--
-- Found by scripts/load/profile-queries.mjs against a year of data
-- (docs/release/LOAD-AND-QUERY-PROFILE.md). Prisma relation loads and the
-- master report fetch these by reservationId / folioId without a propertyId
-- condition; the RLS filter (`bypass OR propertyId = ...`) is never usable as
-- an index condition, so each lookup walked a whole propertyId-led index, or
-- the whole table for reservation_night.
--
-- Single-column, like reservation_room's existing (reservationId) index. Not
-- unique, so no tenancy coupling (CLAUDE.md 3.2). Existing rows: unchanged;
-- the indexes are built from them.

CREATE INDEX "reservation_night_reservationId_idx" ON "reservation_night"("reservationId");

CREATE INDEX "folio_line_folioId_idx" ON "folio_line"("folioId");

CREATE INDEX "reservation_guest_reservationId_idx" ON "reservation_guest"("reservationId");
