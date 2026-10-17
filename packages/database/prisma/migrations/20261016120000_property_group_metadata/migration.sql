-- ===========================================================================
-- Group-level metadata on `property`, for the multi-property group dashboard.
--
-- Effect on existing rows: all 10 properties are rewritten in place.
--   * `code`     is backfilled with a stable 5-digit number (31001, 31002, …)
--                assigned in slug order, then made NOT NULL UNIQUE.
--   * `status`   is derived from the `isActive` boolean it replaces:
--                true -> ACTIVE, false -> INACTIVE. No row loses information.
--   * `division` and `logoUrl` are nullable and start empty; the seed fills
--                them for the dev portfolio.
--
-- `prisma migrate diff` generated a version of this that could not run and
-- would have lost data, so it is hand-edited. Two problems with the generated
-- form, both worth stating because they will recur:
--
--   1. `ADD COLUMN "code" TEXT NOT NULL` with no default fails outright on a
--      non-empty table. Split into add-nullable, backfill, set-not-null.
--   2. `DROP COLUMN "isActive"` ran *before* anything read it, so every
--      deactivated property would have silently come back as ACTIVE (the
--      column default). The UPDATE below has to happen first.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "PropertyStatus" AS ENUM ('ACTIVE', 'ONBOARDING', 'INACTIVE');

-- ---------------------------------------------------------------------------
-- status: derive from isActive, then retire the boolean.
-- ---------------------------------------------------------------------------

ALTER TABLE "property" ADD COLUMN "status" "PropertyStatus" NOT NULL DEFAULT 'ACTIVE';

-- Must precede the DROP. ONBOARDING is not reachable from a boolean, so no
-- existing row can land there; it only applies to properties created later.
UPDATE "property" SET "status" = 'INACTIVE' WHERE "isActive" = false;

DROP INDEX "property_isActive_idx";
ALTER TABLE "property" DROP COLUMN "isActive";

-- CreateIndex
CREATE INDEX "property_status_idx" ON "property"("status");

-- ---------------------------------------------------------------------------
-- code: add nullable, backfill deterministically, then constrain.
-- ---------------------------------------------------------------------------

ALTER TABLE "property" ADD COLUMN "code" TEXT;

-- Ordered by slug so the assignment is reproducible: re-running this migration
-- against the same data produces the same codes, which matters because staff
-- will have written them down.
WITH numbered AS (
  SELECT "id", 31000 + ROW_NUMBER() OVER (ORDER BY "slug") AS generated
  FROM "property"
)
UPDATE "property" AS p
SET "code" = numbered.generated::text
FROM numbered
WHERE p."id" = numbered."id" AND p."code" IS NULL;

ALTER TABLE "property" ALTER COLUMN "code" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "property_code_key" ON "property"("code");

-- ---------------------------------------------------------------------------
-- Presentation metadata for the group dashboard.
-- ---------------------------------------------------------------------------

ALTER TABLE "property" ADD COLUMN "division" TEXT;
ALTER TABLE "property" ADD COLUMN "logoUrl" TEXT;
