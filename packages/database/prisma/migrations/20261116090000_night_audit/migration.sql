-- NA-01 .. NA-06: night audit runs, their steps, and immutable daily snapshots.
-- Additive: three new tables, two new enums, two new outbox event types.
-- No existing row is touched.

-- CreateEnum
CREATE TYPE "NightAuditRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "NightAuditStepStatus" AS ENUM ('COMPLETED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutboxEventType" ADD VALUE 'NIGHT_AUDIT_RUN';
ALTER TYPE "OutboxEventType" ADD VALUE 'NIGHT_AUDIT_COMPLETED';

-- CreateTable
CREATE TABLE "night_audit_run" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" "NightAuditRunStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "lastError" TEXT,

    CONSTRAINT "night_audit_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "night_audit_step" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "NightAuditStepStatus" NOT NULL,
    "outcome" JSONB NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "night_audit_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_snapshot" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "runId" UUID NOT NULL,
    "roomsPhysical" INTEGER NOT NULL,
    "roomsBlocked" INTEGER NOT NULL,
    "roomsAvailable" INTEGER NOT NULL,
    "roomsSold" INTEGER NOT NULL,
    "occupancyBp" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "roomRevenueMinor" INTEGER NOT NULL,
    "adrMinor" INTEGER NOT NULL,
    "revparMinor" INTEGER NOT NULL,
    "serviceRevenueMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "paymentsMinor" INTEGER NOT NULL,
    "refundsMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "night_audit_run_propertyId_createdAt_idx" ON "night_audit_run"("propertyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_run_propertyId_businessDate_key" ON "night_audit_run"("propertyId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_step_propertyId_runId_step_key" ON "night_audit_step"("propertyId", "runId", "step");

-- CreateIndex
CREATE UNIQUE INDEX "daily_snapshot_propertyId_businessDate_key" ON "daily_snapshot"("propertyId", "businessDate");

-- AddForeignKey
ALTER TABLE "night_audit_run" ADD CONSTRAINT "night_audit_run_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_step" ADD CONSTRAINT "night_audit_step_runId_fkey" FOREIGN KEY ("runId") REFERENCES "night_audit_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_snapshot" ADD CONSTRAINT "daily_snapshot_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Steps are 1..8, the canonical order of CLAUDE.md section 3.3.
ALTER TABLE "night_audit_step"
  ADD CONSTRAINT "night_audit_step_number_in_range" CHECK ("step" BETWEEN 1 AND 8);

-- A snapshot's room counts are never negative; occupancy is integer basis points.
-- Money is not constrained: a day's net payments can go negative when a
-- correction reverses more than was taken that day, and that must be recorded.
ALTER TABLE "daily_snapshot"
  ADD CONSTRAINT "daily_snapshot_counts_non_negative" CHECK (
    "roomsPhysical" >= 0 AND "roomsBlocked" >= 0 AND "roomsAvailable" >= 0 AND
    "roomsSold" >= 0 AND "occupancyBp" >= 0
  );

-- Append-only (section 3.3): a closed day's figures are never rewritten.
-- Corrections are adjustments on the current business date. Deleting is left
-- to the property cascade, which only a property's removal reaches.
CREATE OR REPLACE FUNCTION "daily_snapshot_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'daily_snapshot is append-only; post an adjustment on the current business date instead'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "daily_snapshot_append_only"
  BEFORE UPDATE ON "daily_snapshot"
  FOR EACH ROW EXECUTE FUNCTION "daily_snapshot_refuse_update"();
