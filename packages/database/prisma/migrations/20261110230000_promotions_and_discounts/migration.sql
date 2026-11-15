-- ---------------------------------------------------------------------------
-- F5: promotions, promo codes and discounts.
--
-- FORWARD-ONLY. Migrations 20261110090000 (F1), 20261110140000 (F2),
-- 20261110170000 (F3) and 20261110200000 (F4) are not touched. Applied state
-- lives in `_prisma_migrations` inside each database and no database was
-- inspected or connected to for this change, so the repository holds no proof
-- of what has run — editing a predecessor could leave an environment
-- inconsistent with its own history and would fail `migrate deploy` on a
-- checksum mismatch.
--
-- WHAT THIS DOES TO EXISTING ROWS: NOTHING AT ALL.
--
-- It creates one enum and five new tables, all empty. No existing table gains,
-- loses or alters a column. No constraint on `rate_plan`,
-- `rate_plan_room_type`, `rate_plan_day`, `rate_pricing_rule`,
-- `rate_pricing_rule_price`, `room_type`, `inventory_day`, `reservation`,
-- `reservation_room` or `folio_line` is added, altered or dropped. No pricing
-- record of any kind is read, rewritten or deleted, and
-- `room_type.baseRateMinor` remains what the booking path prices from until
-- F9.
--
-- The one reference INTO an existing table is a composite foreign key from
-- `promotion_redemption` onto `reservation("id","propertyId")` — a constraint
-- on the new table, not a change to `reservation`. See section 8.
--
-- Hand-written rather than generated, because Prisma cannot express the
-- conditional CHECK constraints, the normalisation CHECKs or the composite
-- foreign keys below (CLAUDE.md section 2 permits raw SQL for exactly these).
-- PostgreSQL 17.6, read from `postgres --version` on the local toolchain; no
-- server was contacted.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. How a discount is expressed.
--
-- `FIXED_PER_NIGHT` is named for its SCOPE, not merely its kind. "₹500 off" is
-- ambiguous between per night and per stay, and that ambiguity is the sort
-- that surfaces later as a refund argument. Every other amount in this pricing
-- stack is nightly, so a fixed discount is nightly too — and the enum says so,
-- which leaves room for a `FIXED_PER_STAY` member later without
-- reinterpreting a single stored row.
-- ---------------------------------------------------------------------------
CREATE TYPE "PromotionDiscountKind" AS ENUM ('PERCENT', 'FIXED_PER_NIGHT');

-- ---------------------------------------------------------------------------
-- 2. The promotion.
--
-- DATES ARE INCLUSIVE AT BOTH ENDS and NULL means unbounded on that side, so a
-- promotion with no `stayThroughDate` runs until it is deactivated. Inclusive
-- matches the seasons of F3 and for the same reason: an operator naming
-- "20 December through 10 January" means both of those nights. It differs from
-- `room_block` and `reservation_room`, which model stays and are half-open
-- because a departure day is still sellable.
--
-- TWO INDEPENDENT WINDOWS. `stay*` bounds which NIGHTS qualify; `book*` bounds
-- WHEN the booking may be made. They are orthogonal — an early-bird promotion
-- has a narrow booking window and a wide stay window, and a flash sale the
-- reverse — so collapsing them into one range would make half the product
-- inexpressible.
--
-- APPLICABILITY IS TWO BOOLEANS PLUS TWO JOIN TABLES, never an empty set
-- standing in for "all". `appliesToAllRatePlans = true` means every plan and
-- the join is ignored; `false` means exactly the rows listed, and an empty
-- list means NOTHING qualifies. The service refuses to store a promotion that
-- can never apply, so the degenerate state is unreachable through the API
-- rather than merely unlikely.
-- ---------------------------------------------------------------------------
CREATE TABLE "promotion" (
    "id"                     UUID                    NOT NULL,
    "propertyId"             UUID                    NOT NULL,
    "name"                   TEXT                    NOT NULL,
    "description"            TEXT,
    "discountKind"           "PromotionDiscountKind" NOT NULL,
    "discountValue"          INTEGER                 NOT NULL,
    "priority"               INTEGER                 NOT NULL DEFAULT 0,
    "isActive"               BOOLEAN                 NOT NULL DEFAULT true,
    "stayFromDate"           DATE,
    "stayThroughDate"        DATE,
    "bookFromDate"           DATE,
    "bookThroughDate"        DATE,
    "minNights"              INTEGER,
    "maxNights"              INTEGER,
    "minEligibleAmountMinor" INTEGER,
    "appliesToAllRatePlans"  BOOLEAN                 NOT NULL DEFAULT false,
    "appliesToAllRoomTypes"  BOOLEAN                 NOT NULL DEFAULT false,
    "maxRedemptions"         INTEGER,
    "redeemedCount"          INTEGER                 NOT NULL DEFAULT 0,
    "createdByUserId"        UUID                    NOT NULL,
    "updatedByUserId"        UUID,
    "createdAt"              TIMESTAMPTZ(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMPTZ(6)          NOT NULL,

    CONSTRAINT "promotion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "promotion_rate_plan" (
    "propertyId"  UUID           NOT NULL,
    "promotionId" UUID           NOT NULL,
    "ratePlanId"  UUID           NOT NULL,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_rate_plan_pkey" PRIMARY KEY ("promotionId", "ratePlanId")
);

CREATE TABLE "promotion_room_type" (
    "propertyId"  UUID           NOT NULL,
    "promotionId" UUID           NOT NULL,
    "roomTypeId"  UUID           NOT NULL,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_room_type_pkey" PRIMARY KEY ("promotionId", "roomTypeId")
);

-- ---------------------------------------------------------------------------
-- 3. Promo codes.
--
-- A CODE IS A REDEMPTION MECHANISM, NOT A SECOND DISCOUNT ENGINE: it carries
-- no discount of its own, and eligibility and amount come from the promotion
-- it belongs to. A promotion may have several codes, or none — one with no
-- code applies automatically to any eligible stay.
--
-- TWO COLUMNS FOR ONE CODE. `code` is what the operator typed, kept for
-- display so "SUMMER24" does not come back as "summer24". `codeNormalized` is
-- upper-cased and trimmed and is the ONLY form matched or made unique. That is
-- how case-insensitive lookup is achieved without depending on a
-- case-insensitive collation or a functional index whose behaviour varies with
-- the database's locale — the normalisation is a stored fact, checked by the
-- constraints in section 6, not a property of how a query happens to be
-- written.
-- ---------------------------------------------------------------------------
CREATE TABLE "promo_code" (
    "id"              UUID           NOT NULL,
    "propertyId"      UUID           NOT NULL,
    "promotionId"     UUID           NOT NULL,
    "code"            TEXT           NOT NULL,
    "codeNormalized"  TEXT           NOT NULL,
    "isActive"        BOOLEAN        NOT NULL DEFAULT true,
    "expiresOn"       DATE,
    "maxRedemptions"  INTEGER,
    "redeemedCount"   INTEGER        NOT NULL DEFAULT 0,
    "createdByUserId" UUID           NOT NULL,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promo_code_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 4. Redemptions — SCAFFOLDING FOR F9, SHIPPED EMPTY.
--
-- F5 contains no writer for this table and none for either `redeemedCount`
-- column. A preview inserts nothing and moves no counter. The table exists now
-- for two reasons: a redemption counter with no record of what consumed it is
-- unauditable, and the shape determines whether F9 can consume atomically at
-- all.
--
-- THE ATOMIC CONSUMPTION CONTRACT F9 MUST USE, inside the reservation's own
-- transaction and in this order:
--
--   1. INSERT a row here. `promotion_redemption_unique_per_reservation` is the
--      idempotency key: a retried booking cannot redeem twice, and the second
--      insert fails on the unique index rather than silently double-counting.
--
--   2. Increment the counter CONDITIONALLY, in ONE statement:
--
--        UPDATE "promotion" SET "redeemedCount" = "redeemedCount" + 1
--         WHERE "id" = $1 AND "propertyId" = $2
--           AND ("maxRedemptions" IS NULL OR "redeemedCount" < "maxRedemptions");
--
--      Zero rows affected means exhausted, and the transaction rolls back.
--      This is NOT read-then-increment: the bound is re-tested inside the same
--      statement that performs the write, so two concurrent bookings cannot
--      both pass a check and both increment. Section 7's CHECK is the backstop
--      if a future writer forgets the predicate.
--
--   3. The same statement shape against `promo_code` when a code was used.
--
-- Nothing in F5 performs any of this. It is written down so F9 does not have to
-- rediscover it, and so that nobody ships a check-then-increment and calls it
-- safe.
-- ---------------------------------------------------------------------------
CREATE TABLE "promotion_redemption" (
    "id"                   UUID           NOT NULL,
    "propertyId"           UUID           NOT NULL,
    "promotionId"          UUID           NOT NULL,
    "promoCodeId"          UUID,
    "reservationId"        UUID           NOT NULL,
    "discountAppliedMinor" INTEGER        NOT NULL,
    "redeemedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemption_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 5. Uniqueness and indexes, all leading with `propertyId`.
--
-- An index that did not lead with `propertyId` would make one hotel's query
-- plan depend on another's row count (CLAUDE.md section 3.2). The `*_unique_pair`
-- constraints are not redundant with their primary keys: they are the pairs the
-- child tables' composite foreign keys reference, which is what proves a child
-- row belongs to the same property as its parent.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "promotion_unique_name_per_property"
    ON "promotion"("propertyId", "name");

ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_property_id_unique_pair" UNIQUE ("id", "propertyId");

CREATE INDEX "promotion_eligibility_idx"
    ON "promotion"("propertyId", "isActive", "priority");

CREATE INDEX "promotion_stay_window_idx"
    ON "promotion"("propertyId", "stayFromDate", "stayThroughDate");

CREATE INDEX "promotion_rate_plan_propertyId_ratePlanId_idx"
    ON "promotion_rate_plan"("propertyId", "ratePlanId");
CREATE INDEX "promotion_rate_plan_propertyId_promotionId_idx"
    ON "promotion_rate_plan"("propertyId", "promotionId");

CREATE INDEX "promotion_room_type_propertyId_roomTypeId_idx"
    ON "promotion_room_type"("propertyId", "roomTypeId");
CREATE INDEX "promotion_room_type_propertyId_promotionId_idx"
    ON "promotion_room_type"("propertyId", "promotionId");

-- The code lookup, and the uniqueness that makes it unambiguous. Normalised
-- form only: two codes differing solely in case or surrounding whitespace are
-- the same code, and storing both would make "which promotion does SUMMER24
-- mean" unanswerable.
CREATE UNIQUE INDEX "promo_code_unique_per_property"
    ON "promo_code"("propertyId", "codeNormalized");

ALTER TABLE "promo_code"
    ADD CONSTRAINT "promo_code_property_id_unique_pair" UNIQUE ("id", "propertyId");

CREATE INDEX "promo_code_propertyId_promotionId_idx"
    ON "promo_code"("propertyId", "promotionId");

CREATE UNIQUE INDEX "promotion_redemption_unique_per_reservation"
    ON "promotion_redemption"("propertyId", "reservationId");

CREATE INDEX "promotion_redemption_propertyId_promotionId_idx"
    ON "promotion_redemption"("propertyId", "promotionId");
CREATE INDEX "promotion_redemption_propertyId_promoCodeId_idx"
    ON "promotion_redemption"("propertyId", "promoCodeId");

-- ---------------------------------------------------------------------------
-- 6. Value and window validity.
--
-- The discount bound differs by kind because the units are not comparable, and
-- a single bound would be meaningless for one of them:
--
--   * PERCENT is BASIS POINTS capped at 10,000 = 100%. One hundred per cent is
--     the maximum meaningful discount — a night cannot cost less than nothing,
--     and the calculator clamps to the eligible amount regardless, so a higher
--     cap would only let an operator store a number that could never take
--     effect.
--   * FIXED_PER_NIGHT is minor units capped at 2,000,000,000, the same ceiling
--     the rate DTOs use, which keeps the column inside INTEGER.
--
-- ZERO IS VALID for both. A zero-value promotion is a real configuration — a
-- placeholder an operator is about to price, or a code kept alive for
-- reporting — and refusing it would be refusing a state the product otherwise
-- permits everywhere (`rate_plan_day_amount_non_negative`,
-- `rate_pricing_rule_price_non_negative`).
--
-- Windows are ordered rather than non-empty: a one-night promotion has
-- `stayFromDate = stayThroughDate`, so `>=` is correct where
-- `room_block_through_after_from` needed a strict `>`.
-- ---------------------------------------------------------------------------
ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_discount_value_valid"
    CHECK (
        "discountValue" >= 0
        AND (
            ("discountKind" = 'PERCENT' AND "discountValue" <= 10000)
            OR ("discountKind" = 'FIXED_PER_NIGHT' AND "discountValue" <= 2000000000)
        )
    );

ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_priority_bounds"
    CHECK ("priority" >= 0 AND "priority" <= 1000);

ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_stay_window_ordered"
    CHECK (
        "stayFromDate" IS NULL
        OR "stayThroughDate" IS NULL
        OR "stayThroughDate" >= "stayFromDate"
    );

ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_book_window_ordered"
    CHECK (
        "bookFromDate" IS NULL
        OR "bookThroughDate" IS NULL
        OR "bookThroughDate" >= "bookFromDate"
    );

ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_nights_sane"
    CHECK (
        ("minNights" IS NULL OR ("minNights" >= 1 AND "minNights" <= 365))
        AND ("maxNights" IS NULL OR ("maxNights" >= 1 AND "maxNights" <= 365))
        AND ("minNights" IS NULL OR "maxNights" IS NULL OR "maxNights" >= "minNights")
    );

ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_min_amount_non_negative"
    CHECK ("minEligibleAmountMinor" IS NULL OR "minEligibleAmountMinor" >= 0);

-- ---------------------------------------------------------------------------
-- 7. Redemption counters cannot exceed their own limits.
--
-- The backstop for the contract in section 4. The conditional UPDATE is the
-- primary control — it is what makes concurrent consumption safe — and this
-- CHECK is what catches a future writer who forgets the predicate. It turns a
-- silent over-redemption into a failed transaction, which is the correct
-- direction for an error about a limited offer.
--
-- Both columns ship at zero with no writer in F5.
-- ---------------------------------------------------------------------------
ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_redeemed_within_limit"
    CHECK (
        "redeemedCount" >= 0
        AND ("maxRedemptions" IS NULL OR "redeemedCount" <= "maxRedemptions")
    );

ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_max_redemptions_positive"
    CHECK ("maxRedemptions" IS NULL OR "maxRedemptions" >= 1);

ALTER TABLE "promo_code"
    ADD CONSTRAINT "promo_code_redeemed_within_limit"
    CHECK (
        "redeemedCount" >= 0
        AND ("maxRedemptions" IS NULL OR "redeemedCount" <= "maxRedemptions")
    );

ALTER TABLE "promo_code"
    ADD CONSTRAINT "promo_code_max_redemptions_positive"
    CHECK ("maxRedemptions" IS NULL OR "maxRedemptions" >= 1);

-- The normalised form really is normalised. Without these, a row could store
-- `codeNormalized = 'summer24 '` and the unique index would then happily admit
-- `'SUMMER24'` as a different code — defeating the whole point of the column.
-- `btrim` and `upper` are the same functions the service applies, so the
-- database is asserting the service's own invariant rather than a different
-- one.
ALTER TABLE "promo_code"
    ADD CONSTRAINT "promo_code_normalized_is_normalized"
    CHECK (
        "codeNormalized" = upper(btrim("codeNormalized"))
        AND length("codeNormalized") BETWEEN 3 AND 32
    );

ALTER TABLE "promotion_redemption"
    ADD CONSTRAINT "promotion_redemption_discount_non_negative"
    CHECK ("discountAppliedMinor" >= 0);

-- ---------------------------------------------------------------------------
-- 8. Tenancy and existence, enforced by the database.
--
-- The property keys are ordinary. The composite keys are what make a
-- cross-property promotion unrepresentable rather than merely unwritten — the
-- class of bug section 3.2 exists to prevent, and the only tenancy control
-- this repository actually has, since neither the Prisma tenancy extension nor
-- RLS is implemented.
--
-- `promotion_rate_plan` and `promotion_room_type` are RESTRICT on their target:
-- a rate plan or room type still named by a promotion must not vanish from
-- under it. Rate plans archive rather than delete, so it should never fire — it
-- is here so it cannot.
--
-- `promotion_redemption` is RESTRICT on both the promotion and the code,
-- because a redemption is a financial record: deleting the promotion a stay was
-- discounted under would destroy the explanation of a charge. The service's
-- delete therefore refuses a promotion with redemptions, and the database
-- agrees rather than taking it on trust.
--
-- THE RESERVATION KEY. `promotion_redemption` carries a composite foreign key
-- onto `reservation("id","propertyId")`, which rides on
-- `reservation_property_id_unique_pair` from migration 20261016140000. That
-- adds a constraint to the NEW table; it does not alter `reservation`. It is
-- absent from schema.prisma for the documented reason — Prisma cannot express
-- a composite foreign key onto a non-primary key — and `prisma migrate diff`
-- will propose dropping it, exactly as it already proposes dropping the five
-- equivalents listed in 20261016160000's header. It is deleted from the
-- generated SQL each time, never from the database.
-- ---------------------------------------------------------------------------
ALTER TABLE "promotion"
    ADD CONSTRAINT "promotion_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_rate_plan"
    ADD CONSTRAINT "promotion_rate_plan_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_rate_plan"
    ADD CONSTRAINT "promotion_rate_plan_same_property_as_promotion"
    FOREIGN KEY ("promotionId", "propertyId")
    REFERENCES "promotion"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_rate_plan"
    ADD CONSTRAINT "promotion_rate_plan_same_property_as_plan"
    FOREIGN KEY ("ratePlanId", "propertyId")
    REFERENCES "rate_plan"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "promotion_room_type"
    ADD CONSTRAINT "promotion_room_type_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_room_type"
    ADD CONSTRAINT "promotion_room_type_same_property_as_promotion"
    FOREIGN KEY ("promotionId", "propertyId")
    REFERENCES "promotion"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_room_type"
    ADD CONSTRAINT "promotion_room_type_same_property_as_room_type"
    FOREIGN KEY ("roomTypeId", "propertyId")
    REFERENCES "room_type"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "promo_code"
    ADD CONSTRAINT "promo_code_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promo_code"
    ADD CONSTRAINT "promo_code_same_property_as_promotion"
    FOREIGN KEY ("promotionId", "propertyId")
    REFERENCES "promotion"("id", "propertyId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_redemption"
    ADD CONSTRAINT "promotion_redemption_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "property"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotion_redemption"
    ADD CONSTRAINT "promotion_redemption_same_property_as_promotion"
    FOREIGN KEY ("promotionId", "propertyId")
    REFERENCES "promotion"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "promotion_redemption"
    ADD CONSTRAINT "promotion_redemption_same_property_as_code"
    FOREIGN KEY ("promoCodeId", "propertyId")
    REFERENCES "promo_code"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "promotion_redemption"
    ADD CONSTRAINT "promotion_redemption_same_property_as_reservation"
    FOREIGN KEY ("reservationId", "propertyId")
    REFERENCES "reservation"("id", "propertyId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 9. WHAT THE DATABASE DOES NOT ENFORCE, AND WHO DOES.
--
-- Three rules are cross-table or cross-row and are therefore validated in the
-- service. Each is claimed as application validation — the weaker layer — not
-- as a database guarantee:
--
--   * "A room type named by a promotion must be ASSIGNED to a rate plan the
--     promotion also names." That spans `promotion_room_type`,
--     `promotion_rate_plan` and `rate_plan_room_type`, and no CHECK or foreign
--     key can express a condition over three tables.
--
--   * "A promotion must be able to apply to something" — not both applicability
--     flags false with both join tables empty. A CHECK cannot see the join
--     tables, so the service refuses it on write and the eligibility
--     calculator reports it as a rejection reason rather than assuming it
--     cannot happen.
--
--   * "Two ACTIVE promotions at the same priority must not overlap in
--     applicability." An exclusion constraint cannot help: applicability lives
--     in two child tables and PostgreSQL exclusion constraints are
--     single-table, so a constraint on the parent row would reject the
--     legitimate case of two same-priority promotions covering disjoint room
--     types. This is the same reasoning recorded in F3's migration section 7,
--     and it is resolved the same way — refused at write time, and detected
--     again at read time so a row written around the service is reported
--     rather than silently resolved by row order.
-- ---------------------------------------------------------------------------
