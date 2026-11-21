-- CM-01 .. CM-05: the channel manager.
--
-- Connections to a channel provider, room-type and rate-plan mappings, the ARI
-- change log the push reads, a log of every provider call, inbound messages
-- stored raw before parsing, and the link from a provider booking to the
-- reservations it became. Triggers record ARI changes in the writer's own
-- transaction. Three outbox event types. One new permission, channels:manage;
-- channels:read and channels:sync become grantable (AU-13 entries removed).
--
-- Existing rows: none change, except one permission description. Seven new,
-- empty tables; triggers on inventory_day, rate_plan_day, rate_restriction_day,
-- rate_plan_room_type, rate_pricing_rule(_price), rate_plan, room_type and
-- property_settings write nothing until a connection is ACTIVE.

-- CreateEnum
CREATE TYPE "ChannelProvider" AS ENUM ('CHANNEX');

-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ChannelInboundStatus" AS ENUM ('RECEIVED', 'APPLIED', 'IGNORED', 'NEEDS_ATTENTION', 'RESOLVED');

ALTER TYPE "OutboxEventType" ADD VALUE 'CHANNEL_ARI_PUSH';
ALTER TYPE "OutboxEventType" ADD VALUE 'CHANNEL_BOOKINGS_PULL';
ALTER TYPE "OutboxEventType" ADD VALUE 'CHANNEL_INBOUND_APPLY';

-- CreateTable
CREATE TABLE "channel_connection" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "provider" "ChannelProvider" NOT NULL,
    "externalPropertyId" TEXT NOT NULL,
    "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'PAUSED',
    "lastAriSyncAt" TIMESTAMPTZ(6),
    "lastAriError" VARCHAR(500),
    "lastPulledAt" TIMESTAMPTZ(6),
    "lastPullError" VARCHAR(500),
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_room_type_mapping" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "externalRoomTypeId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_room_type_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_rate_plan_mapping" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "roomTypeMappingId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "ratePlanId" UUID NOT NULL,
    "externalRatePlanId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_rate_plan_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_ari_change" (
    "id" BIGSERIAL NOT NULL,
    "propertyId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "roomTypeId" UUID,
    "fromDate" DATE,
    "toDate" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_ari_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sync_attempt" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestBody" JSONB,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "ok" BOOLEAN NOT NULL,
    "error" VARCHAR(500),
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_sync_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_inbound_message" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "propertyId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "externalBookingId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "ChannelInboundStatus" NOT NULL DEFAULT 'RECEIVED',
    "attentionCode" TEXT,
    "outcome" VARCHAR(500),
    "revisionKind" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "appliedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "resolvedByUserId" UUID,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_inbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_reservation" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "externalBookingId" TEXT NOT NULL,
    "roomIndex" INTEGER NOT NULL,
    "reservationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_connection_status_idx" ON "channel_connection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connection_propertyId_provider_key" ON "channel_connection"("propertyId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connection_id_propertyId_key" ON "channel_connection"("id", "propertyId");

-- CreateIndex
CREATE INDEX "channel_room_type_mapping_connectionId_idx" ON "channel_room_type_mapping"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_room_type_mapping_propertyId_connectionId_roomTypeI_key" ON "channel_room_type_mapping"("propertyId", "connectionId", "roomTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_room_type_mapping_propertyId_connectionId_externalR_key" ON "channel_room_type_mapping"("propertyId", "connectionId", "externalRoomTypeId");

-- CreateIndex
CREATE INDEX "channel_rate_plan_mapping_roomTypeMappingId_idx" ON "channel_rate_plan_mapping"("roomTypeMappingId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_rate_plan_mapping_propertyId_connectionId_roomTypeI_key" ON "channel_rate_plan_mapping"("propertyId", "connectionId", "roomTypeId", "ratePlanId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_rate_plan_mapping_propertyId_connectionId_externalR_key" ON "channel_rate_plan_mapping"("propertyId", "connectionId", "externalRatePlanId");

-- CreateIndex
CREATE INDEX "channel_ari_change_propertyId_connectionId_id_idx" ON "channel_ari_change"("propertyId", "connectionId", "id");

-- CreateIndex
CREATE INDEX "channel_ari_change_connectionId_createdAt_idx" ON "channel_ari_change"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "channel_sync_attempt_propertyId_connectionId_createdAt_idx" ON "channel_sync_attempt"("propertyId", "connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "channel_inbound_message_propertyId_connectionId_status_sequ_idx" ON "channel_inbound_message"("propertyId", "connectionId", "status", "sequence");

-- CreateIndex
CREATE INDEX "channel_inbound_message_propertyId_connectionId_externalBoo_idx" ON "channel_inbound_message"("propertyId", "connectionId", "externalBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_inbound_message_propertyId_connectionId_externalMes_key" ON "channel_inbound_message"("propertyId", "connectionId", "externalMessageId");

-- CreateIndex
CREATE INDEX "channel_reservation_reservationId_idx" ON "channel_reservation"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_reservation_propertyId_connectionId_externalBooking_key" ON "channel_reservation"("propertyId", "connectionId", "externalBookingId", "roomIndex");

-- CreateIndex
CREATE UNIQUE INDEX "channel_reservation_propertyId_reservationId_key" ON "channel_reservation"("propertyId", "reservationId");

-- AddForeignKey
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_room_type_mapping" ADD CONSTRAINT "channel_room_type_mapping_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_room_type_mapping" ADD CONSTRAINT "channel_room_type_mapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "channel_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_room_type_mapping" ADD CONSTRAINT "channel_room_type_mapping_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_rate_plan_mapping" ADD CONSTRAINT "channel_rate_plan_mapping_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_rate_plan_mapping" ADD CONSTRAINT "channel_rate_plan_mapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "channel_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_rate_plan_mapping" ADD CONSTRAINT "channel_rate_plan_mapping_roomTypeMappingId_fkey" FOREIGN KEY ("roomTypeMappingId") REFERENCES "channel_room_type_mapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_rate_plan_mapping" ADD CONSTRAINT "channel_rate_plan_mapping_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "rate_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_ari_change" ADD CONSTRAINT "channel_ari_change_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_ari_change" ADD CONSTRAINT "channel_ari_change_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "channel_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_attempt" ADD CONSTRAINT "channel_sync_attempt_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_attempt" ADD CONSTRAINT "channel_sync_attempt_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "channel_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "channel_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reservation" ADD CONSTRAINT "channel_reservation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reservation" ADD CONSTRAINT "channel_reservation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "channel_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reservation" ADD CONSTRAINT "channel_reservation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written: what Prisma cannot express.
-- ---------------------------------------------------------------------------

-- Every reference stays inside one property, structurally (section 3.2).
ALTER TABLE "channel_room_type_mapping" ADD CONSTRAINT "channel_room_type_mapping_same_property_as_connection"
  FOREIGN KEY ("connectionId", "propertyId") REFERENCES "channel_connection"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_room_type_mapping" ADD CONSTRAINT "channel_room_type_mapping_same_property_as_room_type"
  FOREIGN KEY ("roomTypeId", "propertyId") REFERENCES "room_type"("id", "propertyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "channel_rate_plan_mapping" ADD CONSTRAINT "channel_rate_plan_mapping_same_property_as_connection"
  FOREIGN KEY ("connectionId", "propertyId") REFERENCES "channel_connection"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- The (plan, room type) pair must be a real assignment of this property.
ALTER TABLE "channel_rate_plan_mapping" ADD CONSTRAINT "channel_rate_plan_mapping_assignment"
  FOREIGN KEY ("ratePlanId", "roomTypeId", "propertyId")
  REFERENCES "rate_plan_room_type"("ratePlanId", "roomTypeId", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "channel_ari_change" ADD CONSTRAINT "channel_ari_change_same_property_as_connection"
  FOREIGN KEY ("connectionId", "propertyId") REFERENCES "channel_connection"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_sync_attempt" ADD CONSTRAINT "channel_sync_attempt_same_property_as_connection"
  FOREIGN KEY ("connectionId", "propertyId") REFERENCES "channel_connection"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_same_property_as_connection"
  FOREIGN KEY ("connectionId", "propertyId") REFERENCES "channel_connection"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_reservation" ADD CONSTRAINT "channel_reservation_same_property_as_connection"
  FOREIGN KEY ("connectionId", "propertyId") REFERENCES "channel_connection"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channel_reservation" ADD CONSTRAINT "channel_reservation_same_property_as_reservation"
  FOREIGN KEY ("reservationId", "propertyId") REFERENCES "reservation"("id", "propertyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Provider identifiers are opaque, but never blank or unbounded.
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_external_id_sane"
  CHECK (length(btrim("externalPropertyId")) BETWEEN 1 AND 100);
ALTER TABLE "channel_room_type_mapping" ADD CONSTRAINT "channel_room_type_mapping_external_id_sane"
  CHECK (length(btrim("externalRoomTypeId")) BETWEEN 1 AND 100);
ALTER TABLE "channel_rate_plan_mapping" ADD CONSTRAINT "channel_rate_plan_mapping_external_id_sane"
  CHECK (length(btrim("externalRatePlanId")) BETWEEN 1 AND 100);
ALTER TABLE "channel_ari_change" ADD CONSTRAINT "channel_ari_change_range_ordered"
  CHECK (("fromDate" IS NULL) = ("toDate" IS NULL) AND ("fromDate" IS NULL OR "fromDate" <= "toDate"));
ALTER TABLE "channel_sync_attempt" ADD CONSTRAINT "channel_sync_attempt_operation_known"
  CHECK ("operation" IN ('ARI_AVAILABILITY', 'ARI_RATES', 'BOOKINGS_PULL', 'BOOKING_ACK'));
ALTER TABLE "channel_reservation" ADD CONSTRAINT "channel_reservation_room_index_positive"
  CHECK ("roomIndex" >= 1);
ALTER TABLE "channel_inbound_message" ADD CONSTRAINT "channel_inbound_message_attention_has_code"
  CHECK (("status" = 'NEEDS_ATTENTION') = ("attentionCode" IS NOT NULL) OR "status" = 'RESOLVED');

-- ---------------------------------------------------------------------------
-- ARI change capture (CM-03).
--
-- Statement-level AFTER triggers with transition tables: one change row per
-- (active connection, room type) per statement, carrying the min..max dates
-- the statement touched. They run inside the writer's own transaction, so a
-- change and its promise to tell the channels commit together, and no write
-- path (booking, cancel, move, block, horizon, rates, import) can forget.
-- They take no row locks: the only write is an INSERT into a table nothing
-- else locks, so the reservation lock protocol (section 3.1.1) is untouched.
-- A property with no ACTIVE connection writes nothing.
-- ---------------------------------------------------------------------------

-- Rows with (propertyId, roomTypeId, stayDate).
CREATE FUNCTION "channel_ari_capture_dated"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "channel_ari_change" ("propertyId", "connectionId", "roomTypeId", "fromDate", "toDate")
  SELECT c."propertyId", c."id", d."roomTypeId", d."fromDate", d."toDate"
    FROM (SELECT r."propertyId", r."roomTypeId",
                 min(r."stayDate") AS "fromDate", max(r."stayDate") AS "toDate"
            FROM "changed_rows" r
           GROUP BY r."propertyId", r."roomTypeId") d
    JOIN "channel_connection" c
      ON c."propertyId" = d."propertyId" AND c."status" = 'ACTIVE';
  RETURN NULL;
END $$;

-- inventory_day updates: only when what is pushed (stock left) changed. A
-- change to the overbooking allowance alone is not pushed: the channels are
-- sold physical stock, never the allowance.
CREATE FUNCTION "channel_ari_capture_inventory_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "channel_ari_change" ("propertyId", "connectionId", "roomTypeId", "fromDate", "toDate")
  SELECT c."propertyId", c."id", d."roomTypeId", d."fromDate", d."toDate"
    FROM (SELECT n."propertyId", n."roomTypeId",
                 min(n."stayDate") AS "fromDate", max(n."stayDate") AS "toDate"
            FROM "new_rows" n
            JOIN "old_rows" o ON o."id" = n."id"
           WHERE (n."physical", n."sold", n."blocked", n."stayDate")
                 IS DISTINCT FROM (o."physical", o."sold", o."blocked", o."stayDate")
           GROUP BY n."propertyId", n."roomTypeId") d
    JOIN "channel_connection" c
      ON c."propertyId" = d."propertyId" AND c."status" = 'ACTIVE';
  RETURN NULL;
END $$;

-- Rows with (propertyId, roomTypeId) and no date: the whole window of that type.
CREATE FUNCTION "channel_ari_capture_room_type"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "channel_ari_change" ("propertyId", "connectionId", "roomTypeId")
  SELECT DISTINCT c."propertyId", c."id", r."roomTypeId"
    FROM "changed_rows" r
    JOIN "channel_connection" c
      ON c."propertyId" = r."propertyId" AND c."status" = 'ACTIVE';
  RETURN NULL;
END $$;

-- room_type itself (retirement): keyed by its own id.
CREATE FUNCTION "channel_ari_capture_room_type_row"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "channel_ari_change" ("propertyId", "connectionId", "roomTypeId")
  SELECT DISTINCT c."propertyId", c."id", r."id"
    FROM "changed_rows" r
    JOIN "channel_connection" c
      ON c."propertyId" = r."propertyId" AND c."status" = 'ACTIVE';
  RETURN NULL;
END $$;

-- Anything property-wide (a plan's state, pricing rules, weekend days): every
-- room type, the whole window.
CREATE FUNCTION "channel_ari_capture_property"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "channel_ari_change" ("propertyId", "connectionId")
  SELECT DISTINCT c."propertyId", c."id"
    FROM "changed_rows" r
    JOIN "channel_connection" c
      ON c."propertyId" = r."propertyId" AND c."status" = 'ACTIVE';
  RETURN NULL;
END $$;

CREATE TRIGGER "channel_ari_inventory_insert" AFTER INSERT ON "inventory_day"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_dated"();
CREATE TRIGGER "channel_ari_inventory_update" AFTER UPDATE ON "inventory_day"
  REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_inventory_update"();

CREATE TRIGGER "channel_ari_rate_day_insert" AFTER INSERT ON "rate_plan_day"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_dated"();
CREATE TRIGGER "channel_ari_rate_day_update" AFTER UPDATE ON "rate_plan_day"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_dated"();
CREATE TRIGGER "channel_ari_rate_day_delete" AFTER DELETE ON "rate_plan_day"
  REFERENCING OLD TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_dated"();

CREATE TRIGGER "channel_ari_restriction_insert" AFTER INSERT ON "rate_restriction_day"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_dated"();
CREATE TRIGGER "channel_ari_restriction_update" AFTER UPDATE ON "rate_restriction_day"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_dated"();
CREATE TRIGGER "channel_ari_restriction_delete" AFTER DELETE ON "rate_restriction_day"
  REFERENCING OLD TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_dated"();

CREATE TRIGGER "channel_ari_assignment_insert" AFTER INSERT ON "rate_plan_room_type"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_room_type"();
CREATE TRIGGER "channel_ari_assignment_update" AFTER UPDATE ON "rate_plan_room_type"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_room_type"();
CREATE TRIGGER "channel_ari_assignment_delete" AFTER DELETE ON "rate_plan_room_type"
  REFERENCING OLD TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_room_type"();

CREATE TRIGGER "channel_ari_rule_price_insert" AFTER INSERT ON "rate_pricing_rule_price"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_room_type"();
CREATE TRIGGER "channel_ari_rule_price_update" AFTER UPDATE ON "rate_pricing_rule_price"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_room_type"();
CREATE TRIGGER "channel_ari_rule_price_delete" AFTER DELETE ON "rate_pricing_rule_price"
  REFERENCING OLD TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_room_type"();

CREATE TRIGGER "channel_ari_room_type_update" AFTER UPDATE ON "room_type"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_room_type_row"();

CREATE TRIGGER "channel_ari_rate_plan_update" AFTER UPDATE ON "rate_plan"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_property"();
CREATE TRIGGER "channel_ari_rule_insert" AFTER INSERT ON "rate_pricing_rule"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_property"();
CREATE TRIGGER "channel_ari_rule_update" AFTER UPDATE ON "rate_pricing_rule"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_property"();
CREATE TRIGGER "channel_ari_rule_delete" AFTER DELETE ON "rate_pricing_rule"
  REFERENCING OLD TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_property"();
CREATE TRIGGER "channel_ari_settings_update" AFTER UPDATE ON "property_settings"
  REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "channel_ari_capture_property"();

-- ---------------------------------------------------------------------------
-- Row-level security, as on every tenant table (MT-04).
-- ---------------------------------------------------------------------------
ALTER TABLE "channel_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_connection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_connection"
  USING ("tenant_row_visible"("propertyId")) WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "channel_room_type_mapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_room_type_mapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_room_type_mapping"
  USING ("tenant_row_visible"("propertyId")) WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "channel_rate_plan_mapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_rate_plan_mapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_rate_plan_mapping"
  USING ("tenant_row_visible"("propertyId")) WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "channel_ari_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_ari_change" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_ari_change"
  USING ("tenant_row_visible"("propertyId")) WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "channel_sync_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_sync_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_sync_attempt"
  USING ("tenant_row_visible"("propertyId")) WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "channel_inbound_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_inbound_message" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_inbound_message"
  USING ("tenant_row_visible"("propertyId")) WITH CHECK ("tenant_row_visible"("propertyId"));

ALTER TABLE "channel_reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_reservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_reservation"
  USING ("tenant_row_visible"("propertyId")) WITH CHECK ("tenant_row_visible"("propertyId"));

-- ---------------------------------------------------------------------------
-- Permissions. channels:read and channels:sync already exist (they were held
-- back as not grantable until now, AU-13); channels:manage is new: connect a
-- provider, map room types and rate plans, and act on inbound bookings that
-- need a person. Administrators and the revenue manager template hold it.
-- ---------------------------------------------------------------------------
INSERT INTO "permission" ("id", "key", "label", "description", "category", "sensitive")
VALUES (gen_random_uuid(), 'channels:manage', 'Manage channels',
        'Connect a channel provider, map room types and rate plans, and resolve inbound OTA bookings that need attention.',
        'RATES_DISTRIBUTION', true)
ON CONFLICT ("key") DO NOTHING;

UPDATE "permission"
   SET "description" = 'See channel connections, mappings, the ARI push log and inbound OTA bookings.'
 WHERE "key" = 'channels:read';

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT r."id", p."id"
  FROM "role" r CROSS JOIN "permission" p
 WHERE r."key" IN ('PROPERTY_ADMIN', 'SUPER_ADMIN', 'REVENUE_MANAGER') AND r."propertyId" IS NULL
   AND p."key" IN ('channels:read', 'channels:sync', 'channels:manage')
ON CONFLICT DO NOTHING;
