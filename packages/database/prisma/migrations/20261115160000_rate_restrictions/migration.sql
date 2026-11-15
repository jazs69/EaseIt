-- ---------------------------------------------------------------------------
-- Stay restrictions per rate plan, room type and night (AV-07).
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. One new, empty table. A night with
-- no row is unrestricted, so every existing plan behaves exactly as before.
--
-- Hand-written for the composite assignment/tenancy foreign key and CHECKs.
-- ---------------------------------------------------------------------------

CREATE TABLE "rate_restriction_day" (
    "id"                UUID           NOT NULL,
    "propertyId"        UUID           NOT NULL,
    "ratePlanId"        UUID           NOT NULL,
    "roomTypeId"        UUID           NOT NULL,
    "stayDate"          DATE           NOT NULL,
    "minLos"            INTEGER,
    "closedToArrival"   BOOLEAN        NOT NULL DEFAULT false,
    "closedToDeparture" BOOLEAN        NOT NULL DEFAULT false,
    "updatedByUserId"   UUID           NOT NULL,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_restriction_day_pkey" PRIMARY KEY ("id")
);

-- One restriction row per plan, category and night; leads with propertyId.
CREATE UNIQUE INDEX "rate_restriction_day_unique_per_date"
    ON "rate_restriction_day"("propertyId", "ratePlanId", "roomTypeId", "stayDate");

-- A minimum stay is at least two nights to mean anything, and bounded.
ALTER TABLE "rate_restriction_day"
    ADD CONSTRAINT "rate_restriction_day_min_los_range"
    CHECK ("minLos" IS NULL OR ("minLos" >= 1 AND "minLos" <= 365));

-- An all-default row restricts nothing; the service deletes instead of storing one.
ALTER TABLE "rate_restriction_day"
    ADD CONSTRAINT "rate_restriction_day_restricts_something"
    CHECK ("minLos" IS NOT NULL OR "closedToArrival" OR "closedToDeparture");

ALTER TABLE "rate_restriction_day"
    ADD CONSTRAINT "rate_restriction_day_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The plan/room-type assignment must exist AND be this property's: one
-- composite key settles both, as it does for rate_plan_day (section 3.2).
ALTER TABLE "rate_restriction_day"
    ADD CONSTRAINT "rate_restriction_day_assignment_fkey"
    FOREIGN KEY ("ratePlanId", "roomTypeId", "propertyId")
    REFERENCES "rate_plan_room_type"("ratePlanId", "roomTypeId", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;
