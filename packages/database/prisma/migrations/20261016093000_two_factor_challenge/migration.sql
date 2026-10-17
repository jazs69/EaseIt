-- ===========================================================================
-- Email one-time-password challenges for staff sign-in.
--
-- Effect on existing rows: none. This migration only adds a table; no column
-- on `user` changes and no data is rewritten. Existing accounts simply gain a
-- second step at their next sign-in, served from an empty table.
--
-- Hand-written rather than produced by `prisma migrate diff --from-migrations`:
-- that mode replays the existing migrations into a shadow database, and no
-- PostgreSQL instance was reachable when this was authored. The two CHECK
-- constraints at the end are also not expressible in schema.prisma and must
-- survive any future regeneration of this file.
-- ===========================================================================

-- CreateTable
CREATE TABLE "two_factor_challenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSentAt" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "requestedPropertyId" UUID,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "two_factor_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "two_factor_challenge_userId_createdAt_idx" ON "two_factor_challenge"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "two_factor_challenge_expiresAt_idx" ON "two_factor_challenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "two_factor_challenge"
    ADD CONSTRAINT "two_factor_challenge_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written guards. Prisma cannot express a CHECK, so these live only here
-- and must never be dropped to make a write pass (CLAUDE.md section 6.2).
-- ---------------------------------------------------------------------------

-- The application caps attempts and resends in `AuthService`, and the database
-- refuses to hold a row that says otherwise. If a counter ever exceeds its cap
-- the write fails loudly rather than quietly granting an extra guess at a
-- six-digit code.
ALTER TABLE "two_factor_challenge"
    ADD CONSTRAINT "two_factor_challenge_counters_bounded"
    CHECK ("attempts" >= 0 AND "attempts" <= 5 AND "resendCount" >= 0 AND "resendCount" <= 3);

-- A challenge is either outstanding, consumed, or revoked — never both
-- consumed and revoked. Catching that here keeps "was this code actually used?"
-- an answerable question during an incident review.
ALTER TABLE "two_factor_challenge"
    ADD CONSTRAINT "two_factor_challenge_single_terminal_state"
    CHECK ("consumedAt" IS NULL OR "revokedAt" IS NULL);

-- A partial index over just the live rows. Every sign-in supersedes the
-- account's outstanding challenges, and this is the predicate that lookup uses;
-- the table is otherwise mostly dead rows awaiting the sweeper.
CREATE INDEX "two_factor_challenge_live_idx"
    ON "two_factor_challenge"("userId", "expiresAt")
    WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
