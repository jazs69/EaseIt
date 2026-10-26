-- ===========================================================================
-- Columns the master report needs: cancellation, attribution, OTA settlement,
-- promotions, deposits and card instrument detail.
--
-- Effect on existing rows: **purely additive**. Every new column is either
-- nullable or carries a default, so the 932 reservations and 99 folios take
-- the defaults and nothing is rewritten. No existing column is altered,
-- renamed or dropped, and every live path keeps working through the deploy.
--
-- WHY THESE EXIST
-- The master report specifies 65 columns. 47 had a source; these 18 did not,
-- and were shown in the column picker disabled with the reason they were
-- waiting on. The alternative asked for was to fill them with placeholder
-- values at render time, which would have put invented rupee figures — OTA
-- commission, promo discounts, deposits — in the same table as real ones that
-- reconcile against a real ledger. Somebody reconciling a bank statement
-- against a fabricated commission column is the failure this avoids.
--
-- Giving them real columns gets the same outcome honestly: the report reads
-- them from the database like every other figure, the demo portfolio seeds
-- realistic values so the table populates when the columns are toggled on, and
-- a production property with nothing recorded shows zero or blank — which is
-- true, and which a placeholder would have hidden.
--
-- The modules that will own these writes do not exist yet (`channels` for OTA
-- settlement, a promotions module, the folio deposits tab). Until they land,
-- only the seed populates them. That is the same position `checkedInAt` was
-- in before the front desk was built, and it is stated here rather than
-- discovered later.
--
-- WHAT IS DELIBERATELY NOT HERE
-- No PAN, expiry or CVV. `cardLast4` is CHAR(4) with a digits-only CHECK, so
-- the schema cannot hold a full card number even by accident — storing one
-- would put this database in PCI DSS scope and nothing here is built to that
-- standard. Four digits identify a card to a guest disputing a charge, which
-- is the whole purpose of the column.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. All 17 are stripped from the generated SQL below and remain
-- in the database (CLAUDE.md section 6.2):
--   * the 11 `*_same_property_as_*` composite foreign keys, and
--   * the 6 `*_property_id_unique_pair` indexes they point at.
-- ===========================================================================

ALTER TABLE "folio" ADD COLUMN     "customFolioId" TEXT;

ALTER TABLE "folio_line" ADD COLUMN     "cardLast4" CHAR(4),
ADD COLUMN     "isExternalCard" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isExternalSource" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentIssuer" TEXT;

ALTER TABLE "reservation" ADD COLUMN     "appliedCouponCode" TEXT,
ADD COLUMN     "bookingReferenceId" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMPTZ(6),
ADD COLUMN     "complimentaryRemarks" TEXT,
ADD COLUMN     "depositMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isComplimentary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "otaCommissionMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otaNetAmountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otaPrepaidAmountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otaTaxMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promoAmountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scantyBaggage" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "segment" TEXT;

CREATE UNIQUE INDEX "folio_propertyId_customFolioId_key" ON "folio"("propertyId", "customFolioId");

-- ---------------------------------------------------------------------------
-- Hand-written invariants (see the header).
-- ---------------------------------------------------------------------------

-- Every new monetary column is an amount, so it is non-negative like every
-- other amount in this schema (CLAUDE.md section 3.4). A negative OTA
-- commission is a refund and belongs on its own line, not as a sign flip on
-- the booking.
ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_ota_amounts_non_negative"
  CHECK (
    "otaPrepaidAmountMinor" >= 0
    AND "otaCommissionMinor" >= 0
    AND "otaTaxMinor" >= 0
    AND "otaNetAmountMinor" >= 0
  );

ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_promo_and_deposit_non_negative"
  CHECK ("promoAmountMinor" >= 0 AND "depositMinor" >= 0);

-- A cancellation timestamp belongs only to a cancelled booking. Set on a
-- confirmed one it would make the master report show a live stay as cancelled
-- on a date, which is a contradiction no reader can resolve.
ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_cancelled_at_matches_status"
  CHECK (
    "cancelledAt" IS NULL
    OR "status" IN ('CANCELLED', 'NO_SHOW')
  );

-- A reason for something that did not happen cannot be interpreted. The remark
-- is permitted only where the stay is actually complimentary.
ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_complimentary_remarks_need_complimentary"
  CHECK ("complimentaryRemarks" IS NULL OR "isComplimentary" = true);

-- A coupon code without a discount, or a discount without a code, is half a
-- record. Either both or neither.
ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_promo_code_matches_amount"
  CHECK (
    ("appliedCouponCode" IS NULL AND "promoAmountMinor" = 0)
    OR ("appliedCouponCode" IS NOT NULL AND "promoAmountMinor" > 0)
  );

-- Four digits, nothing else.
--
-- This is the constraint that keeps a full card number out of the database:
-- CHAR(4) alone would still accept 'abcd' or a truncated PAN fragment, and a
-- column that can hold part of a card number invites code that puts more of
-- one in it. Digits-only makes the intent unambiguous and unviolatable.
ALTER TABLE "folio_line"
  ADD CONSTRAINT "folio_line_card_last4_is_four_digits"
  CHECK ("cardLast4" IS NULL OR "cardLast4" ~ '^[0-9]{4}$');

-- Card detail belongs to a payment or a refund. A room charge carrying an
-- issuer is a row somebody filled in by mistake.
ALTER TABLE "folio_line"
  ADD CONSTRAINT "folio_line_card_detail_needs_money_movement"
  CHECK (
    ("cardLast4" IS NULL AND "paymentIssuer" IS NULL)
    OR "kind" IN ('PAYMENT', 'REFUND')
  );
