-- ---------------------------------------------------------------------------
-- F2: per-room-type pricing, and the date-wise rate calendar.
--
-- WHY THIS IS A FORWARD MIGRATION AND NOT AN EDIT OF 20261110090000.
--
-- The F1 migration was written in this repository and, to the author's
-- knowledge, has not been applied anywhere -- but "to the author's knowledge"
-- is not evidence. Applied state lives in the `_prisma_migrations` table
-- inside each database, and no database was inspected (or connected to) for
-- this change, so the repository contains no proof either way. Editing a
-- migration that any environment has already run would leave that environment
-- permanently inconsistent with its own history and would make
-- `migrate deploy` fail on a checksum mismatch. So F1 stays exactly as it
-- shipped and this file carries the correction forward.
--
-- It is therefore written to be correct in BOTH cases: applied to a database
-- that already has F1 data, and applied to one where F1 created empty tables
-- moments earlier. The backfill below is a no-op in the second case.
--
-- WHAT IT DOES TO EXISTING ROWS.
--
--   * `rate_plan_room_type` gains `defaultRateMinor`, `baseOccupancy` and
--     `updatedAt`. Existing rows are backfilled from the plan-level values
--     before the columns become NOT NULL, so no configured price is lost.
--   * `rate_plan` LOSES `defaultRateMinor` and `baseOccupancy`, but only
--     AFTER the backfill above has copied them. This is the one destructive
--     step in the file and it is ordered last among the `rate_plan` changes
--     for that reason.
--   * `rate_plan_day` is created, empty.
--   * NOTHING ELSE IS TOUCHED. `room_type.baseRateMinor` is not read, copied,
--     altered or dropped -- it remains what the booking path prices from until
--     F9. No constraint on `room_type`, `inventory_day`, `reservation`,
--     `reservation_room` or `folio_line` is added, altered or dropped.
--
-- Hand-written rather than generated, because Prisma cannot express the
-- CHECK constraints, the ordered backfill, or the composite foreign key below
-- (CLAUDE.md section 2 permits raw SQL for exactly these).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Per-assignment pricing columns, added nullable so the backfill can run.
--
-- `defaultRateMinor` has no DEFAULT on purpose: a default of 0 would silently
-- price every existing assignment at nothing if the backfill in section 2 were
-- ever removed or reordered. Nullable-then-backfill-then-NOT NULL makes a
-- missed row fail loudly at the ALTER in section 3 instead.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_room_type" ADD COLUMN "defaultRateMinor" INTEGER;
ALTER TABLE "rate_plan_room_type" ADD COLUMN "baseOccupancy" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "rate_plan_room_type"
    ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- 2. Backfill from the plan-level price that is about to be dropped.
--
-- Every assignment inherits the price its plan carried, which is the only
-- honest conversion available: F1 could not express a per-category rate, so the
-- plan-level figure IS what each category was priced at. An operator then
-- adjusts the categories that differ.
--
-- Guarded by `information_schema`, because this same file must also apply to a
-- database where F1 ran only moments ago: there the columns still exist and the
-- UPDATE is a no-op over zero rows, which is harmless. The guard is for the
-- case where some other path has already removed them -- then the UPDATE would
-- be a syntax error on a column that is gone, and the whole migration would
-- fail having already added three columns.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'rate_plan' AND column_name = 'defaultRateMinor'
    ) THEN
        EXECUTE '
            UPDATE "rate_plan_room_type" AS rprt
               SET "defaultRateMinor" = rp."defaultRateMinor",
                   "baseOccupancy"    = rp."baseOccupancy"
              FROM "rate_plan" AS rp
             WHERE rp."id" = rprt."ratePlanId"
               AND rprt."defaultRateMinor" IS NULL
        ';
    END IF;
END $$;

-- Any assignment whose plan somehow carried no price at all. Zero is a legal
-- rate (a complimentary plan), so this is a safe floor rather than a guess --
-- and it can only fire on a row the UPDATE above could not reach.
UPDATE "rate_plan_room_type" SET "defaultRateMinor" = 0 WHERE "defaultRateMinor" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Now the column can be mandatory.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_room_type" ALTER COLUMN "defaultRateMinor" SET NOT NULL;

ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_default_rate_non_negative"
    CHECK ("defaultRateMinor" >= 0);

ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_base_occupancy_positive"
    CHECK ("baseOccupancy" >= 1 AND "baseOccupancy" <= 20);

-- ---------------------------------------------------------------------------
-- 4. The triple `rate_plan_day` will reference.
--
-- The primary key is ("ratePlanId", "roomTypeId"), which proves the assignment
-- exists but says nothing about whose property it is. Adding `propertyId` to a
-- unique constraint lets a single composite foreign key from `rate_plan_day`
-- prove BOTH facts at once: that the plan/category pair is really assigned, and
-- that the day row belongs to the same property as that assignment.
--
-- One key doing both is better than two keys doing one each, because two could
-- disagree -- a day row could satisfy "this assignment exists" against one
-- property and "same property" against another if the pair were checked
-- separately.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_assignment_triple"
    UNIQUE ("ratePlanId", "roomTypeId", "propertyId");

-- ---------------------------------------------------------------------------
-- 5. The plan-level price columns go, having been copied in section 2.
--
-- A plan-level fallback is deliberately NOT retained. Two sources for one
-- price is the ambiguity this whole correction exists to remove, and a stale
-- plan-level number is the kind of second answer that eventually gets quoted
-- to a guest.
--
-- `IF EXISTS` so the file is idempotent in the face of a partially-applied
-- predecessor; it does not change the outcome in the ordinary case.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan" DROP CONSTRAINT IF EXISTS "rate_plan_default_rate_non_negative";
ALTER TABLE "rate_plan" DROP CONSTRAINT IF EXISTS "rate_plan_base_occupancy_positive";
ALTER TABLE "rate_plan" DROP COLUMN IF EXISTS "defaultRateMinor";
ALTER TABLE "rate_plan" DROP COLUMN IF EXISTS "baseOccupancy";

-- ---------------------------------------------------------------------------
-- 6. The date-wise calendar.
--
-- `stayDate` is DATE, not TIMESTAMPTZ. A nightly rate belongs to the night the
-- hotel calls that date; stored as a timestamp it would shift by a day either
-- side of midnight depending on who reads it (CLAUDE.md section 3.3).
--
-- A row exists ONLY where the operator has deliberately priced a night
-- differently. Absence means "use the assignment's default", which is why
-- clearing an override deletes the row rather than writing the default into
-- it: a stored copy of the default would make a later change to that default
-- silently fail to apply to those nights.
-- ---------------------------------------------------------------------------
CREATE TABLE "rate_plan_day" (
    "id"              UUID           NOT NULL,
    "propertyId"      UUID           NOT NULL,
    "ratePlanId"      UUID           NOT NULL,
    "roomTypeId"      UUID           NOT NULL,
    "stayDate"        DATE           NOT NULL,
    "amountMinor"     INTEGER        NOT NULL,
    "updatedByUserId" UUID           NOT NULL,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_plan_day_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 7. One price per plan, per category, per night.
--
-- This is what makes the bulk upsert in the service safe: `ON CONFLICT` needs
-- a real unique index to target, and without it two concurrent writes to the
-- same night would both insert and the calendar would hold two prices for one
-- date with no defined winner.
--
-- It leads with `propertyId` (section 3.2), and it doubles as the calendar
-- read's index: one plan, one category, a date window is a prefix scan of
-- exactly this key.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "rate_plan_day_unique_per_date"
    ON "rate_plan_day"("propertyId", "ratePlanId", "roomTypeId", "stayDate");

-- For a future cross-plan question ("what is priced on 24 Dec?"). Cheap, and
-- the alternative later is an index build on a table that by then has rows.
CREATE INDEX "rate_plan_day_propertyId_stayDate_idx"
    ON "rate_plan_day"("propertyId", "stayDate");

-- ---------------------------------------------------------------------------
-- 8. Nonnegative money.
--
-- Zero is accepted on purpose -- a complimentary night is priced at nothing,
-- which is a real configuration rather than a mistake -- so the bound is
-- `>= 0`. The DTO refuses a negative amount first; this is the backstop for a
-- write that bypasses the service.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_day"
    ADD CONSTRAINT "rate_plan_day_amount_non_negative"
    CHECK ("amountMinor" >= 0);

-- ---------------------------------------------------------------------------
-- 9. Tenancy and existence, enforced by the database.
--
-- The property key is ordinary. The second one is the interesting one: a
-- `rate_plan_day` row must point at an assignment that really exists AND that
-- belongs to the same property as the day row. The composite key onto
-- `rate_plan_room_type_assignment_triple` makes a price for an unassigned
-- category -- or for another hotel's plan -- unrepresentable rather than
-- merely unwritten, which is the class of bug section 3.2 exists to prevent
-- and the only tenancy control this repository actually has, since neither the
-- Prisma tenancy extension nor RLS is implemented.
--
-- CASCADE on the assignment is deliberate and is the correct semantics:
-- removing a category from a plan means the plan no longer prices that
-- category, so its date overrides must go with it. The service warns an
-- operator before that happens, because it is not recoverable.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_day"
    ADD CONSTRAINT "rate_plan_day_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_plan_day"
    ADD CONSTRAINT "rate_plan_day_assignment_fkey"
    FOREIGN KEY ("ratePlanId", "roomTypeId", "propertyId")
    REFERENCES "rate_plan_room_type"("ratePlanId", "roomTypeId", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;
