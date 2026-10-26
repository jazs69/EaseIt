-- ===========================================================================
-- Transactional outbox (Phase A).
--
-- Effect on existing rows: **purely additive**. Three new enum types, one new
-- table, three indexes, one foreign key. No existing table, column or
-- constraint is altered, renamed or dropped, so the 952 reservations and
-- 46,996 inventory rows are untouched and every live path keeps working
-- through the deploy.
--
-- WHY THIS EXISTS
-- CLAUDE.md section 3.1 forbids HTTP calls, queue publishes, email sends and
-- Redis reads inside a transaction, and requires side effects to leave through
-- an outbox table written in the same transaction and drained by a BullMQ
-- worker afterwards. Section 2 places that outbox in the `platform` module.
-- Nothing of the kind existed; this table is it.
--
-- Phase A deliberately carries ONE event type, `OUTBOX_SELF_TEST`, handled by
-- a fake handler. No reservation, folio or inventory path is modified, and no
-- OTA integration is implemented.
--
-- POSTGRESQL IS THE SOURCE OF TRUTH
-- Everything needed to rebuild the queue lives in this table. If Redis is
-- flushed entirely, the dispatcher re-publishes from these rows and nothing is
-- lost. There is no attempt at a transaction spanning PostgreSQL and Redis,
-- because none exists -- so delivery is at-least-once and every handler must
-- be safe to run twice.
--
-- As with every migration since 20261016140000, `prisma migrate diff` again
-- proposed dropping the tenant-coherence constraints it cannot see in
-- schema.prisma. All 17 are stripped from the generated SQL below and remain
-- in the database (CLAUDE.md section 6.2): the 11 `*_same_property_as_*`
-- composite foreign keys and the 6 `*_property_id_unique_pair` indexes they
-- point at.
-- ===========================================================================

CREATE TYPE "OutboxEventType" AS ENUM ('OUTBOX_SELF_TEST');

CREATE TYPE "OutboxDedupeMode" AS ENUM ('COALESCE', 'UNIQUE_FOREVER');

CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'DEAD');

CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "eventType" "OutboxEventType" NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "dedupeMode" "OutboxDedupeMode" NOT NULL DEFAULT 'COALESCE',
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "recoveries" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(6),
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "claimedBy" TEXT,
    "lastError" VARCHAR(500),
    "lastErrorAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_event_status_availableAt_idx" ON "outbox_event"("status", "availableAt");

CREATE INDEX "outbox_event_status_leaseExpiresAt_idx" ON "outbox_event"("status", "leaseExpiresAt");

CREATE INDEX "outbox_event_propertyId_status_createdAt_idx" ON "outbox_event"("propertyId", "status", "createdAt");

ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants. Prisma can express none of these.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- DEDUPLICATION: two classes, two constraints, deliberately not one.
--
-- A PENDING-only unique index is NOT permanent event idempotency, and treating
-- it as such is a bug in both directions -- so the intent is stored per row in
-- `dedupeMode` and enforced by two different partial indexes.
--
-- COALESCE means "the latest intent wins". An ARI push for
-- (property, roomType, dateRange) enqueued five times before the worker drains
-- it must become ONE push carrying the newest state. Uniqueness therefore
-- applies only while the row is still PENDING: once processed, the same key is
-- legitimately enqueueable again tomorrow. Note this index excludes IN_FLIGHT
-- on purpose -- a row already being published must not block the next genuine
-- change from being queued behind it, or an update arriving mid-flight would
-- be silently dropped.
--
-- UNIQUE_FOREVER means "at most once, ever". A booking confirmation email for
-- reservation X must not be sent twice, and must not become sendable again
-- merely because the first one succeeded. Uniqueness therefore ignores status
-- entirely and holds for the lifetime of the row.
-- ===========================================================================
CREATE UNIQUE INDEX "outbox_event_coalesce_one_pending_per_key"
  ON "outbox_event" ("propertyId", "dedupeKey")
  WHERE "dedupeMode" = 'COALESCE' AND "status" = 'PENDING';

CREATE UNIQUE INDEX "outbox_event_unique_forever_per_key"
  ON "outbox_event" ("propertyId", "dedupeKey")
  WHERE "dedupeMode" = 'UNIQUE_FOREVER';

-- The retry budget must be coherent. `attempts` is owned by this table and
-- never by BullMQ (jobs are published with attempts: 1), so this CHECK is the
-- thing that makes "the database and the queue cannot disagree" enforceable
-- rather than merely intended.
ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_attempt_budget_coherent"
  CHECK ("attempts" >= 0 AND "maxAttempts" >= 1 AND "attempts" <= "maxAttempts");

-- A reclaimed lease is not a failed attempt. A worker dying is an operational
-- event, so it increments `recoveries` and must never consume retry budget --
-- otherwise three unlucky restarts would dead-letter a perfectly good job.
ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_recoveries_non_negative"
  CHECK ("recoveries" >= 0);

-- A payload version of zero or less cannot be matched to any schema.
ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_payload_version_positive"
  CHECK ("payloadVersion" >= 1);

-- `completedAt` means terminal, in both directions. A SUCCEEDED row without a
-- completion time cannot be aged, and a PENDING row carrying one would make
-- every backlog metric lie.
ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_completed_at_matches_terminal_status"
  CHECK (
    ("status" IN ('SUCCEEDED', 'DEAD') AND "completedAt" IS NOT NULL)
    OR ("status" IN ('PENDING', 'IN_FLIGHT') AND "completedAt" IS NULL)
  );

-- IN_FLIGHT is held under a LEASE, not a lock.
--
-- This is the constraint that makes crash recovery possible. A row claimed
-- without an expiry could be stranded forever by a worker that dies between
-- claiming and publishing -- exactly the gap this phase has to survive. The
-- reaper finds expired leases and returns those rows to PENDING; a row with no
-- expiry would be invisible to it.
ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_in_flight_requires_lease"
  CHECK (
    "status" <> 'IN_FLIGHT'
    OR ("claimedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  );

-- Error text and its timestamp travel together or not at all.
ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_error_fields_together"
  CHECK (("lastError" IS NULL) = ("lastErrorAt" IS NULL));
