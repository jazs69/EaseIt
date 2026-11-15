-- ---------------------------------------------------------------------------
-- F3: seasonal, weekday and weekend pricing rules.
--
-- FORWARD-ONLY. Migrations 20261110090000 (F1) and 20261110140000 (F2) are not
-- touched. Applied state lives in `_prisma_migrations` inside each database and
-- no database was inspected or connected to for this change, so the repository
-- contains no proof of what has or has not run — editing either predecessor
-- could leave an environment inconsistent with its own history and would fail
-- `migrate deploy` on a checksum mismatch.
--
-- WHAT THIS DOES TO EXISTING ROWS.
--
--   * `property_settings` gains ONE column, `weekendDays`, with a default of
--     Sunday and Saturday. Existing rows get that default, which is exactly the
--     behaviour the two hardcoded Sat/Sun checks in `timeline.service.ts`
--     already give them. Nothing is reinterpreted.
--   * Two new tables are created, empty.
--   * NOTHING ELSE IS TOUCHED. No existing column is altered or dropped. No
--     constraint on `rate_plan`, `rate_plan_room_type`, `rate_plan_day`,
--     `room_type`, `inventory_day`, `reservation`, `reservation_room` or
--     `folio_line` is added, altered or dropped. No F1 or F2 rate data is
--     read, rewritten or deleted. `room_type.baseRateMinor` is untouched and
--     remains what the booking path prices from until F9.
--
-- Hand-written rather than generated, because Prisma cannot express the
-- conditional CHECK constraints, the array containment checks or the composite
-- foreign keys below (CLAUDE.md section 2 permits raw SQL for exactly these).
--
-- PostgreSQL 17.6 (read from `postgres --version` on the local toolchain; no
-- server was contacted). `btree_gist` was installed by 20261016140000 and is
-- not needed here — see the note on overlap enforcement at section 7.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The property's own weekend definition.
--
-- Weekend pricing cannot be built on a guess. Saturday and Sunday is right for
-- a Goa resort, wrong for a Gulf property (Friday and Saturday), and wrong
-- again for a city hotel whose peak is Sunday to Thursday. A WEEKEND rule asks
-- "is this night a weekend night" and only the property can answer.
--
-- Day numbering is 0 = Sunday … 6 = Saturday, matching JavaScript's
-- `getUTCDay()`, so no translation layer exists to get wrong.
--
-- An EMPTY array is legal and means "no weekend", which makes every WEEKEND
-- rule match nothing. That is a real configuration for a property that prices
-- only by named weekdays, and permitting it is better than forcing a fake
-- weekend on it.
-- ---------------------------------------------------------------------------
ALTER TABLE "property_settings"
    ADD COLUMN "weekendDays" INTEGER[] NOT NULL DEFAULT ARRAY[0, 6];

-- `<@` is array containment: every element must be a real day number. Without
-- this, `weekendDays = {9}` is storable and would make a WEEKEND rule silently
-- match nothing with no indication why.
ALTER TABLE "property_settings"
    ADD CONSTRAINT "property_settings_weekend_days_valid"
    CHECK (
        "weekendDays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
        AND array_length("weekendDays", 1) IS DISTINCT FROM 0
        AND COALESCE(array_length("weekendDays", 1), 0) <= 7
    );

-- ---------------------------------------------------------------------------
-- 2. The rule itself.
--
-- One table for all three kinds. A season and a weekday rule differ only in
-- how they decide whether a night matches; the plan, the per-room-type prices,
-- priority, enablement, naming and auditing are identical. Four tables would
-- mean two of each of those, and two of anything is two things that drift.
-- The CHECK constraints in section 4 make the illegal field combinations
-- unrepresentable, which is the same device `room_block_specific_is_one_room`
-- uses.
--
-- DATES ARE INCLUSIVE AT BOTH ENDS. This DIFFERS from `room_block` and
-- `reservation_room`, deliberately, and the difference is worth stating: those
-- model stays, where the departure day is still sellable, so they are
-- half-open `[)`. A season is a set of nights an operator names — "20 December
-- through 10 January" means both of those nights. A half-open season would
-- silently drop its last night, the kind of off-by-one that surfaces only in a
-- December revenue report.
--
-- A SEASON CROSSING NEW YEAR needs no special handling: `startDate`
-- 2026-12-20 with `endDate` 2027-01-10 is an ordinary range whose end is after
-- its start. What is NOT implemented is a *recurring annual* season with no
-- year component ("every 20 Dec to 10 Jan, forever"), which would need
-- wrap-around matching where `endDate < startDate` means "spans the year
-- boundary". That is a different feature with its own ambiguities and is
-- recorded as deferred rather than half-built.
-- ---------------------------------------------------------------------------
CREATE TYPE "RatePricingRuleKind" AS ENUM ('SEASONAL', 'WEEKDAY', 'WEEKEND');

CREATE TABLE "rate_pricing_rule" (
    "id"              UUID                  NOT NULL,
    "propertyId"      UUID                  NOT NULL,
    "ratePlanId"      UUID                  NOT NULL,
    "kind"            "RatePricingRuleKind" NOT NULL,
    "name"            TEXT                  NOT NULL,
    "startDate"       DATE,
    "endDate"         DATE,
    "daysOfWeek"      INTEGER[]             NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "priority"        INTEGER               NOT NULL DEFAULT 0,
    "isEnabled"       BOOLEAN               NOT NULL DEFAULT true,
    "createdByUserId" UUID                  NOT NULL,
    "createdAt"       TIMESTAMPTZ(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMPTZ(6)        NOT NULL,

    CONSTRAINT "rate_pricing_rule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rate_pricing_rule_price" (
    "propertyId"  UUID           NOT NULL,
    "ruleId"      UUID           NOT NULL,
    "ratePlanId"  UUID           NOT NULL,
    "roomTypeId"  UUID           NOT NULL,
    "amountMinor" INTEGER        NOT NULL,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_pricing_rule_price_pkey" PRIMARY KEY ("ruleId", "roomTypeId")
);

-- ---------------------------------------------------------------------------
-- 3. Uniqueness and indexes, all leading with `propertyId`.
--
-- An index that did not lead with `propertyId` would make one hotel's query
-- plan depend on another's row count (CLAUDE.md section 3.2).
--
-- `rate_pricing_rule_plan_triple` is not redundant with the primary key. It is
-- the triple the price table's composite foreign key references, and that key
-- is what proves a price row belongs to a rule of the SAME plan and property —
-- the device `rate_plan_room_type_assignment_triple` provides for
-- `rate_plan_day`.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "rate_pricing_rule_unique_name_per_plan"
    ON "rate_pricing_rule"("propertyId", "ratePlanId", "name");

ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_plan_triple"
    UNIQUE ("id", "ratePlanId", "propertyId");

-- The resolver's read: one plan's enabled rules, by precedence.
CREATE INDEX "rate_pricing_rule_resolve_idx"
    ON "rate_pricing_rule"("propertyId", "ratePlanId", "isEnabled", "kind", "priority");

-- Seasonal date-window scans.
CREATE INDEX "rate_pricing_rule_season_window_idx"
    ON "rate_pricing_rule"("propertyId", "ratePlanId", "startDate", "endDate");

CREATE INDEX "rate_pricing_rule_price_propertyId_roomTypeId_idx"
    ON "rate_pricing_rule_price"("propertyId", "roomTypeId");

CREATE INDEX "rate_pricing_rule_price_propertyId_ruleId_idx"
    ON "rate_pricing_rule_price"("propertyId", "ruleId");

-- ---------------------------------------------------------------------------
-- 4. Each kind carries exactly the fields it needs, and no others.
--
-- Structural, not conventional. A SEASONAL row with no dates would match
-- nothing and be indistinguishable from a bug; a WEEKDAY row that also carried
-- dates would raise the question of which one decides. These make both
-- unrepresentable rather than merely unwritten.
--
-- `array_length(x, 1)` is NULL for an empty array in PostgreSQL, not 0, which
-- is why `COALESCE` appears rather than a bare comparison — a bare
-- `array_length(...) = 0` is never true and the constraint would not do what it
-- says.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_seasonal_shape"
    CHECK (
        "kind" <> 'SEASONAL'
        OR (
            "startDate" IS NOT NULL
            AND "endDate" IS NOT NULL
            AND COALESCE(array_length("daysOfWeek", 1), 0) = 0
        )
    );

ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_weekday_shape"
    CHECK (
        "kind" <> 'WEEKDAY'
        OR (
            "startDate" IS NULL
            AND "endDate" IS NULL
            AND COALESCE(array_length("daysOfWeek", 1), 0) > 0
        )
    );

ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_weekend_shape"
    CHECK (
        "kind" <> 'WEEKEND'
        OR (
            "startDate" IS NULL
            AND "endDate" IS NULL
            AND COALESCE(array_length("daysOfWeek", 1), 0) = 0
        )
    );

-- Inclusive, so a one-night season has `endDate = startDate` and `>=` is
-- correct where `room_block_through_after_from` needed a strict `>`.
ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_dates_ordered"
    CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_days_valid"
    CHECK ("daysOfWeek" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]);

-- Bounded so a priority cannot be set to something that only sorts correctly
-- by accident, and so the UI can offer a sane control.
ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_priority_bounds"
    CHECK ("priority" >= 0 AND "priority" <= 1000);

-- ---------------------------------------------------------------------------
-- 5. Nonnegative money.
--
-- Zero is accepted on purpose — a complimentary or staff season is priced at
-- nothing, which is a real configuration rather than a mistake — so the bound
-- is `>= 0`. The DTO refuses a negative amount first; this is the backstop for
-- a write that bypasses the service, and it matches
-- `rate_plan_day_amount_non_negative` and
-- `rate_plan_room_type_default_rate_non_negative`.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_pricing_rule_price"
    ADD CONSTRAINT "rate_pricing_rule_price_non_negative"
    CHECK ("amountMinor" >= 0);

-- ---------------------------------------------------------------------------
-- 6. Tenancy and existence, enforced by the database.
--
-- The property keys are ordinary. The two on the price table are the
-- interesting ones, and together they deliver a guarantee neither could alone:
--
--   * `..._rule_triple` ties a price row to a rule of the SAME plan and
--     property. Because `ratePlanId` is part of the referenced triple, the
--     denormalised `ratePlanId` on the price row cannot disagree with its
--     rule's — the database keeps the copy honest rather than a service
--     remembering to.
--
--   * `..._assignment` ties the same row to a `rate_plan_room_type` row of
--     that plan. So pricing a category the plan does not even apply to is
--     unrepresentable.
--
-- Chained through `ratePlanId`, the pair means: this price belongs to this
-- rule, that rule belongs to this plan, and this plan really is assigned to
-- this room type at this property. That is the class of bug section 3.2 exists
-- to prevent, and it is the only tenancy control this repository actually has,
-- since neither the Prisma tenancy extension nor RLS is implemented.
--
-- CASCADE on the assignment is deliberate and consistent with
-- `rate_plan_day_assignment_fkey`: removing a category from a plan means the
-- plan no longer prices that category, so its rule prices go with it. The UI
-- warns before that happens.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_pricing_rule"
    ADD CONSTRAINT "rate_pricing_rule_same_property_as_plan"
    FOREIGN KEY ("ratePlanId", "propertyId")
    REFERENCES "rate_plan"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_pricing_rule_price"
    ADD CONSTRAINT "rate_pricing_rule_price_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_pricing_rule_price"
    ADD CONSTRAINT "rate_pricing_rule_price_rule_triple"
    FOREIGN KEY ("ruleId", "ratePlanId", "propertyId")
    REFERENCES "rate_pricing_rule"("id", "ratePlanId", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_pricing_rule_price"
    ADD CONSTRAINT "rate_pricing_rule_price_assignment"
    FOREIGN KEY ("ratePlanId", "roomTypeId", "propertyId")
    REFERENCES "rate_plan_room_type"("ratePlanId", "roomTypeId", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. WHY THERE IS NO EXCLUSION CONSTRAINT ON OVERLAPPING SEASONS.
--
-- The obvious move is a GiST exclusion constraint:
--
--     EXCLUDE USING gist ("ratePlanId" WITH =, "priority" WITH =,
--                         daterange("startDate", "endDate", '[]') WITH &&)
--       WHERE ("kind" = 'SEASONAL' AND "isEnabled")
--
-- It is deliberately NOT added, because it would be WRONG — too strict. Two
-- same-priority seasons whose dates overlap are perfectly legitimate when they
-- price DIFFERENT room types: "Christmas Suites" and "Christmas Standard" are
-- two rules over the same fortnight and they conflict with nothing. The room
-- types live in the child table, so a constraint on the parent row cannot see
-- them, and this one would reject valid configuration.
--
-- An exclusion constraint cannot be expressed over the join either: PostgreSQL
-- exclusion constraints are single-table.
--
-- So the ambiguity rule — same kind, overlapping match, SHARED room type,
-- equal priority — is enforced in the service, at write time, where the room
-- types are in hand. CLAUDE.md section 3.1 is clear that application checks
-- are the weaker layer, so what is claimed here is bounded accordingly: this
-- is validation, not a database guarantee, and a write that bypasses the
-- service can still create an ambiguity. `rate-pricing.policy.ts` therefore
-- detects one at READ time as well and reports it rather than resolving it by
-- row order.
--
-- What the database DOES guarantee is everything a single row can state: the
-- shape per kind, ordered dates, real day numbers, bounded priority,
-- nonnegative money, unique names per plan, and every tenancy relationship in
-- section 6.
-- ---------------------------------------------------------------------------
