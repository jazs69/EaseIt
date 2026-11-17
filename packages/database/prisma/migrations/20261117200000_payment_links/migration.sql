-- FO-15: Razorpay payment links. Additive: one enum, one empty table, a
-- shape CHECK, a same-property trigger and row-level security. No existing
-- row changes. payment_gateway_config is unchanged; it becomes the
-- per-property switch that allows links.
-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('CREATING', 'ACTIVE', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED', 'NEEDS_ATTENTION');

-- CreateTable
CREATE TABLE "payment_link" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "provider" "PaymentGatewayProvider" NOT NULL,
    "providerLinkId" TEXT,
    "shortUrl" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "amountPaidMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'CREATING',
    "lastError" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_link_propertyId_createdAt_idx" ON "payment_link"("propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_link_propertyId_folioId_idx" ON "payment_link"("propertyId", "folioId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_link_propertyId_idempotencyKey_key" ON "payment_link"("propertyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payment_link_propertyId_provider_providerLinkId_key" ON "payment_link"("propertyId", "provider", "providerLinkId");

-- AddForeignKey
ALTER TABLE "payment_link" ADD CONSTRAINT "payment_link_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_link" ADD CONSTRAINT "payment_link_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_link" ADD CONSTRAINT "payment_link_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written guarantees. Never remove.
-- ===========================================================================

-- A link is for real money (Razorpay's INR minimum is 100 paise), never paid
-- below zero, and once the provider confirmed it, it carries the provider id.
ALTER TABLE "payment_link"
  ADD CONSTRAINT "payment_link_amounts" CHECK (
    "amountMinor" >= 100 AND "amountPaidMinor" >= 0
  ),
  ADD CONSTRAINT "payment_link_confirmed_has_provider_id" CHECK (
    "status" IN ('CREATING', 'FAILED') OR "providerLinkId" IS NOT NULL
  );

-- The folio and stay a link names belong to the link's property, and to each
-- other (section 3.2). The service checks; this is the backstop.
CREATE OR REPLACE FUNCTION "payment_link_same_property"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "folio" f
        WHERE f."id" = NEW."folioId" AND f."propertyId" = NEW."propertyId"
          AND f."reservationId" = NEW."reservationId") THEN
    RAISE EXCEPTION 'payment_link: folio and stay are not of this property'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_link_same_property';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_link_same_property"
  BEFORE INSERT OR UPDATE OF "folioId", "reservationId", "propertyId" ON "payment_link"
  FOR EACH ROW EXECUTE FUNCTION "payment_link_same_property"();

-- MT-04: tenant row-level security.
ALTER TABLE "payment_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payment_link"
  USING ("tenant_row_visible"("propertyId"))
  WITH CHECK ("tenant_row_visible"("propertyId"));
