-- IE-02: the `data:export` permission.
--
-- Registered here so custom roles can grant it without a re-seed, and held by
-- the administrator templates (the seed keeps both in sync too). Sensitive:
-- the reservation and guest exports carry personal data.
--
-- Existing rows: none change. One permission row and two role_permission rows
-- are added.

INSERT INTO "permission" ("id", "key", "label", "description", "category", "sensitive")
VALUES (gen_random_uuid(), 'data:export', 'Export data',
        'Download the property''s rooms, rates, reservations, folio lines and guest profiles as CSV.',
        'ADMINISTRATION', true)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT r."id", p."id"
  FROM "role" r CROSS JOIN "permission" p
 WHERE r."key" IN ('PROPERTY_ADMIN', 'SUPER_ADMIN') AND r."propertyId" IS NULL
   AND p."key" = 'data:export'
ON CONFLICT DO NOTHING;
