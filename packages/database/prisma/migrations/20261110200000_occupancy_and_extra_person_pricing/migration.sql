-- ---------------------------------------------------------------------------
-- F4: occupancy and extra-person pricing.
--
-- FORWARD-ONLY. Migrations 20261110090000 (F1), 20261110140000 (F2) and
-- 20261110170000 (F3) are not touched. Applied state lives in
-- `_prisma_migrations` inside each database and no database was inspected or
-- connected to for this change, so the repository holds no proof of what has
-- run — editing a predecessor could leave an environment inconsistent with its
-- own history and would fail `migrate deploy` on a checksum mismatch.
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing that changes a price.
--
--   * `rate_plan_room_type` gains six columns, every one of them with a
--     default that means "no extra-guest charge". `occupancyPricingEnabled`
--     defaults to FALSE, so every assignment created under F1, F2 or F3 keeps
--     pricing exactly as it did. An operator opts in per assignment.
--   * `baseOccupancy` IS NOT READ, ALTERED OR BACKFILLED. Its existing values
--     stand, which is required: silently changing one would change what an
--     operator's configured default rate is understood to include.
--   * NOTHING ELSE IS TOUCHED. No constraint on `rate_plan`, `rate_plan_day`,
--     `rate_pricing_rule`, `rate_pricing_rule_price`, `room_type`,
--     `inventory_day`, `reservation`, `reservation_room` or `folio_line` is
--     added, altered or dropped. `room_type.baseRateMinor` is untouched and
--     remains what the booking path prices from until F9.
--
-- Hand-written rather than generated, because Prisma cannot express the
-- conditional CHECK constraints below (CLAUDE.md section 2 permits raw SQL for
-- exactly these). PostgreSQL 17.6, read from `postgres --version` on the local
-- toolchain; no server was contacted.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. How an extra-guest charge is expressed.
--
-- `PERCENT` is relative to the RESOLVED nightly base rate, so it moves with an
-- F2 date override and with an F3 seasonal or weekday rule — which is the
-- whole point of expressing a charge as a percentage. `FIXED` is an absolute
-- amount per extra guest per night and never inherits the base rate.
-- ---------------------------------------------------------------------------
CREATE TYPE "ExtraGuestChargeKind" AS ENUM ('FIXED', 'PERCENT');

-- ---------------------------------------------------------------------------
-- 2. The configuration, on the assignment that already owns `baseOccupancy`.
--
-- Per (rate plan, room type) rather than per rate plan or per room type,
-- because both axes vary in practice: a corporate plan may absorb an extra
-- adult that the public plan charges for, and a suite's extra bed is not
-- priced like a standard room's. The assignment is the only row that is
-- specific to both, and it already holds the base occupancy these charges are
-- measured against.
--
-- Every default is the neutral one. A row that nobody has configured
-- contributes nothing to any price, which is what makes this migration safe to
-- apply to a database already holding F1/F2/F3 configuration.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_room_type"
    ADD COLUMN "occupancyPricingEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "rate_plan_room_type"
    ADD COLUMN "includedChildren" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "rate_plan_room_type"
    ADD COLUMN "extraAdultChargeKind" "ExtraGuestChargeKind" NOT NULL DEFAULT 'FIXED';

ALTER TABLE "rate_plan_room_type"
    ADD COLUMN "extraAdultChargeValue" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "rate_plan_room_type"
    ADD COLUMN "extraChildChargeKind" "ExtraGuestChargeKind" NOT NULL DEFAULT 'FIXED';

ALTER TABLE "rate_plan_room_type"
    ADD COLUMN "extraChildChargeValue" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. Included children are a SUBSET of the included headcount.
--
-- `baseOccupancy` is the total number of guests the base rate covers;
-- `includedChildren` says how many of them may be children. So the included
-- adults are the difference, and `includedChildren > baseOccupancy` would make
-- that difference negative — a configuration with no meaning and no action an
-- operator could take on it.
--
-- Note this constraint also binds any future change to `baseOccupancy`:
-- lowering it below `includedChildren` is refused by the database, not merely
-- by the service. The service checks the MERGED state first so the refusal
-- arrives as a 400 naming the field rather than as an opaque constraint
-- violation.
--
-- `baseOccupancy >= 1` and `<= 20` are already enforced by
-- `rate_plan_room_type_base_occupancy_positive` from F2's migration and are
-- deliberately not restated here.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_included_children_within_base"
    CHECK ("includedChildren" >= 0 AND "includedChildren" <= "baseOccupancy");

-- ---------------------------------------------------------------------------
-- 4. Charges are nonnegative, and bounded per kind.
--
-- ZERO IS VALID AND IS THE DEFAULT. A property that admits a third adult at no
-- charge is expressing a real policy, not leaving a field blank — so the bound
-- is `>= 0`, matching `rate_plan_day_amount_non_negative` and
-- `rate_plan_room_type_default_rate_non_negative`.
--
-- The upper bounds differ by kind because the units differ, and a single bound
-- would be meaningless for one of them:
--
--   * FIXED is minor units, capped at 2,000,000,000 — the same ceiling the
--     rate DTOs use, which keeps the column inside INTEGER and keeps the
--     product of a charge and a guest count inside a safe integer.
--   * PERCENT is BASIS POINTS, capped at 100,000 = 1000%. An extra adult
--     costing ten times the room is already absurd; beyond that the cap exists
--     so `base * bps` cannot approach the safe-integer limit.
--
-- Written as two conditional CHECKs rather than one combined expression, so a
-- violation names which kind's rule was broken.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_extra_adult_charge_valid"
    CHECK (
        "extraAdultChargeValue" >= 0
        AND (
            ("extraAdultChargeKind" = 'FIXED' AND "extraAdultChargeValue" <= 2000000000)
            OR ("extraAdultChargeKind" = 'PERCENT' AND "extraAdultChargeValue" <= 100000)
        )
    );

ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_extra_child_charge_valid"
    CHECK (
        "extraChildChargeValue" >= 0
        AND (
            ("extraChildChargeKind" = 'FIXED' AND "extraChildChargeValue" <= 2000000000)
            OR ("extraChildChargeKind" = 'PERCENT' AND "extraChildChargeValue" <= 100000)
        )
    );

-- ---------------------------------------------------------------------------
-- 5. WHAT THE DATABASE CANNOT ENFORCE, AND WHO DOES.
--
-- `baseOccupancy <= room_type."maxGuests"` is a cross-table invariant, and a
-- CHECK constraint may only reference columns of its own row. The options were:
--
--   * a trigger — rejected: it would have to fire on `room_type` updates too
--     (lowering `maxGuests` can invalidate an assignment configured months
--     ago), which is a second write path into the pricing tables and a
--     surprise for whoever next edits a room type;
--   * a generated/denormalised copy of `maxGuests` on the assignment —
--     rejected: it is a second source of truth for a room type's capacity,
--     which is precisely the ambiguity F2 removed from `defaultRateMinor`.
--
-- So it is validated in the service, on both sides: creating or editing an
-- assignment checks it, and the occupancy-pricing endpoint re-checks the
-- merged state. That is the weaker layer and is claimed as exactly that — a
-- write bypassing the service can store an assignment whose base occupancy
-- exceeds the room's capacity. The resolver therefore also reports the
-- condition at read time rather than assuming it cannot happen.
--
-- Guest-count limits (`maxGuests`, `maxAdults`) are not stored here at all:
-- they are properties of the room type and are read from it when a composition
-- is priced or previewed.
-- ---------------------------------------------------------------------------
