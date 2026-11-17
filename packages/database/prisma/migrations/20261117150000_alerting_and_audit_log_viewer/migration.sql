-- OB-06 / WK-11: dead letters raise an external alert. AD-03: the audit log viewer.
--
-- Effect on existing rows:
--   * outbox_event gains a nullable "alertedAt". Every row reads NULL, so any
--     dead letter already in the table is alerted ONCE when the upgraded
--     worker first runs. That is intended: none of them has ever reached a
--     human, and "a permanently failed job alerts and does not vanish"
--     (CLAUDE.md section 5) applies to the ones from before this change too.
--   * audit_log gains an index; no row changes.
--   * One permission is added and granted to the PROPERTY_ADMIN and
--     SUPER_ADMIN templates. No custom role gains it.

-- AlterTable
ALTER TABLE "outbox_event" ADD COLUMN "alertedAt" TIMESTAMPTZ(6);

-- The alert monitor's scan: dead letters nobody has been told about. Partial,
-- because that set is tiny and every other row is irrelevant to it. Prisma
-- cannot express a partial index; hand-written here like the outbox's dedupe
-- indexes, and never to be removed.
CREATE INDEX "outbox_event_dead_unalerted"
    ON "outbox_event" ("completedAt")
 WHERE "status" = 'DEAD' AND "alertedAt" IS NULL;

-- CreateIndex
CREATE INDEX "audit_log_propertyId_actorUserId_createdAt_idx"
    ON "audit_log" ("propertyId", "actorUserId", "createdAt");

-- The new permission, so custom roles can grant it without a re-seed, and the
-- administrator templates hold it (the seed keeps both in sync too).
INSERT INTO "permission" ("id", "key", "label", "description", "category", "sensitive")
VALUES (gen_random_uuid(), 'audit_log:read', 'View audit log',
        'Read who changed what at this property, with the values before and after.', 'ADMINISTRATION', false)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT r."id", p."id"
  FROM "role" r CROSS JOIN "permission" p
 WHERE r."key" IN ('PROPERTY_ADMIN', 'SUPER_ADMIN') AND r."propertyId" IS NULL
   AND p."key" = 'audit_log:read'
ON CONFLICT DO NOTHING;
