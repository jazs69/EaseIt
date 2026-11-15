-- ---------------------------------------------------------------------------
-- Negative tax on folio corrections (FO-05 / FO-06).
--
-- WHAT THIS DOES TO EXISTING ROWS: adds one column defaulting to false; no
-- existing folio line is updated (lines are immutable, section 3.4). Every
-- existing TAX line keeps meaning what it meant.
--
-- WHY. A downward correction of a taxed charge needs a NEGATIVE tax delta, and
-- `folio_line_sign_matches_kind` (kept unchanged, by owner decision) requires
-- TAX lines to be >= 0. Such a delta is therefore posted as an ADJUSTMENT --
-- which the constraint allows in either sign -- flagged as tax. Tax is read
-- everywhere as `kind = 'TAX' OR "isTaxAdjustment"`.
-- ---------------------------------------------------------------------------

ALTER TABLE "folio_line" ADD COLUMN "isTaxAdjustment" BOOLEAN NOT NULL DEFAULT false;

-- Only an adjustment that hangs off another line can be a tax adjustment: a
-- flagged PAYMENT or a free-standing flagged line would be tax with no charge
-- to attribute it to.
ALTER TABLE "folio_line"
    ADD CONSTRAINT "folio_line_tax_adjustment_shape"
    CHECK (
        NOT "isTaxAdjustment"
        OR ("kind" = 'ADJUSTMENT' AND "derivedFromLineId" IS NOT NULL)
    );
