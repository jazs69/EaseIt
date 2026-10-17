-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('TENTATIVE', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('VACANT_CLEAN', 'VACANT_DIRTY', 'OCCUPIED_CLEAN', 'OCCUPIED_DIRTY', 'INSPECTED', 'OUT_OF_SERVICE', 'OUT_OF_ORDER');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('DIRECT_WEB', 'FRONT_DESK', 'PHONE', 'WALK_IN', 'OTA', 'CORPORATE', 'TRAVEL_AGENT');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "isTwoFactorEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "room_type" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "maxGuests" INTEGER NOT NULL,
    "maxAdults" INTEGER,
    "baseRateMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "overbookingAllowance" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "room_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "floor" TEXT,
    "status" "RoomStatus" NOT NULL DEFAULT 'VACANT_CLEAN',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_day" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "stayDate" DATE NOT NULL,
    "physical" INTEGER NOT NULL,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "overbookingAllowance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "source" "BookingSource" NOT NULL DEFAULT 'FRONT_DESK',
    "arrivalDate" DATE NOT NULL,
    "departureDate" DATE NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "guestFirstName" TEXT NOT NULL,
    "guestLastName" TEXT NOT NULL,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "totalAmountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_room" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "roomId" UUID,
    "arrivalDate" DATE NOT NULL,
    "departureDate" DATE NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservation_room_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_type_propertyId_sortOrder_idx" ON "room_type"("propertyId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "room_type_propertyId_code_key" ON "room_type"("propertyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "room_type_propertyId_name_key" ON "room_type"("propertyId", "name");

-- CreateIndex
CREATE INDEX "room_propertyId_roomTypeId_idx" ON "room"("propertyId", "roomTypeId");

-- CreateIndex
CREATE INDEX "room_propertyId_status_idx" ON "room"("propertyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "room_propertyId_number_key" ON "room"("propertyId", "number");

-- CreateIndex
CREATE INDEX "inventory_day_propertyId_stayDate_idx" ON "inventory_day"("propertyId", "stayDate");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_day_propertyId_roomTypeId_stayDate_key" ON "inventory_day"("propertyId", "roomTypeId", "stayDate");

-- CreateIndex
CREATE INDEX "reservation_propertyId_arrivalDate_idx" ON "reservation"("propertyId", "arrivalDate");

-- CreateIndex
CREATE INDEX "reservation_propertyId_departureDate_idx" ON "reservation"("propertyId", "departureDate");

-- CreateIndex
CREATE INDEX "reservation_propertyId_status_idx" ON "reservation"("propertyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_propertyId_confirmationCode_key" ON "reservation"("propertyId", "confirmationCode");

-- CreateIndex
CREATE INDEX "reservation_room_propertyId_roomId_arrivalDate_idx" ON "reservation_room"("propertyId", "roomId", "arrivalDate");

-- CreateIndex
CREATE INDEX "reservation_room_propertyId_arrivalDate_idx" ON "reservation_room"("propertyId", "arrivalDate");

-- CreateIndex
CREATE INDEX "reservation_room_reservationId_idx" ON "reservation_room"("reservationId");

-- CreateIndex
CREATE INDEX "reservation_room_roomTypeId_idx" ON "reservation_room"("roomTypeId");

-- AddForeignKey
ALTER TABLE "room_type" ADD CONSTRAINT "room_type_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room" ADD CONSTRAINT "room_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room" ADD CONSTRAINT "room_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_day" ADD CONSTRAINT "inventory_day_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_day" ADD CONSTRAINT "inventory_day_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_type"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_room" ADD CONSTRAINT "reservation_room_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_room" ADD CONSTRAINT "reservation_room_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_room" ADD CONSTRAINT "reservation_room_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN INVARIANTS — CLAUDE.md section 3.1
--
-- Everything above this line was generated by `prisma migrate diff`.
-- Everything below it cannot be expressed in schema.prisma and is the reason
-- this file is reviewed rather than regenerated. Per section 6.2 these are
-- never dropped or weakened to make a write pass: if one of them blocks code,
-- the code is wrong.
--
-- Effect on existing rows: none. Every table below is new in this migration,
-- and the one altered column (`user.isTwoFactorEnabled`) has a safe default of
-- true, so existing accounts become *more* protected rather than less.
-- ===========================================================================

-- Required for an exclusion constraint that mixes equality on a uuid with
-- overlap on a range. GiST alone cannot do `=` on a scalar; btree_gist adds it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. The oversell guarantee.
--
-- Selling a room is `UPDATE inventory_day SET sold = sold + 1` for each stay
-- date. Two concurrent bookings for the last room both try it; the second
-- fails this CHECK and its whole transaction rolls back. This holds under any
-- isolation level, which is precisely why the guarantee lives here and not in
-- application code that could be bypassed or raced.
-- ---------------------------------------------------------------------------
ALTER TABLE "inventory_day"
    ADD CONSTRAINT "inventory_day_not_oversold"
    CHECK ("sold" + "blocked" <= "physical" + "overbookingAllowance");

-- Counters are counts. A negative `sold` would silently create availability
-- out of nothing, which is the mirror image of an oversell and just as wrong.
ALTER TABLE "inventory_day"
    ADD CONSTRAINT "inventory_day_counters_non_negative"
    CHECK ("physical" >= 0 AND "sold" >= 0 AND "blocked" >= 0 AND "overbookingAllowance" >= 0);

-- ---------------------------------------------------------------------------
-- 2. The double-booking guarantee.
--
-- The same physical room can never hold two overlapping stays. '[)' makes the
-- range half-open — departure day exclusive — because a room checked out in
-- the morning is sellable that night, and '[]' would wrongly reject that.
--
-- The WHERE clause makes this a *partial* constraint: cancelled and no-show
-- rows stop participating, so a room freed by a cancellation is immediately
-- re-sellable while the cancelled row is kept for audit.
--
-- Rows with a NULL roomId never conflict, because NULL is not equal to NULL in
-- GiST. Unassigned reservations therefore coexist freely, and the constraint
-- begins to bite the moment a room number is assigned.
-- ---------------------------------------------------------------------------
ALTER TABLE "reservation_room"
    ADD CONSTRAINT "reservation_room_no_overlap"
    EXCLUDE USING gist (
        "roomId" WITH =,
        daterange("arrivalDate", "departureDate", '[)') WITH &&
    ) WHERE ("status" NOT IN ('CANCELLED', 'NO_SHOW'));

-- ---------------------------------------------------------------------------
-- 3. Stay ranges must be real.
--
-- A zero-night or inverted range would make `daterange` empty, and an empty
-- range overlaps nothing — so such a row would slip past the exclusion
-- constraint above and occupy a room invisibly. This CHECK is what keeps
-- constraint 2 honest.
-- ---------------------------------------------------------------------------
ALTER TABLE "reservation"
    ADD CONSTRAINT "reservation_departure_after_arrival"
    CHECK ("departureDate" > "arrivalDate");

ALTER TABLE "reservation_room"
    ADD CONSTRAINT "reservation_room_departure_after_arrival"
    CHECK ("departureDate" > "arrivalDate");

-- Occupancy and money sanity. `totalAmountMinor` is an integer count of the
-- currency's minor unit and may be zero (a comp stay) but never negative — a
-- refund is a folio line, not a negative reservation total (section 3.4).
ALTER TABLE "reservation"
    ADD CONSTRAINT "reservation_occupancy_and_total_sane"
    CHECK ("adults" >= 1 AND "children" >= 0 AND "totalAmountMinor" >= 0);

ALTER TABLE "room_type"
    ADD CONSTRAINT "room_type_rate_and_occupancy_sane"
    CHECK ("baseRateMinor" >= 0 AND "maxGuests" >= 1 AND "overbookingAllowance" >= 0);

-- ---------------------------------------------------------------------------
-- 4. Tenant coherence.
--
-- A reservation_room row carries `propertyId` of its own so that tenant-scoped
-- reads lead with it (section 3.2). That denormalisation is only safe if it
-- cannot disagree with the parent reservation, so the pair is a composite
-- foreign key rather than two independent ones. Without this, a mis-stamped
-- propertyId would hide a room assignment from the very tenant that owns it.
-- ---------------------------------------------------------------------------
ALTER TABLE "reservation"
    ADD CONSTRAINT "reservation_property_id_unique_pair"
    UNIQUE ("id", "propertyId");

ALTER TABLE "reservation_room"
    ADD CONSTRAINT "reservation_room_same_property_as_reservation"
    FOREIGN KEY ("reservationId", "propertyId")
    REFERENCES "reservation"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The same rule for the assigned room: a reservation at one hotel must never
-- be assignable to a room at another.
ALTER TABLE "room"
    ADD CONSTRAINT "room_property_id_unique_pair"
    UNIQUE ("id", "propertyId");

ALTER TABLE "reservation_room"
    ADD CONSTRAINT "reservation_room_same_property_as_room"
    FOREIGN KEY ("roomId", "propertyId")
    REFERENCES "room"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- And for the room type, on both tables that reference one.
ALTER TABLE "room_type"
    ADD CONSTRAINT "room_type_property_id_unique_pair"
    UNIQUE ("id", "propertyId");

ALTER TABLE "reservation_room"
    ADD CONSTRAINT "reservation_room_same_property_as_room_type"
    FOREIGN KEY ("roomTypeId", "propertyId")
    REFERENCES "room_type"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_day"
    ADD CONSTRAINT "inventory_day_same_property_as_room_type"
    FOREIGN KEY ("roomTypeId", "propertyId")
    REFERENCES "room_type"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "room"
    ADD CONSTRAINT "room_same_property_as_room_type"
    FOREIGN KEY ("roomTypeId", "propertyId")
    REFERENCES "room_type"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
