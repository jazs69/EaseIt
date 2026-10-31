-- ---------------------------------------------------------------------------
-- Folio payment idempotency (FO-03 / FO-04).
--
-- A retried or double-submitted payment must not create a second payment
-- line. A folio line is immutable (CLAUDE.md section 3.4), so a duplicate
-- cannot be edited away: it has to be corrected with a reversing line, and
-- until somebody does, the folio is wrong in the direction that blocks a
-- departure -- check-out refuses a balance that is non-zero in either
-- direction, so a duplicate payment leaves the guest in credit and unable to
-- check out.
--
-- The guarantee is the index, not a pre-insert lookup. Two concurrent
-- requests carrying the same key both read "no such line" and both proceed;
-- only a unique index can decide between them, and it decides correctly under
-- any isolation level. This is the same position section 3.1 takes on
-- overselling: the application cooperates, the database arbitrates.
--
-- Scope is (propertyId, idempotencyKey) rather than
-- (propertyId, folioId, idempotencyKey). Including the folio would make the
-- same key on a different folio a second, accepted payment; leaving it out
-- makes that a conflict the service names. Keys are client-generated 16-64
-- character randoms, so a cross-folio collision is a client bug, and a bug
-- about which payment a reference stands for is one to refuse rather than to
-- resolve by guessing. The folio is checked as a material attribute of the
-- intent instead.
--
-- Nullable, and NULLs are distinct in a PostgreSQL unique index. Every
-- system-generated line -- room charges, taxes, corrections, the night
-- audit's postings -- keeps a NULL key and is unaffected, as is every row
-- that already exists. No backfill, no partial index, no rewrite.
--
-- Forward-only. To undo, add a migration that drops the index and the column.
-- ---------------------------------------------------------------------------

ALTER TABLE "folio_line" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "folio_line_propertyId_idempotencyKey_key"
  ON "folio_line" ("propertyId", "idempotencyKey");
