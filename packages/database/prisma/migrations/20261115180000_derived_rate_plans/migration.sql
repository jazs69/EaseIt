-- ---------------------------------------------------------------------------
-- Derived (linked) rate plans (AV-06).
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. Three nullable columns on
-- `rate_plan`; every existing plan reads as not derived (all NULL).
--
-- A derived plan has no prices of its own: each night is its parent's resolved
-- rate adjusted by a signed percentage (basis points) or a signed fixed amount,
-- computed when the night is priced, so it always follows the parent. One level
-- only -- enforced by the service, since a CHECK cannot see another row.
-- ---------------------------------------------------------------------------

ALTER TABLE "rate_plan" ADD COLUMN "parentRatePlanId" UUID;
ALTER TABLE "rate_plan" ADD COLUMN "derivationKind" TEXT;
ALTER TABLE "rate_plan" ADD COLUMN "derivationValue" INTEGER;

-- All three or none: a half-described derivation would price nothing sensible.
ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_derivation_complete"
    CHECK (
        ("parentRatePlanId" IS NULL AND "derivationKind" IS NULL AND "derivationValue" IS NULL)
        OR ("parentRatePlanId" IS NOT NULL AND "derivationKind" IS NOT NULL AND "derivationValue" IS NOT NULL)
    );

ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_derivation_kind_known"
    CHECK ("derivationKind" IS NULL OR "derivationKind" IN ('PERCENT', 'FIXED'));

-- -100% .. +100% in basis points; FIXED bounded to keep integer arithmetic safe.
ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_derivation_value_range"
    CHECK (
        "derivationValue" IS NULL
        OR ("derivationKind" = 'PERCENT' AND "derivationValue" BETWEEN -10000 AND 10000)
        OR ("derivationKind" = 'FIXED' AND "derivationValue" BETWEEN -100000000 AND 100000000)
    );

ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_not_derived_from_itself"
    CHECK ("parentRatePlanId" IS NULL OR "parentRatePlanId" <> "id");

ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_parentRatePlanId_fkey"
    FOREIGN KEY ("parentRatePlanId") REFERENCES "rate_plan"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The parent must be this property's own plan (section 3.2).
ALTER TABLE "rate_plan"
    ADD CONSTRAINT "rate_plan_same_property_as_parent"
    FOREIGN KEY ("parentRatePlanId", "propertyId")
    REFERENCES "rate_plan"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
