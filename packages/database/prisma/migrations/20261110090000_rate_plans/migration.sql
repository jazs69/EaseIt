-- ---------------------------------------------------------------------------
-- Rate plans: named, sellable price lists (scope F1).
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. It creates one enum and two new
-- tables. No existing table gains, loses or alters a column; no constraint on
-- `room_type`, `inventory_day`, `reservation`, `reservation_room` or `folio`
-- is added, altered or dropped; nothing is backfilled.
--
-- In particular `room_type.baseRateMinor` IS NOT READ, COPIED OR MIGRATED.
-- It remains exactly what the booking path prices from
-- (`create-reservation.service.ts`). Integrating rate plans into quoting and
-- booking is F9 and is not in this migration or this increment, so both
-- tables ship empty and nothing prices from them until then.
--
-- Hand-written rather than generated, because Prisma cannot express the
-- CHECK constraints or the composite foreign keys below (CLAUDE.md section 2
-- permits raw SQL for exactly these).
-- ---------------------------------------------------------------------------

CREATE TYPE "RatePlanKind" AS ENUM (
    'STANDARD', 'CORPORATE', 'PACKAGE', 'PROMOTIONAL', 'COMPLIMENTARY'
);

CREATE TABLE "rate_plan" (
    "id"               UUID            NOT NULL,
    "propertyId"       UUID            NOT NULL,
    "code"             TEXT            NOT NULL,
    "name"             TEXT            NOT NULL,
    "description"      TEXT,
    "kind"             "RatePlanKind"  NOT NULL DEFAULT 'STANDARD',
    "currency"         CHAR(3)         NOT NULL,
    "defaultRateMinor" INTEGER         NOT NULL,
    "baseOccupancy"    INTEGER         NOT NULL DEFAULT 2,
    "isActive"         BOOLEAN         NOT NULL DEFAULT true,
    "archivedAt"       TIMESTAMPTZ(6),
    "sortOrder"        INTEGER         NOT NULL DEFAULT 0,
    "createdByUserId"  UUID            NOT NULL,
    "createdAt"        TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMPTZ(6)  NOT NULL,

    CONSTRAINT "rate_plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rate_plan_room_type" (
    "propertyId" UUID           NOT NULL,
    "ratePlanId" UUID           NOT NULL,
    "roomTypeId" UUID           NOT NULL,
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_plan_room_type_pkey" PRIMARY KEY ("ratePlanId", "roomTypeId")
);

-- ---------------------------------------------------------------------------
-- 1. Uniqueness, all of it per-property.
--
-- A code or name unique globally would couple unrelated hotels -- two
-- properties may both sell a plan called "BAR", and must (CLAUDE.md section
-- 3.2). Every index leads with `propertyId` for the same reason: one that did
-- not would make one hotel's query plan depend on another's row count.
--
-- `rate_plan_property_id_unique_pair` is not redundant with the primary key.
-- It is the pair a composite foreign key must reference, so the `rate_plan_day`
-- table in F2 can be *provably* same-property rather than merely written that
-- way -- the same device `room_property_id_unique_pair` and
-- `room_type_property_id_unique_pair` provide (migration 20261016140000).
-- Adding it now means F2 is purely additive.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "rate_plan_unique_code_per_property"
    ON "rate_plan"("propertyId", "code");

CREATE UNIQUE INDEX "rate_plan_unique_name_per_property"
    ON "rate_plan"("propertyId", "name");

ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_property_id_unique_pair" UNIQUE ("id", "propertyId");

CREATE INDEX "rate_plan_propertyId_isActive_sortOrder_idx"
    ON "rate_plan"("propertyId", "isActive", "sortOrder");

CREATE INDEX "rate_plan_room_type_propertyId_roomTypeId_idx"
    ON "rate_plan_room_type"("propertyId", "roomTypeId");

CREATE INDEX "rate_plan_room_type_propertyId_ratePlanId_idx"
    ON "rate_plan_room_type"("propertyId", "ratePlanId");

-- ---------------------------------------------------------------------------
-- 2. Plain foreign keys.
--
-- The property cascades: deleting a property is already understood to take its
-- whole operational record with it, exactly as `room_block` and `room_type` do.
--
-- `ratePlanId` cascades, because a plan's room-type links are part of the plan
-- and mean nothing without it. `roomTypeId` is RESTRICT: a category still
-- referenced by a plan must not vanish from under it, leaving the plan priced
-- for something that no longer exists. Same rule as `room_block`.
--
-- `createdByUserId` carries NO foreign key, deliberately and consistently with
-- `room_block.createdByUserId`: attribution must survive a staff member being
-- removed, and a RESTRICT here would block that while a CASCADE would erase
-- the authorship of live configuration.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_ratePlanId_fkey"
    FOREIGN KEY ("ratePlanId") REFERENCES "rate_plan"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_roomTypeId_fkey"
    FOREIGN KEY ("roomTypeId") REFERENCES "room_type"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Money is a non-negative integer in the currency's minor unit.
--
-- Section 3.4: minor units, never a float. Zero is accepted on purpose -- a
-- COMPLIMENTARY plan prices at nothing, which is a real configuration rather
-- than a mistake -- so the bound is `>= 0`, not `> 0`.
--
-- The DTO refuses a negative rate first, so this CHECK is the backstop for a
-- write that bypasses the service, not the primary control. It is here because
-- a rate that could go negative would make a folio credit indistinguishable
-- from a priced night.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_default_rate_non_negative"
    CHECK ("defaultRateMinor" >= 0);

ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_base_occupancy_positive"
    CHECK ("baseOccupancy" >= 1 AND "baseOccupancy" <= 20);

-- ---------------------------------------------------------------------------
-- 4. The currency is a currency.
--
-- CHAR(3) alone would accept 'ab ' or '123'. An ISO-4217 alphabetic code is
-- three uppercase letters, and the service additionally refuses any value that
-- is not the property's own currency -- but that is an application rule, and
-- this is the shape rule. Both matter: the service guarantees agreement, the
-- CHECK guarantees legibility.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_currency_is_iso_alpha"
    CHECK ("currency" ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- 5. Archived implies inactive -- one-directionally.
--
-- `archivedAt` is the terminal state, and a plan that is archived but still
-- offerable is a contradiction the UI would have to paper over. The converse
-- is NOT asserted: an inactive plan is ordinarily just paused, and making this
-- a biconditional would force every deactivation to archive, which is exactly
-- the reversibility deactivation exists to provide.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_archived_implies_inactive"
    CHECK ("archivedAt" IS NULL OR "isActive" = false);

-- ---------------------------------------------------------------------------
-- 6. Tenancy, enforced by the database.
--
-- A link row's plan and room type must belong to the link's own property.
-- These composite foreign keys ride on `rate_plan_property_id_unique_pair`
-- (section 1 above) and on `room_type_property_id_unique_pair`, which
-- migration 20261016140000 added for exactly this purpose. Together they make
-- a cross-property rate plan unrepresentable rather than merely unwritten --
-- the class of bug section 3.2 exists to prevent, and the one control this
-- repository actually has, since neither the Prisma tenancy extension nor RLS
-- is implemented.
--
-- Column ORDER matters: it must match `UNIQUE ("id", "propertyId")` on the
-- referenced tables, so the referencing side is ("<fk>Id", "propertyId") --
-- identical to `room_block_same_property_as_room_type` and
-- `reservation_room_same_property_as_room_type`.
--
-- Deletion rules are repeated here rather than relaxed: PostgreSQL enforces
-- each foreign key independently, so a composite key left at the default NO
-- ACTION would quietly contradict the RESTRICT in section 2.
-- ---------------------------------------------------------------------------
ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_same_property_as_plan"
    FOREIGN KEY ("ratePlanId", "propertyId")
    REFERENCES "rate_plan"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rate_plan_room_type"
    ADD CONSTRAINT "rate_plan_room_type_same_property_as_room_type"
    FOREIGN KEY ("roomTypeId", "propertyId")
    REFERENCES "room_type"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
