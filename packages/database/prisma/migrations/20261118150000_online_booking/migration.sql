-- BE-03: one row per booking made on the public booking engine.
--
-- Links the signed quote a guest booked from to the reservation it produced
-- (one booking per quote, so a double submit returns the first booking), and
-- records the guest's payment choice. The reservation itself is an ordinary
-- row written by the staff booking transaction.
--
-- Existing rows: none change. A new, empty table.

CREATE TABLE "online_booking" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "paymentChoice" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_booking_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "online_booking_payment_choice_known"
      CHECK ("paymentChoice" IN ('PAY_AT_HOTEL', 'PAY_NOW'))
);

CREATE UNIQUE INDEX "online_booking_propertyId_quoteId_key" ON "online_booking"("propertyId", "quoteId");
CREATE UNIQUE INDEX "online_booking_propertyId_reservationId_key" ON "online_booking"("propertyId", "reservationId");

ALTER TABLE "online_booking" ADD CONSTRAINT "online_booking_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "online_booking" ADD CONSTRAINT "online_booking_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The stay must belong to the same property (section 3.2), structurally.
ALTER TABLE "online_booking" ADD CONSTRAINT "online_booking_same_property_as_reservation"
  FOREIGN KEY ("reservationId", "propertyId") REFERENCES "reservation"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "online_booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "online_booking" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "online_booking"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));
