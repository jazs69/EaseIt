/**
 * Static assertions over the room_blocks migration FILE.
 *
 * ===========================================================================
 * WHAT THIS CAN AND CANNOT PROVE.
 *
 * It reads `migration.sql` off disk and asserts its text. Nothing here
 * executes SQL, connects to PostgreSQL, or demonstrates that the migration
 * applies -- a green run says the file SAYS the right thing, not that
 * PostgreSQL accepts it. Operator acceptance, constraint enforcement,
 * `btree_gist` resolution and MATCH SIMPLE behaviour on a NULL `roomId` all
 * need the migration applied to a disposable database and belong to the
 * integration suite listed as unrun.
 *
 * WHY IT EXISTS ANYWAY. Two defects in this file were caught by hand during
 * review: a composite foreign key whose column order did not match the
 * referenced unique constraint, and a miscount of the CHECK constraints in a
 * written report. Both were textual and both were cheap to assert. This is the
 * cheapest layer that would have caught them.
 *
 * The REFERENCED constraints are read from the historical migration too, so
 * the column-order assertion compares the real referencing side against the
 * real referenced side rather than against a restatement of either.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

const MIGRATION = 'packages/database/prisma/migrations/20261108120000_room_blocks/migration.sql';
const HISTORICAL =
  'packages/database/prisma/migrations/20261016140000_inventory_and_reservations/migration.sql';
const SCHEMA = 'packages/database/prisma/schema.prisma';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function read(relative) {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

/**
 * Strip `--` line comments so prose cannot satisfy an assertion.
 *
 * Whole-line only, and each stripped line becomes empty rather than vanishing,
 * so line numbers in any failure message still line up with the file. A
 * trailing `--` is left alone; this file has none, which is asserted below.
 */
function stripSql(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*--/.test(line) ? '' : line))
    .join('\n');
}

const raw = read(MIGRATION);
const sql = stripSql(raw);
const historical = stripSql(read(HISTORICAL));
const schema = read(SCHEMA);

/** Statements, split on `;` with comments already removed. */
const statements = sql
  .split(';')
  .map((part) => part.trim())
  .filter((part) => part.length > 0);

console.log('\n════ room_blocks migration (text only) ════\n');

/* ------------------------------------------------------------------ 0 */
console.log('0. The comment stripper, and that the file needs only whole-line stripping.');
{
  check(
    'whole-line -- comments are removed',
    !stripSql('-- rooms CHECK in prose\nreal();').includes('in prose'),
  );
  check('code survives', stripSql('-- x\nreal();').includes('real()'));
  check(
    'line count is preserved, so failure line numbers stay honest',
    stripSql('-- a\n-- b\nx').split('\n').length === 3,
  );

  const trailing = raw
    .split('\n')
    .filter((line) => !/^\s*--/.test(line) && line.includes('--'));
  check(
    'no statement line carries a trailing -- comment, so stripping is complete',
    trailing.length === 0,
    `${String(trailing.length)} found`,
  );
}

/* ------------------------------------------------------------------ 1 */
console.log('\n1. Composite foreign keys match the constraints they reference.');
{
  // The referenced side, read from the historical migration rather than assumed.
  const referenced = {};
  for (const match of historical.matchAll(
    /ALTER TABLE "(\w+)"\s+ADD CONSTRAINT "(\w+_property_id_unique_pair)"\s+UNIQUE \(([^)]*)\)/g,
  )) {
    referenced[match[1]] = match[3].replace(/\s+/g, '');
  }

  check(
    'room carries a unique pair',
    referenced['room'] !== undefined,
    referenced['room'] ?? 'MISSING',
  );
  check(
    'room_type carries a unique pair',
    referenced['room_type'] !== undefined,
    referenced['room_type'] ?? 'MISSING',
  );
  check(
    'both unique pairs are ("id","propertyId") in that order',
    referenced['room'] === '"id","propertyId"' && referenced['room_type'] === '"id","propertyId"',
    `room=${String(referenced['room'])} room_type=${String(referenced['room_type'])}`,
  );

  // The referencing side, from the migration under test.
  const composites = [
    ...sql.matchAll(
      /ADD CONSTRAINT "(room_block_same_property_as_\w+)"\s+FOREIGN KEY \(([^)]*)\)\s+REFERENCES "(\w+)"\(([^)]*)\)\s+(ON DELETE \w+ ON UPDATE \w+)/g,
    ),
  ].map((match) => ({
    name: match[1],
    referencing: match[2].replace(/\s+/g, ''),
    table: match[3],
    referencedCols: match[4].replace(/\s+/g, ''),
    actions: match[5],
  }));

  check(
    'exactly two composite foreign keys exist — no duplicate or dangling clause',
    composites.length === 2,
    composites.map((c) => c.name).join(', '),
  );

  for (const expected of [
    { name: 'room_block_same_property_as_room_type', fk: 'roomTypeId', table: 'room_type' },
    { name: 'room_block_same_property_as_room', fk: 'roomId', table: 'room' },
  ]) {
    const found = composites.find((c) => c.name === expected.name);
    check(`${expected.name} is present`, found !== undefined);
    if (found === undefined) continue;

    check(
      `  referencing order is ("${expected.fk}","propertyId")`,
      found.referencing === `"${expected.fk}","propertyId"`,
      found.referencing,
    );
    check(
      `  references ${expected.table}("id","propertyId")`,
      found.table === expected.table && found.referencedCols === '"id","propertyId"',
      `${found.table}(${found.referencedCols})`,
    );
    check(
      '  referencing order mirrors the referenced unique pair, position by position',
      found.referencing.split(',').length === found.referencedCols.split(',').length &&
        found.referencedCols === referenced[expected.table],
      `${found.referencing} -> ${found.referencedCols}`,
    );
    check('  actions are RESTRICT/CASCADE', found.actions === 'ON DELETE RESTRICT ON UPDATE CASCADE', found.actions);
  }

  // The defect that was caught by hand: the reversed order would have been
  // ("propertyId","<fk>Id") referencing ("propertyId","id").
  check(
    'the previously-corrected reversed order is absent',
    !/FOREIGN KEY \("propertyId",\s*"room/.test(sql) &&
      !/REFERENCES "room(_type)?"\("propertyId",\s*"id"\)/.test(sql),
  );
}

/* ------------------------------------------------------------------ 2 */
console.log('\n2. Exactly four CHECK constraints.');
{
  const checks = [
    ...sql.matchAll(/ADD CONSTRAINT "(\w+)"\s+CHECK/g),
  ].map((match) => match[1]);

  check(
    'four, no more and no fewer',
    checks.length === 4,
    `${String(checks.length)}: ${checks.join(', ')}`,
  );

  for (const name of [
    'room_block_through_after_from',
    'room_block_rooms_positive',
    'room_block_specific_is_one_room',
    'room_block_release_is_attributed',
  ]) {
    check(`  ${name} present`, checks.includes(name));
  }

  check(
    'the range CHECK is strict (>), so a zero-night block cannot slip past the GiST',
    /CHECK \("throughDate" > "fromDate"\)/.test(sql),
  );
  check(
    'a specific-room block is structurally one room',
    /CHECK \("roomId" IS NULL OR "rooms" = 1\)/.test(sql),
  );
  check(
    'a release must carry both actor and timestamp',
    /"status" <> 'RELEASED'\s*OR \("releasedByUserId" IS NOT NULL AND "releasedAt" IS NOT NULL\)/.test(
      sql,
    ),
  );
}

/* ------------------------------------------------------------------ 3 */
console.log('\n3. The GiST exclusion constraint and its predicate.');
{
  const extensionAt = sql.indexOf('CREATE EXTENSION IF NOT EXISTS btree_gist');
  const excludeAt = sql.indexOf('EXCLUDE USING gist');
  check('btree_gist is created', extensionAt !== -1);
  check('and it precedes the EXCLUDE that needs it', extensionAt !== -1 && extensionAt < excludeAt);

  check(
    'the room column uses equality, which is what btree_gist adds to GiST',
    /"roomId" WITH =/.test(sql),
  );
  check(
    "the range is half-open '[)', matching reservation_room_no_overlap",
    /daterange\("fromDate", "throughDate", '\[\)'\) WITH &&/.test(sql),
  );
  check(
    'the predicate covers ACTIVE rows only, so a released block frees the room',
    /WHERE \("status" = 'ACTIVE' AND "roomId" IS NOT NULL\)/.test(sql),
  );
  check(
    'and excludes category blocks, which legitimately overlap',
    /"roomId" IS NOT NULL\)/.test(sql),
  );

  // The same shape as the stay constraint it has to agree with.
  check(
    'reservation_room_no_overlap uses the same daterange bound, so the two agree',
    /daterange\("arrivalDate", "departureDate", '\[\)'\) WITH &&/.test(historical),
  );
}

/* ------------------------------------------------------------------ 4 */
console.log('\n4. Nullable roomId, column types and defaults.');
{
  const create = /CREATE TABLE "room_block" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
  check('the CREATE TABLE block was found', create.length > 0);

  check(
    'roomId is nullable — a category block names no room',
    /"roomId"\s+UUID(?!\s+NOT NULL)/.test(create),
  );
  check('propertyId is NOT NULL', /"propertyId"\s+UUID\s+NOT NULL/.test(create));
  check('roomTypeId is NOT NULL', /"roomTypeId"\s+UUID\s+NOT NULL/.test(create));
  check('rooms defaults to 1', /"rooms"\s+INTEGER\s+NOT NULL DEFAULT 1/.test(create));
  check('status defaults to ACTIVE', /"status"\s+"RoomBlockStatus"\s+NOT NULL DEFAULT 'ACTIVE'/.test(create));
  check(
    'fromDate and throughDate are DATE, never a timestamp',
    /"fromDate"\s+DATE\s+NOT NULL/.test(create) && /"throughDate"\s+DATE\s+NOT NULL/.test(create),
  );
  check(
    'createdAt/updatedAt match the convention used by inventory_day',
    /"createdAt"\s+TIMESTAMPTZ\(6\)\s+NOT NULL DEFAULT CURRENT_TIMESTAMP/.test(create) &&
      /"updatedAt"\s+TIMESTAMPTZ\(6\)\s+NOT NULL,/.test(create),
  );
  check('a primary key is declared', /CONSTRAINT "room_block_pkey" PRIMARY KEY \("id"\)/.test(create));
}

/* ------------------------------------------------------------------ 5 */
console.log('\n5. Plain foreign-key actions.');
{
  const fk = (name) =>
    new RegExp(
      `ADD CONSTRAINT "${name}"\\s+FOREIGN KEY \\("\\w+"\\) REFERENCES "\\w+"\\("id"\\)\\s+(ON DELETE \\w+ ON UPDATE \\w+)`,
    ).exec(sql)?.[1];

  check(
    'property is CASCADE — a deleted hotel takes its blocks with it',
    fk('room_block_propertyId_fkey') === 'ON DELETE CASCADE ON UPDATE CASCADE',
    String(fk('room_block_propertyId_fkey')),
  );
  check(
    'room_type is RESTRICT — deleting a category under a block would orphan blocked capacity',
    fk('room_block_roomTypeId_fkey') === 'ON DELETE RESTRICT ON UPDATE CASCADE',
    String(fk('room_block_roomTypeId_fkey')),
  );
  check(
    'room is RESTRICT, for the same reason',
    fk('room_block_roomId_fkey') === 'ON DELETE RESTRICT ON UPDATE CASCADE',
    String(fk('room_block_roomId_fkey')),
  );
  check(
    'no actor column carries a foreign key, matching audit_log.actorUserId',
    !/REFERENCES "user"/.test(sql),
  );
}

/* ------------------------------------------------------------------ 6 */
console.log('\n6. Nothing outside room_block is touched.');
{
  const targets = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((match) => match[1]);
  check(
    'every ALTER TABLE targets room_block',
    targets.length > 0 && targets.every((table) => table === 'room_block'),
    `${String(targets.length)} statements, targets: ${[...new Set(targets)].join(', ')}`,
  );
  check(
    'no DROP, DELETE, TRUNCATE, UPDATE, INSERT or ALTER COLUMN anywhere',
    !/\b(DROP|DELETE\s+FROM|TRUNCATE|UPDATE\s+"|INSERT\s+INTO|ALTER\s+COLUMN)\b/i.test(sql),
  );
  check(
    'inventory_day is not mentioned in any statement',
    !/inventory_day/i.test(sql),
    'its CHECK constraints are untouched',
  );
}

/* ------------------------------------------------------------------ 7 */
console.log('\n7. Creation order, and enum/index declarations.');
{
  const order = [
    ['CREATE TYPE "RoomBlockReason"', sql.indexOf('CREATE TYPE "RoomBlockReason"')],
    ['CREATE TYPE "RoomBlockStatus"', sql.indexOf('CREATE TYPE "RoomBlockStatus"')],
    ['CREATE TABLE "room_block"', sql.indexOf('CREATE TABLE "room_block"')],
    ['first CREATE INDEX', sql.indexOf('CREATE INDEX')],
    ['first ALTER TABLE', sql.indexOf('ALTER TABLE "room_block"')],
  ];
  check(
    'enums, then table, then indexes, then constraints',
    order.every(([, at]) => at !== -1) &&
      order.every(([, at], i) => i === 0 || at > order[i - 1][1]),
    order.map(([label, at]) => `${label}@${String(at)}`).join(' < '),
  );

  check(
    'every index leads with propertyId (section 3.2)',
    [...sql.matchAll(/CREATE INDEX "\w+"\s+ON "room_block"\(([^)]*)\)/g)].every((match) =>
      match[1].trim().startsWith('"propertyId"'),
    ),
  );
  check('four indexes, matching the four @@index in the model', (sql.match(/CREATE INDEX/g) ?? []).length === 4);

  const model = /model RoomBlock \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
  check(
    'the Prisma model declares the same four indexes',
    (model.match(/@@index/g) ?? []).length === 4,
    `${String((model.match(/@@index/g) ?? []).length)} found`,
  );
  check('and maps to the same table name', /@@map\("room_block"\)/.test(model));
  check(
    'the model declares no @@unique, because the table has none',
    !/@@unique/.test(model) && !/CREATE UNIQUE INDEX/.test(sql),
  );
}

console.log('');
if (failures > 0) {
  console.error(`${String(failures)} migration text check(s) failed.`);
  process.exit(1);
}
console.log('All migration text checks passed (TEXT ONLY — not executed against PostgreSQL).');
