-- ---------------------------------------------------------------------------
-- Per-night pricing for reservations (rates increment F9).
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. One nullable column is added to
-- `reservation` (every existing stay reads as rack-rate priced, NULL) and one
-- new, empty table is created. Existing stays get no `reservation_night` rows;
-- their nights keep being derived from the reservation totals, exactly as
-- before. Nothing is backfilled.
--
-- Hand-written for the composite tenancy foreign keys and CHECKs, which Prisma
-- cannot express (CLAUDE.md section 2).
-- ---------------------------------------------------------------------------

ALTER TABLE "reservation" ADD COLUMN "ratePlanId" UUID;

-- RESTRICT: a plan that priced a stay cannot be deleted out from under it.
-- Plans are archived, never deleted, so this costs nothing in practice.
ALTER TABLE "reservation"
    ADD CONSTRAINT "reservation_ratePlanId_fkey"
    FOREIGN KEY ("ratePlanId") REFERENCES "rate_plan"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- And the plan must be this property's own (section 3.2). MATCH SIMPLE: a
-- NULL ratePlanId is not checked, so rack-rate stays need no special case.
ALTER TABLE "reservation"
    ADD CONSTRAINT "reservation_same_property_as_rate_plan"
    FOREIGN KEY ("ratePlanId", "propertyId")
    REFERENCES "rate_plan"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "reservation_propertyId_ratePlanId_idx"
    ON "reservation"("propertyId", "ratePlanId");

CREATE TABLE "reservation_night" (
    "id"             UUID           NOT NULL,
    "propertyId"     UUID           NOT NULL,
    "reservationId"  UUID           NOT NULL,
    "stayDate"       DATE           NOT NULL,
    "rateMinor"      INTEGER        NOT NULL,
    "taxMinor"       INTEGER        NOT NULL,
    "taxRatePercent" DECIMAL(5,2)   NOT NULL,
    "currency"       CHAR(3)        NOT NULL,
    "rateSource"     TEXT           NOT NULL,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_night_pkey" PRIMARY KEY ("id")
);

-- Leads with propertyId (section 3.2). One price per night per stay.
CREATE UNIQUE INDEX "reservation_night_propertyId_reservationId_stayDate_key"
    ON "reservation_night"("propertyId", "reservationId", "stayDate");
CREATE INDEX "reservation_night_propertyId_stayDate_idx"
    ON "reservation_night"("propertyId", "stayDate");

ALTER TABLE "reservation_night"
    ADD CONSTRAINT "reservation_night_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reservation_night"
    ADD CONSTRAINT "reservation_night_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "reservation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- A night's reservation must be the night's own property's.
ALTER TABLE "reservation_night"
    ADD CONSTRAINT "reservation_night_same_property_as_reservation"
    FOREIGN KEY ("reservationId", "propertyId")
    REFERENCES "reservation"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Integer minor units, never negative (section 3.4).
ALTER TABLE "reservation_night"
    ADD CONSTRAINT "reservation_night_amounts_non_negative"
    CHECK ("rateMinor" >= 0 AND "taxMinor" >= 0);

ALTER TABLE "reservation_night"
    ADD CONSTRAINT "reservation_night_tax_rate_range"
    CHECK ("taxRatePercent" >= 0 AND "taxRatePercent" <= 100);

ALTER TABLE "reservation_night"
    ADD CONSTRAINT "reservation_night_rate_source_known"
    CHECK ("rateSource" IN
        ('DATE_OVERRIDE', 'SEASONAL', 'WEEKDAY', 'WEEKEND', 'DEFAULT', 'RACK', 'MANUAL'));
