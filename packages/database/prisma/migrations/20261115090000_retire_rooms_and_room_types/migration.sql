-- ---------------------------------------------------------------------------
-- Retiring rooms and room types.
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. Two nullable columns are added to
-- `room` and two to `room_type`; every existing row reads as active (NULL).
-- No backfill, no constraint on any other table is touched.
--
-- Retirement is a soft state rather than a delete: `reservation_room`,
-- `room_block`, `inventory_day` and folio history all reference these rows,
-- and history must keep resolving. A retired row is never un-retired.
-- ---------------------------------------------------------------------------

ALTER TABLE "room_type" ADD COLUMN "retiredAt" TIMESTAMPTZ(6);
ALTER TABLE "room_type" ADD COLUMN "retiredByUserId" UUID;

ALTER TABLE "room" ADD COLUMN "retiredAt" TIMESTAMPTZ(6);
ALTER TABLE "room" ADD COLUMN "retiredByUserId" UUID;

-- Attribution is all-or-nothing, the same rule `room_block_release_is_attributed`
-- applies: a retirement nobody can be named for is not an audit trail.
ALTER TABLE "room_type"
    ADD CONSTRAINT "room_type_retirement_is_attributed"
    CHECK (("retiredAt" IS NULL) = ("retiredByUserId" IS NULL));

ALTER TABLE "room"
    ADD CONSTRAINT "room_retirement_is_attributed"
    CHECK (("retiredAt" IS NULL) = ("retiredByUserId" IS NULL));
