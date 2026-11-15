-- ---------------------------------------------------------------------------
-- Room blocks: capacity deliberately withheld from sale for a date range.
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. It creates two enums and one new
-- table. No existing table gains or loses a column, no constraint on
-- `inventory_day`, `room`, `room_type`, `reservation` or `reservation_room` is
-- added, altered or dropped, and nothing is backfilled. The table ships empty
-- and has no writer until the room-block endpoints land.
--
-- Hand-written rather than generated, because Prisma cannot express the
-- exclusion constraint or the conditional CHECKs below (CLAUDE.md section 2
-- permits raw SQL for exactly these).
-- ---------------------------------------------------------------------------

CREATE TYPE "RoomBlockReason" AS ENUM (
    'MAINTENANCE', 'OWNER_USE', 'TEMPORARY_CLOSURE', 'DEEP_CLEAN', 'RENOVATION', 'OTHER'
);

CREATE TYPE "RoomBlockStatus" AS ENUM ('ACTIVE', 'RELEASED');

CREATE TABLE "room_block" (
    "id"               UUID            NOT NULL,
    "propertyId"       UUID            NOT NULL,
    "roomTypeId"       UUID            NOT NULL,
    "roomId"           UUID,
    "rooms"            INTEGER         NOT NULL DEFAULT 1,
    "fromDate"         DATE            NOT NULL,
    "throughDate"      DATE            NOT NULL,
    "reason"           "RoomBlockReason" NOT NULL,
    "note"             TEXT,
    "status"           "RoomBlockStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId"  UUID            NOT NULL,
    "releasedByUserId" UUID,
    "releasedAt"       TIMESTAMPTZ(6),
    "createdAt"        TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMPTZ(6)  NOT NULL,

    CONSTRAINT "room_block_pkey" PRIMARY KEY ("id")
);

-- Every index leads with `propertyId` (CLAUDE.md section 3.2): an index that
-- did not would make one hotel's query plan depend on another's row count.
CREATE INDEX "room_block_propertyId_fromDate_idx"
    ON "room_block"("propertyId", "fromDate");
CREATE INDEX "room_block_propertyId_roomId_fromDate_idx"
    ON "room_block"("propertyId", "roomId", "fromDate");
CREATE INDEX "room_block_propertyId_roomTypeId_fromDate_idx"
    ON "room_block"("propertyId", "roomTypeId", "fromDate");
CREATE INDEX "room_block_propertyId_status_fromDate_idx"
    ON "room_block"("propertyId", "status", "fromDate");

-- ---------------------------------------------------------------------------
-- 1. Plain foreign keys.
--
-- `roomTypeId` and `roomId` are RESTRICT, not CASCADE: deleting a room type or
-- a room out from under an active block would silently drop withheld capacity
-- without touching the `inventory_day.blocked` counter it is paired with,
-- leaving the counter permanently high. RESTRICT makes that impossible.
-- ---------------------------------------------------------------------------
ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_roomTypeId_fkey"
    FOREIGN KEY ("roomTypeId") REFERENCES "room_type"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "room"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. The range must be real.
--
-- `throughDate` is exclusive, so a zero-night block would make
-- `daterange(fromDate, throughDate, '[)')` empty -- and an empty range
-- overlaps nothing, so such a row would slip past the exclusion constraint in
-- section 5 and withhold capacity invisibly. This CHECK is what keeps that
-- constraint honest, exactly as `reservation_room_departure_after_arrival`
-- does for stays.
-- ---------------------------------------------------------------------------
ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_through_after_from"
    CHECK ("throughDate" > "fromDate");

ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_rooms_positive"
    CHECK ("rooms" >= 1);

-- ---------------------------------------------------------------------------
-- 3. A specific-room block is exactly one room.
--
-- Structural, not conventional. The blocked-counter model says a specific-room
-- block contributes exactly 1 per night; if `rooms` could be anything else
-- while `roomId` was set, that contribution would be a matter of trust rather
-- than of schema.
-- ---------------------------------------------------------------------------
ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_specific_is_one_room"
    CHECK ("roomId" IS NULL OR "rooms" = 1);

-- ---------------------------------------------------------------------------
-- 4. A release is always attributed.
--
-- Releasing decrements `inventory_day.blocked`, and that decrement is the one
-- direction the oversell CHECK cannot catch -- it only looks upward, so a
-- release that ran twice would silently invent a room. Half-written release
-- metadata would make such an event unattributable after the fact.
-- ---------------------------------------------------------------------------
ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_release_is_attributed"
    CHECK (
        "status" <> 'RELEASED'
        OR ("releasedByUserId" IS NOT NULL AND "releasedAt" IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- 5. A specific room cannot be double-blocked.
--
-- Same-table, so this is a real guarantee rather than an application
-- convention (CLAUDE.md section 3.1 layer 1). `WHERE status = 'ACTIVE'` keeps
-- released history out of the index, so a room becomes blockable again the
-- moment its block is released. `roomId IS NOT NULL` keeps category blocks out
-- entirely: two category blocks on the same dates are legitimate and simply
-- add their units, which `inventory_day_not_oversold` arbitrates.
--
-- NULL never equals NULL in GiST, so even without the partial predicate a
-- category block would not conflict -- the predicate is there to say so
-- deliberately rather than to rely on that.
--
-- Note this can never actually block a transaction: two overlapping
-- specific-room blocks are necessarily on the same room, therefore the same
-- room type, therefore share at least one `inventory_day` night, and every
-- writer takes those rows FOR UPDATE first. It is a backstop against a write
-- that bypasses the service, at zero concurrency cost.
--
-- `btree_gist` already exists (migration 20261016140000); the IF NOT EXISTS is
-- kept so this file is readable on its own.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_no_self_overlap"
    EXCLUDE USING gist (
        "roomId" WITH =,
        daterange("fromDate", "throughDate", '[)') WITH &&
    ) WHERE ("status" = 'ACTIVE' AND "roomId" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 6. Tenancy, enforced by the database.
--
-- A block's room type and room must belong to the block's own property. These
-- composite foreign keys ride on the `*_property_id_unique_pair` constraints
-- that migration 20261016140000 added to `room` and `room_type` for exactly
-- this purpose, and they make a cross-property block unrepresentable rather
-- than merely unwritten -- the class of bug section 3.2 exists to prevent.
--
-- Column ORDER matters: it must match `UNIQUE ("id", "propertyId")` on the
-- referenced tables, so the referencing side is ("<fk>Id", "propertyId") --
-- identical to `reservation_room_same_property_as_room_type` and
-- `room_same_property_as_room_type`.
--
-- `roomId` is nullable, and the default MATCH SIMPLE semantics mean the
-- constraint is simply not checked when any referencing column is NULL. So a
-- category block (no room) satisfies it without a special case, exactly as an
-- unassigned `reservation_room` row does.
-- ---------------------------------------------------------------------------
ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_same_property_as_room_type"
    FOREIGN KEY ("roomTypeId", "propertyId")
    REFERENCES "room_type"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "room_block"
    ADD CONSTRAINT "room_block_same_property_as_room"
    FOREIGN KEY ("roomId", "propertyId")
    REFERENCES "room"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
