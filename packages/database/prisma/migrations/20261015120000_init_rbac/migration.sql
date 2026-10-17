-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RoleKey" AS ENUM ('SUPER_ADMIN', 'PROPERTY_ADMIN', 'FRONT_DESK', 'HOUSEKEEPING', 'REVENUE_MANAGER', 'NIGHT_AUDITOR', 'POS_STAFF');

-- CreateEnum
CREATE TYPE "PermissionCategory" AS ENUM ('FRONT_DESK', 'HOUSEKEEPING', 'BILLING', 'RATES_DISTRIBUTION', 'NIGHT_AUDIT', 'ADMINISTRATION');

-- CreateTable
CREATE TABLE "property" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "businessDate" DATE NOT NULL,
    "checkInTime" TEXT NOT NULL DEFAULT '14:00',
    "checkOutTime" TEXT NOT NULL DEFAULT '11:00',
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "countryCode" CHAR(2) NOT NULL DEFAULT 'IN',
    "phone" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "key" "RoleKey",
    "propertyId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "PermissionCategory" NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_property_role" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "grantedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_property_role_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "property_slug_key" ON "property"("slug");

-- CreateIndex
CREATE INDEX "property_isActive_idx" ON "property"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_isActive_idx" ON "user"("isActive");

-- CreateIndex
CREATE INDEX "role_propertyId_idx" ON "role"("propertyId");

-- CreateIndex
CREATE INDEX "role_isCustom_idx" ON "role"("isCustom");

-- CreateIndex
CREATE UNIQUE INDEX "role_propertyId_name_key" ON "role"("propertyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE INDEX "permission_category_idx" ON "permission"("category");

-- CreateIndex
CREATE INDEX "role_permission_permissionId_idx" ON "role_permission"("permissionId");

-- CreateIndex
CREATE INDEX "user_property_role_propertyId_userId_idx" ON "user_property_role"("propertyId", "userId");

-- CreateIndex
CREATE INDEX "user_property_role_userId_idx" ON "user_property_role"("userId");

-- CreateIndex
CREATE INDEX "user_property_role_roleId_idx" ON "user_property_role"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_property_role_userId_propertyId_roleId_key" ON "user_property_role"("userId", "propertyId", "roleId");

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_property_role" ADD CONSTRAINT "user_property_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_property_role" ADD CONSTRAINT "user_property_role_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_property_role" ADD CONSTRAINT "user_property_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- Hand-written constraints Prisma cannot express.
-- Per CLAUDE.md section 6.2 these are load-bearing: never drop one to make a
-- write succeed.
-- =============================================================================

-- `role_propertyId_name_key` does NOT protect system templates: PostgreSQL
-- treats two NULL propertyIds as distinct, so that index would happily allow
-- two system roles both named "Front Desk". Partial unique indexes close it.
CREATE UNIQUE INDEX "role_system_key_unique"
  ON "role" ("key")
  WHERE "propertyId" IS NULL;

CREATE UNIQUE INDEX "role_system_name_unique"
  ON "role" ("name")
  WHERE "propertyId" IS NULL;

-- A role is either a portfolio-wide system template or a property-owned
-- custom role, never a mixture. Encoding it here means the application cannot
-- create a half-formed row even through raw SQL.
ALTER TABLE "role"
  ADD CONSTRAINT "role_template_or_custom"
  CHECK (
    ("propertyId" IS NULL     AND "key" IS NOT NULL AND "isCustom" = false)
    OR
    ("propertyId" IS NOT NULL AND "key" IS NULL     AND "isCustom" = true)
  );
