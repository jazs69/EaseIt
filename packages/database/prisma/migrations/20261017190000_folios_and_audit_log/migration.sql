-- ===========================================================================
-- Folios, the folio ledger, and the audit log.
--
-- Effect on existing rows: additive. No reservation gains a folio
-- retroactively — the 883 seeded bookings have none, which is accurate,
-- because nothing had ever opened one. A folio is created when a guest checks
-- in, and only then.
--
-- WHY A SINGLE LEDGER TABLE, NOT `FolioTransaction` + `FolioPayment`
-- The brief named two tables. Section 3.4 requires a folio balance to be
-- derived by summing its lines; across two tables that sum spans two queries,
-- two reversal paths, and two opportunities to disagree. `folio_line` holds
-- both with a `kind` discriminator and a SIGNED `amountMinor` — charges
-- positive, payments negative — so the balance is one `SUM(amountMinor)` with
-- no per-kind branching. A branching sum is precisely where a payment
-- eventually gets added instead of subtracted.
--
-- WHY THERE IS NO `balanceAmount` COLUMN
-- Section 3.4 forbids caching a derived balance in a mutable column. The
-- absence is the feature: there is no second number that can drift from the
-- ledger it came from.
--
-- THE DOUBLE-POSTING GUARD (the important part)
-- The brief posts the first night's room charge at check-in. Section 3.3 step
-- 3 has the night audit post room charges for in-house stays per business
-- date. Both are correct, and together they would charge night one twice. The
-- partial unique index below makes a non-reversed ROOM_CHARGE unique per
-- (folio, charge date), so whichever runs second is refused by the database
-- rather than silently duplicating. A guest disputing a bill the system
-- insists is right is the exact failure this prevents.
--
-- IMMUTABILITY
-- `folio_line` is append-only by contract: corrections post a reversing line
-- carrying `reversesLineId`. That is enforced in the domain layer rather than
-- by a trigger, because the night audit legitimately needs to post, and a
-- blanket UPDATE/DELETE trigger would have to be bypassed by it anyway.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. They are stripped from the generated SQL, never from the
-- database (CLAUDE.md section 6.2):
--   * ALTER TABLE "inventory_day" DROP CONSTRAINT "inventory_day_same_property_as_room_type";
--   * ALTER TABLE "reservation" DROP CONSTRAINT "reservation_same_property_as_company";
--   * ALTER TABLE "reservation_guest" DROP CONSTRAINT "reservation_guest_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room_type";
--   * ALTER TABLE "room" DROP CONSTRAINT "room_same_property_as_room_type";
--   * DROP INDEX "company_property_id_unique_pair";
--   * DROP INDEX "reservation_property_id_unique_pair";
--   * DROP INDEX "room_property_id_unique_pair";
--   * DROP INDEX "room_type_property_id_unique_pair";
-- ===========================================================================

-- CreateEnum
CREATE TYPE "FolioLineKind" AS ENUM ('ROOM_CHARGE', 'TAX', 'SERVICE_CHARGE', 'PAYMENT', 'REFUND', 'ADJUSTMENT');
-- CreateEnum
CREATE TYPE "FolioStatus" AS ENUM ('OPEN', 'CLOSED', 'TRANSFERRED');
-- AlterTable
ALTER TABLE "reservation" ADD COLUMN     "checkedInBy" UUID,
ADD COLUMN     "keyCardsIssued" INTEGER,
ADD COLUMN     "registrationCardSigned" BOOLEAN NOT NULL DEFAULT false;
-- CreateTable
CREATE TABLE "folio" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "status" "FolioStatus" NOT NULL DEFAULT 'OPEN',
    "currency" CHAR(3) NOT NULL,
    "openedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(6),
    CONSTRAINT "folio_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "folio_line" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "kind" "FolioLineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "chargeDate" DATE NOT NULL,
    "derivedFromLineId" UUID,
    "reversesLineId" UUID,
    "postedById" UUID,
    "paymentMethod" "PaymentMethod",
    "remark" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "folio_line_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "actorUserId" UUID,
    "event" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "folio_reservationId_key" ON "folio"("reservationId");
-- CreateIndex
CREATE INDEX "folio_propertyId_status_idx" ON "folio"("propertyId", "status");
-- CreateIndex
CREATE INDEX "folio_line_propertyId_folioId_chargeDate_idx" ON "folio_line"("propertyId", "folioId", "chargeDate");
-- CreateIndex
CREATE INDEX "folio_line_propertyId_kind_chargeDate_idx" ON "folio_line"("propertyId", "kind", "chargeDate");
-- CreateIndex
CREATE INDEX "audit_log_propertyId_createdAt_idx" ON "audit_log"("propertyId", "createdAt");
-- CreateIndex
CREATE INDEX "audit_log_propertyId_entityType_entityId_idx" ON "audit_log"("propertyId", "entityType", "entityId");
-- AddForeignKey
ALTER TABLE "folio" ADD CONSTRAINT "folio_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "folio" ADD CONSTRAINT "folio_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "folio_line" ADD CONSTRAINT "folio_line_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "folio_line" ADD CONSTRAINT "folio_line_derivedFromLineId_fkey" FOREIGN KEY ("derivedFromLineId") REFERENCES "folio_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "folio_line" ADD CONSTRAINT "folio_line_reversesLineId_fkey" FOREIGN KEY ("reversesLineId") REFERENCES "folio_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (see the header).
-- ---------------------------------------------------------------------------

-- The double-posting guard. Partial, so a reversed line does not block a
-- corrected re-post of the same night, and so only ROOM_CHARGE is constrained
-- — a guest may legitimately buy two coffees on one date.
CREATE UNIQUE INDEX "folio_line_one_room_charge_per_date"
  ON "folio_line" ("folioId", "chargeDate")
  WHERE "kind" = 'ROOM_CHARGE' AND "reversesLineId" IS NULL;

-- A payment that increases the balance is a charge wearing the wrong label,
-- and a charge that decreases it is a credit. The sign carries meaning, so the
-- database enforces it rather than trusting every call site to get it right.
ALTER TABLE "folio_line"
  ADD CONSTRAINT "folio_line_sign_matches_kind"
  CHECK (
    ("kind" IN ('PAYMENT') AND "amountMinor" <= 0)
    OR ("kind" IN ('ROOM_CHARGE', 'TAX', 'SERVICE_CHARGE', 'REFUND') AND "amountMinor" >= 0)
    OR "kind" = 'ADJUSTMENT'
  );

-- Pairs a composite FK can point at.
CREATE UNIQUE INDEX "folio_property_id_unique_pair" ON "folio" ("propertyId", "id");

-- A folio belongs to the same property as its reservation.
ALTER TABLE "folio"
  ADD CONSTRAINT "folio_same_property_as_reservation"
  FOREIGN KEY ("propertyId", "reservationId")
  REFERENCES "reservation" ("propertyId", "id")
  ON DELETE CASCADE;

-- A line belongs to the same property as its folio.
ALTER TABLE "folio_line"
  ADD CONSTRAINT "folio_line_same_property_as_folio"
  FOREIGN KEY ("propertyId", "folioId")
  REFERENCES "folio" ("propertyId", "id")
  ON DELETE CASCADE;

-- Key cards are a count, not a signed quantity.
ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_key_cards_non_negative"
  CHECK ("keyCardsIssued" IS NULL OR "keyCardsIssued" >= 0);
