-- ===========================================================================
-- Property operations dashboard: meal plan, settled amount, magic link, and
-- payment-gateway onboarding state.
--
-- Effect on existing rows: additive only. The three new `reservation` columns
-- all have defaults (EP, 0, false), so the one seeded booking is unaffected.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS REMOVED FROM THE GENERATED OUTPUT, AND WHY
--
-- `prisma migrate diff` wanted to drop five foreign keys and three unique
-- indexes added by 20261016140000_inventory_and_reservations:
--
--   * ALTER TABLE "inventory_day" DROP CONSTRAINT "inventory_day_same_property_as_room_type";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_reservation";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room";
--   * ALTER TABLE "reservation_room" DROP CONSTRAINT "reservation_room_same_property_as_room_type";
--   * ALTER TABLE "room" DROP CONSTRAINT "room_same_property_as_room_type";
--   * DROP INDEX "reservation_property_id_unique_pair";
--   * DROP INDEX "room_property_id_unique_pair";
--   * DROP INDEX "room_type_property_id_unique_pair";
--
-- Those are the tenant-coherence constraints that stop a reservation at one
-- hotel being assigned a room at another. They are absent from schema.prisma
-- because Prisma cannot express a composite foreign key onto a non-primary
-- key, so every future `migrate diff` will propose dropping them again. They
-- are deleted from the generated SQL each time, never from the database
-- (CLAUDE.md section 6.2: a constraint is not weakened to make a diff clean).
-- ---------------------------------------------------------------------------
-- ===========================================================================

-- CreateEnum
CREATE TYPE "MealPlan" AS ENUM ('EP', 'CP', 'MAP', 'AP');

-- CreateEnum
CREATE TYPE "PaymentGatewayProvider" AS ENUM ('RAZORPAY', 'STRIPE');

-- CreateEnum
CREATE TYPE "PaymentGatewayStatus" AS ENUM ('PENDING_KYC', 'ACTIVE', 'INACTIVE');

-- AlterEnum
ALTER TYPE "ReservationStatus" ADD VALUE 'ON_HOLD';

-- AlterTable
ALTER TABLE "reservation" ADD COLUMN     "isMagicLinkActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mealPlan" "MealPlan" NOT NULL DEFAULT 'EP',
ADD COLUMN     "paidAmountMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payment_gateway_config" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "provider" "PaymentGatewayProvider" NOT NULL,
    "status" "PaymentGatewayStatus" NOT NULL DEFAULT 'PENDING_KYC',
    "merchantId" TEXT,
    "onboardingDueDate" DATE,
    "activatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_gateway_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_gateway_config_propertyId_status_idx" ON "payment_gateway_config"("propertyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_config_propertyId_provider_key" ON "payment_gateway_config"("propertyId", "provider");

-- CreateIndex
CREATE INDEX "reservation_propertyId_createdAt_idx" ON "reservation"("propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "reservation_propertyId_isMagicLinkActive_idx" ON "reservation"("propertyId", "isMagicLinkActive");

-- AddForeignKey
ALTER TABLE "payment_gateway_config" ADD CONSTRAINT "payment_gateway_config_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
