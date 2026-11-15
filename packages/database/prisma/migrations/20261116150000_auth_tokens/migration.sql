-- AU-08 / AU-14: single-use, expiring account tokens (password reset, invitation).
-- Additive: one new table and enum. Only a hash of each token is stored.

-- CreateEnum
CREATE TYPE "AuthTokenPurpose" AS ENUM ('PASSWORD_RESET', 'INVITATION');

-- CreateTable
CREATE TABLE "auth_token" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_token_tokenHash_key" ON "auth_token"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_token_userId_purpose_idx" ON "auth_token"("userId", "purpose");

-- AddForeignKey
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A token is consumed or revoked at most once, and never both.
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_single_outcome" CHECK ("consumedAt" IS NULL OR "revokedAt" IS NULL);
