-- MA-01: maintenance work orders. Additive: two enums, one empty table, a
-- shape CHECK, a same-property trigger, row-level security, and one
-- permission granted to the administrator templates. No existing row changes.
-- CreateEnum
CREATE TYPE "WorkOrderPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "work_order" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "WorkOrderPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'OPEN',
    "reportedById" UUID NOT NULL,
    "assignedToId" UUID,
    "roomBlockId" UUID,
    "resolutionNote" TEXT,
    "closedById" UUID,
    "closedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_order_propertyId_status_createdAt_idx" ON "work_order"("propertyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "work_order_propertyId_roomId_status_idx" ON "work_order"("propertyId", "roomId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_propertyId_roomBlockId_key" ON "work_order"("propertyId", "roomBlockId");

-- AddForeignKey
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_roomBlockId_fkey" FOREIGN KEY ("roomBlockId") REFERENCES "room_block"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written guarantees. Never remove.
-- ===========================================================================

-- A closed order (RESOLVED or CANCELLED) records who closed it and when; an
-- open one does not.
ALTER TABLE "work_order"
  ADD CONSTRAINT "work_order_closed_is_attributed" CHECK (
    ("status" IN ('RESOLVED', 'CANCELLED')) = ("closedAt" IS NOT NULL AND "closedById" IS NOT NULL)
  ),
  ADD CONSTRAINT "work_order_title_not_blank" CHECK (length(btrim("title")) > 0);

-- The room and the block an order names are this property's, and the block
-- withholds that same room (section 3.2).
CREATE OR REPLACE FUNCTION "work_order_same_property"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "room" WHERE "id" = NEW."roomId" AND "propertyId" = NEW."propertyId") THEN
    RAISE EXCEPTION 'work_order: room is not of this property'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'work_order_same_property';
  END IF;
  IF NEW."roomBlockId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "room_block"
        WHERE "id" = NEW."roomBlockId" AND "propertyId" = NEW."propertyId" AND "roomId" = NEW."roomId") THEN
    RAISE EXCEPTION 'work_order: the block is not this room''s at this property'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'work_order_same_property';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "work_order_same_property"
  BEFORE INSERT OR UPDATE OF "roomId", "roomBlockId", "propertyId" ON "work_order"
  FOR EACH ROW EXECUTE FUNCTION "work_order_same_property"();

-- MT-04: tenant row-level security.
ALTER TABLE "work_order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_order" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "work_order"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));

-- The new permission, so custom roles can grant it without a re-seed, and the
-- administrator templates hold it (the seed keeps both in sync too).
INSERT INTO "permission" ("id", "key", "label", "description", "category", "sensitive")
VALUES (gen_random_uuid(), 'maintenance:manage', 'Manage maintenance',
        'Assign, start, resolve and cancel work orders, and take a room out of order for one.',
        'HOUSEKEEPING', false)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT r."id", p."id"
  FROM "role" r CROSS JOIN "permission" p
 WHERE r."key" IN ('PROPERTY_ADMIN', 'SUPER_ADMIN') AND r."propertyId" IS NULL
   AND p."key" = 'maintenance:manage'
ON CONFLICT DO NOTHING;
