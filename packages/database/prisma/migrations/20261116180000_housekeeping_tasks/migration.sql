-- HK-01 .. HK-04: housekeeping tasks. Additive: one table, three enums, one permission.
-- No existing row is changed.

-- CreateEnum
CREATE TYPE "HousekeepingTaskType" AS ENUM ('CLEAN', 'DEEP_CLEAN', 'TURNDOWN', 'INSPECTION');

-- CreateEnum
CREATE TYPE "HousekeepingTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PASSED', 'FAILED');

-- CreateTable
CREATE TABLE "housekeeping_task" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "type" "HousekeepingTaskType" NOT NULL,
    "status" "HousekeepingTaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToId" UUID,
    "notes" TEXT,
    "businessDate" DATE NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "completedById" UUID,
    "cancelledAt" TIMESTAMPTZ(6),
    "inspectionResult" "InspectionResult",

    CONSTRAINT "housekeeping_task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "housekeeping_task_propertyId_status_idx" ON "housekeeping_task"("propertyId", "status");

-- CreateIndex
CREATE INDEX "housekeeping_task_propertyId_roomId_idx" ON "housekeeping_task"("propertyId", "roomId");

-- CreateIndex
CREATE INDEX "housekeeping_task_propertyId_assignedToId_status_idx" ON "housekeeping_task"("propertyId", "assignedToId", "status");

-- AddForeignKey
ALTER TABLE "housekeeping_task" ADD CONSTRAINT "housekeeping_task_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_task" ADD CONSTRAINT "housekeeping_task_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "room"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one active task per room and type: two supervisors cannot both
-- queue the same cleaning. Partial, so finished and cancelled tasks are kept.
CREATE UNIQUE INDEX "housekeeping_task_one_active_per_room_and_type"
  ON "housekeeping_task" ("propertyId", "roomId", "type")
  WHERE "status" IN ('OPEN', 'IN_PROGRESS');

-- The outcome columns agree with the status.
ALTER TABLE "housekeeping_task"
  ADD CONSTRAINT "housekeeping_task_outcome_matches_status" CHECK (
    ("status" = 'DONE') = ("completedAt" IS NOT NULL)
    AND ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
    AND ("inspectionResult" IS NULL OR ("type" = 'INSPECTION' AND "status" = 'DONE'))
  );

-- MT-04: tenant row-level security, like every other property-scoped table.
ALTER TABLE "housekeeping_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "housekeeping_task" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "housekeeping_task"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

-- The new permission, so custom roles can grant it without a re-seed, and the
-- property administrator template holds it (the seed keeps both in sync too).
INSERT INTO "permission" ("id", "key", "label", "description", "category", "sensitive")
VALUES (gen_random_uuid(), 'housekeeping:manage', 'Supervise housekeeping',
        'Create and assign tasks, record inspections and mark rooms inspected.', 'HOUSEKEEPING', false)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT r."id", p."id"
  FROM "role" r CROSS JOIN "permission" p
 WHERE r."key" IN ('PROPERTY_ADMIN', 'SUPER_ADMIN') AND r."propertyId" IS NULL
   AND p."key" = 'housekeeping:manage'
ON CONFLICT DO NOTHING;
