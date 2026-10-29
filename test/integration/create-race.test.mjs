/**
 * The reservation-creation race suite.
 *
 * ===========================================================================
 * The three interleavings the hardening work left unverified.
 *
 * `cancel-reservation.test.mjs` proves cancellation against check-in and
 * against a cross-category room move. It does not touch **creation**, and
 * creation is the one path with a different lock order: every other operation
 * takes the reservation row `FOR UPDATE` first and `inventory_day` second,
 * while `create-reservation.service.ts` takes `inventory_day` first because it
 * has no reservation row yet to contend for. That asymmetry was argued safe
 * (no two-party cycle) but never exercised, which is exactly the kind of claim
 * that should be a test rather than a paragraph.
 *
 * What this suite adds:
 *
 *   A1  creation racing cancellation for the same last unit;
 *   A2  creation whose pre-flight availability is invalidated while it is
 *       parked on the inventory lock — the deterministic one;
 *   B   creation racing a cross-category room move into the category being
 *       created in;
 *   C   a three-way interleaving: cancellation, a cross-category move and a
 *       creation, all parked on the same rows at once.
 *
 * ---------------------------------------------------------------------------
 * Why this file refuses to run against the development database.
 *
 * Every other suite here reuses seeded fixtures and cleans up after itself.
 * This one fills a category to its physical limit and then parks two or three
 * write transactions on the same `inventory_day` rows on purpose, so a crash
 * mid-race can leave a counter high. On a shared database that is somebody
 * else's afternoon. So it asserts its own database identity before it creates
 * anything (`assertIsolatedDatabase`) and exits rather than guessing.
 *
 * Provision the isolated database once:
 *
 *   createdb -h 127.0.0.1 -U easeit -O easeit easeit_racetest
 *   cd packages/database
 *   DATABASE_URL=<dev url with /easeit -> /easeit_racetest> \
 *   DIRECT_URL=<same> pnpm exec prisma migrate deploy
 *   DATABASE_URL=<same> DIRECT_URL=<same> pnpm exec tsx prisma/seed.ts
 *
 * then run an API against it and point this suite at both:
 *
 *   node --env-file=<override> apps/api/dist/main.js      # PORT=4100
 *   EASEIT_API_URL=http://127.0.0.1:4100/api/v1 \
 *   DATABASE_URL=<test url> node test/integration/create-race.test.mjs
 *
 * ---------------------------------------------------------------------------
 * How a race is reached deterministically.
 *
 * Firing two HTTP requests and hoping is what step 13 of the cancellation
 * suite does, and it reproduced its defect roughly once in fifteen runs. This
 * suite instead opens a transaction of its own, takes the contended
 * `inventory_day` rows `FOR UPDATE`, fires the real endpoints, and waits until
 * Postgres itself reports the expected number of backends blocked on a lock
 * (`pg_stat_activity.wait_event_type = 'Lock'`). Only then does it release.
 *
 * So the *window* is deterministic — every operation is provably inside it
 * before any of them proceeds. The *winner* is not, and is not asserted to be:
 * both orderings are legal outcomes of a genuine race, so what is asserted is
 * the invariant that must hold either way. Polling `pg_stat_activity` is a
 * real condition with a deadline, not a sleep standing in for synchronisation.
 *
 * `ROW_LOCK_TIMEOUT_MS` is 3 s and cancellation, move and check-in each set it
 * transaction-locally, so the gate releases the instant the backends are
 * parked rather than holding for a fixed duration; a 55P03 from the gate
 * itself would measure the harness, not the code.
 *
 * NOTE: no deadlock or serialization failure is induced anywhere in this file.
 * `40001` and `40P01` retry handling remains unverified at runtime, as it was
 * before this suite existed. Nothing here should be read as covering it.
 * ===========================================================================
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Same resolution as the suites beside it: the repo's `.env`, then the root one. */
function loadDatabaseEnv() {
  for (const relative of ['../../packages/database/.env', '../../.env']) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
      const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m.exec(text);
      if (match?.[1]) return match[1];
    } catch {
      // Next candidate. A missing file here is ordinary, not an error.
    }
  }
  return null;
}

process.env.DATABASE_URL ??= loadDatabaseEnv() ?? '';
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set and no .env was found.');
  process.exit(1);
}

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;

const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4100/api/v1';

/**
 * The only database this suite will touch.
 *
 * Deliberately a literal rather than "anything that is not `easeit`": an
 * allowlist fails closed when someone copies this file and forgets to think,
 * and a denylist does not.
 */
const REQUIRED_DB = process.env.EASEIT_TEST_DB ?? 'easeit_racetest';

/** Fixture names all start here, so a crashed run is identifiable and sweepable. */
const FIXTURE_PREFIX = 'ZZRACE';

const prisma = createPrismaClient();

let failures = 0;
/** Set once the suite owns a property, so teardown knows what to remove. */
let fixture = null;
/** Reservations created through the API, for teardown. */
const createdReservations = new Set();

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mintSession(userId, email) {
  const env = readFileSync(new URL('../../apps/api/.env', import.meta.url), 'utf8');
  const secret = /^JWT_SECRET\s*=\s*"?([^"\r\n]+)"?/m.exec(env)?.[1];
  if (!secret) throw new Error('JWT_SECRET not found in apps/api/.env');

  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: userId,
    email,
    pid: null,
    amr: ['pwd', 'otp'],
    iat: now,
    exp: now + 3600,
  })}`;

  return `${input}.${createHmac('sha256', secret).update(input, 'utf8').digest('base64url')}`;
}

const isoDate = (date) => date.toISOString().slice(0, 10);

function shiftDays(iso, days) {
  return isoDate(new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + days * 86_400_000));
}

function stayDates(arrival, departure) {
  const out = [];
  for (let d = arrival; d < departure; d = shiftDays(d, 1)) out.push(d);
  return out;
}

async function call(method, path, cookie, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

/* -------------------------------------------------------------------------- */
/*  Guard: the database this is allowed to wreck                              */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to continue unless this is the dedicated, local, isolated database.
 *
 * Checked three ways, because the cheap check is the one that lies: the URL
 * says what we *meant* to connect to, `current_database()` says what we
 * actually reached, and the fixture count says nobody else's data is in here
 * to lose. All three run before a single row is written.
 */
async function assertIsolatedDatabase() {
  const url = process.env.DATABASE_URL;
  const parsed = /^(\w+):\/\/[^:]+:[^@]*@([^/:]+):(\d+)\/([^?]+)/.exec(url);
  if (parsed === null) throw new Error('DATABASE_URL has an unrecognised shape.');

  const [, , host, port, dbname] = parsed;

  if (dbname !== REQUIRED_DB) {
    throw new Error(
      `REFUSING TO RUN. This suite fills categories to their limit and parks ` +
        `write transactions on inventory rows; it must not touch a shared database. ` +
        `DATABASE_URL names "${dbname}" but only "${REQUIRED_DB}" is permitted. ` +
        `Provision it with the commands in this file's header.`,
    );
  }

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`REFUSING TO RUN. Host "${host}" is not local.`);
  }

  const [live] = await prisma.$queryRaw`SELECT current_database() AS name, version() AS version`;
  if (live.name !== REQUIRED_DB) {
    throw new Error(
      `REFUSING TO RUN. Connected to "${live.name}", not "${REQUIRED_DB}". ` +
        `The URL and the live connection disagree.`,
    );
  }

  console.log(`Database  ${live.name} on ${host}:${port}`);
  console.log(`          ${live.version.split(',')[0]}`);

  // The constraints this suite's assertions lean on. Without them a green run
  // would prove nothing at all, so their absence is a hard stop rather than a
  // skipped check.
  const constraints = await prisma.$queryRaw`
    SELECT conname FROM pg_constraint
    WHERE conname IN ('inventory_day_not_oversold', 'reservation_room_no_overlap',
                      'inventory_day_counters_non_negative')`;
  const present = new Set(constraints.map((row) => row.conname));
  for (const required of [
    'inventory_day_not_oversold',
    'reservation_room_no_overlap',
    'inventory_day_counters_non_negative',
  ]) {
    if (!present.has(required)) {
      throw new Error(`REFUSING TO RUN. Constraint ${required} is missing; migrations are stale.`);
    }
  }
  console.log(`          ${present.size} guarding constraints present\n`);
}

/**
 * Prove the API under test shares this database.
 *
 * Without this the suite could assert against `easeit_racetest` while the
 * endpoints quietly wrote to the development database — every counter check
 * would pass for the wrong reason. The property below exists only here, so an
 * API on any other database answers 404.
 */
async function assertApiSharesDatabase(cookie, propertyId) {
  /**
   * By UUID, not by code.
   *
   * `ActivePropertyGuard.requestedPropertyId` reads `params['propertyId']` and
   * queries `property.findFirst({ where: { id } })`, so this route genuinely
   * needs the uuid. The reservation routes below name their parameter
   * `:hotelId`, which that guard never reads — they resolve the property from
   * the caller's sole grant instead, which is why this suite's user holds
   * exactly one.
   */
  const response = await call('GET', `/properties/${propertyId}/me`, cookie);
  if (response.status !== 200) {
    throw new Error(
      `REFUSING TO RUN. The API at ${API} cannot see this suite's property ` +
        `${propertyId} (HTTP ${String(response.status)}). It is pointed at a different ` +
        `database. Start an API with DATABASE_URL set to ${REQUIRED_DB}.`,
    );
  }
  console.log(`API       ${API} — confirmed on the same database\n`);
}

/* -------------------------------------------------------------------------- */
/*  Reads and invariants                                                      */
/* -------------------------------------------------------------------------- */

/** `sold`/`physical` per night for one category, keyed `YYYY-MM-DD`. */
async function soldByDate(roomTypeId, dates) {
  const rows = await prisma.inventoryDay.findMany({
    where: {
      propertyId: fixture.propertyId,
      roomTypeId,
      stayDate: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) },
    },
    select: {
      stayDate: true,
      physical: true,
      sold: true,
      blocked: true,
      overbookingAllowance: true,
    },
  });
  const map = new Map();
  for (const row of rows) map.set(isoDate(row.stayDate), row);
  return map;
}

/**
 * How many rooms of each category are genuinely held, per night.
 *
 * Derived from the live `reservation_room` rows rather than from the counter,
 * because comparing the counter with itself proves nothing. This is the
 * assertion that caught Defect 2: aggregate totals matched while the
 * individual categories were both wrong.
 *
 * `CONFIRMED`/`CHECKED_IN`/`CHECKED_OUT` is `CONSUMES_INVENTORY` from
 * `reservation.state.ts`, kept in step with it by name here on purpose.
 */
async function heldByDate() {
  const rows = await prisma.$queryRaw`
    SELECT rr."roomTypeId"::text AS room_type_id,
           to_char(d, 'YYYY-MM-DD')  AS stay_date,
           count(*)::int             AS held
    FROM reservation_room rr
    JOIN reservation r ON r."id" = rr."reservationId"
    CROSS JOIN LATERAL generate_series(
      rr."arrivalDate", rr."departureDate" - INTERVAL '1 day', INTERVAL '1 day') AS d
    WHERE rr."propertyId" = ${fixture.propertyId}::uuid
      AND r."status" IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')
    GROUP BY 1, 2`;
  const map = new Map();
  for (const row of rows) map.set(`${row.room_type_id}|${row.stay_date}`, row.held);
  return map;
}

/**
 * The whole point of the suite, in one function.
 *
 * Asserts, for every category and every night this suite owns:
 *   * `sold` equals the number of live room rows — catches a release that ran
 *     twice (sold too low) and a consumption counted twice (sold too high);
 *   * the oversell invariant still holds;
 *   * no counter went negative.
 */
async function assertCounters(label, roomTypeIds, dates) {
  const held = await heldByDate();
  const problems = [];

  for (const roomTypeId of roomTypeIds) {
    const days = await soldByDate(roomTypeId, dates);
    for (const date of dates) {
      const day = days.get(date);
      if (day === undefined) {
        problems.push(`${date}: no inventory row`);
        continue;
      }
      const expected = held.get(`${roomTypeId}|${date}`) ?? 0;
      const name = fixture.names.get(roomTypeId) ?? roomTypeId.slice(0, 8);

      if (day.sold !== expected) {
        problems.push(
          `${name} ${date}: sold=${String(day.sold)} but ${String(expected)} room row(s) live`,
        );
      }
      if (day.sold < 0 || day.blocked < 0) {
        problems.push(`${name} ${date}: negative counter sold=${String(day.sold)}`);
      }
      if (day.sold + day.blocked > day.physical + day.overbookingAllowance) {
        problems.push(
          `${name} ${date}: oversold sold=${String(day.sold)} blocked=${String(day.blocked)} ` +
            `physical=${String(day.physical)}`,
        );
      }
    }
  }

  check(
    `${label}: every category's sold count matches its live room rows, with no oversell`,
    problems.length === 0,
    problems.length === 0
      ? `${String(roomTypeIds.length)} categor(ies) × ${String(dates.length)} night(s)`
      : problems.join('; '),
  );
  return problems.length === 0;
}

/** The database's own opinion, independent of this suite's arithmetic. */
async function constraintViolations() {
  const rows = await prisma.$queryRaw`
    SELECT count(*)::int AS bad FROM inventory_day
    WHERE "propertyId" = ${fixture.propertyId}::uuid
      AND (sold < 0 OR blocked < 0 OR sold + blocked > physical + "overbookingAllowance")`;
  return rows[0].bad;
}

/** Folio lines and their total for one reservation — the money fingerprint. */
async function folioFingerprint(reservationId) {
  const rows = await prisma.$queryRaw`
    SELECT count(fl.*)::int AS lines,
           COALESCE(sum(fl."amountMinor"), 0)::bigint AS total
    FROM folio f
    LEFT JOIN folio_line fl ON fl."folioId" = f."id"
    WHERE f."reservationId" = ${reservationId}::uuid`;
  return { lines: rows[0].lines, total: String(rows[0].total) };
}

/** How many audit rows exist for one reservation. */
async function auditCount(reservationId) {
  const rows = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM audit_log
    WHERE "propertyId" = ${fixture.propertyId}::uuid
      AND "entityId" = ${reservationId}::uuid`;
  return rows[0].n;
}

/** A 5xx is never an acceptable answer to a race. */
function assertTyped(label, response, allowed) {
  const ok = allowed.includes(response.status);
  check(
    label,
    ok,
    `HTTP ${String(response.status)}${
      response.status >= 500 ? ' — INFRASTRUCTURE ERROR' : ''
    }${response.payload?.code ? ` ${response.payload.code}` : ''}`,
  );
  if (response.status >= 500) {
    console.error(`        payload: ${JSON.stringify(response.payload).slice(0, 300)}`);
  }
  return ok;
}

/* -------------------------------------------------------------------------- */
/*  The gate                                                                  */
/* -------------------------------------------------------------------------- */

/** Backends in this database blocked on a lock — the proof the race is reached. */
async function lockWaiters() {
  const rows = await prisma.$queryRaw`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`;
  return rows[0].waiting;
}

/**
 * Run `operations` concurrently, guaranteed to be contending.
 *
 * Holds the given `inventory_day` rows `FOR UPDATE` in a transaction of its
 * own, fires every operation, waits until Postgres reports `expectParked`
 * backends blocked on a lock, then releases and returns the settled results.
 *
 * `mutate` is an optional callback run while everything is parked and the gate
 * still holds the rows — used by A2 to invalidate a pre-flight read from
 * inside the window, which is the only way to make that interleaving
 * deterministic without a production test hook.
 *
 * `staged` is what makes the *winner* deterministic too, and it is worth
 * explaining because the first version of this suite got it wrong. Firing
 * everything at once produced the same result in all 14 rounds anyway, but by
 * accident rather than by design: Postgres queues conflicting lock requests
 * FIFO, and a creation reaches the queue first every time because its
 * transaction runs two statements before the inventory lock while a move runs
 * six (reservation row, status re-read, assignment re-read). The ordering was
 * an artefact of how much work each path does first.
 *
 * With `staged`, each operation is fired and then *confirmed parked* before
 * the next is fired, so the queue order is the array order. The interleaving
 * stops being an accident and the expected outcome can actually be asserted
 * instead of merely bounded.
 *
 * The gate releases as soon as the backends are parked rather than after a
 * fixed delay: the operations under test bound their own lock waits at
 * `ROW_LOCK_TIMEOUT_MS` (3 s), and a gate that outlasted that would be
 * measuring the harness.
 */
async function raceUnderLock({
  roomTypeIds,
  dates,
  operations,
  expectParked,
  mutate = null,
  staged = false,
}) {
  let releaseGate;
  const released = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let gateReady;
  const ready = new Promise((resolve) => {
    gateReady = resolve;
  });

  const stayDateValues = dates.map((d) => new Date(`${d}T00:00:00.000Z`));
  let gateError = null;
  let parkedSeen = 0;

  const hold = prisma
    .$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "stayDate" FROM inventory_day
          WHERE "propertyId" = ${fixture.propertyId}::uuid
            AND "roomTypeId" = ANY(${roomTypeIds}::uuid[])
            AND "stayDate" = ANY(${stayDateValues}::date[])
          ORDER BY "stayDate" ASC, "roomTypeId" ASC
          FOR UPDATE`;

        gateReady();
        await released;

        if (mutate !== null) await mutate(tx);
      },
      { timeout: 60_000, maxWait: 15_000 },
    )
    .catch((error) => {
      gateError = error;
    });

  await ready;

  // Baseline first: other backends may legitimately be waiting on something
  // unrelated, so what matters is the rise, not the absolute count.
  const baseline = await lockWaiters();

  /** Wait until `want` more backends than baseline are blocked on a lock. */
  async function waitForParked(want) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const waiting = await lockWaiters();
      parkedSeen = Math.max(parkedSeen, waiting - baseline);
      if (waiting - baseline >= want) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  let results;
  let parked;

  if (staged) {
    // One at a time, each confirmed in the queue before the next joins it, so
    // the lock queue order is the array order.
    results = [];
    parked = true;
    for (let i = 0; i < operations.length; i += 1) {
      results.push(operations[i]());
      if (!(await waitForParked(i + 1))) {
        parked = false;
        break;
      }
    }
  } else {
    results = operations.map((operation) => operation());
    parked = await waitForParked(expectParked);
  }

  releaseGate();
  await hold;

  if (gateError !== null) {
    throw new Error(`the gate transaction failed: ${String(gateError.message ?? gateError)}`);
  }

  const settled = await Promise.all(results);
  return { settled, parked, parkedSeen };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures — everything this suite owns                                     */
/* -------------------------------------------------------------------------- */

/**
 * Remove anything a previous crashed run of this suite left behind.
 *
 * Safe because it is keyed on `FIXTURE_PREFIX`, which only this suite writes,
 * and because the identity guard has already established that this database
 * exists for this suite alone.
 */
async function sweepLeftovers() {
  const stale = await prisma.property.findMany({
    where: { code: { startsWith: FIXTURE_PREFIX } },
    select: { id: true, code: true },
  });
  if (stale.length === 0) return;

  console.log(
    `Sweeping ${String(stale.length)} leftover fixture propert(ies) from an earlier run.`,
  );
  for (const property of stale) {
    await dropProperty(property.id);
    console.log(`  removed ${property.code}`);
  }

  // The harness users those runs created. Keyed on the suite's own address
  // domain, which nothing else writes, and done after the properties so the
  // grants are already gone.
  const orphans = await prisma.user.deleteMany({
    where: { email: { endsWith: '@race.invalid' }, propertyRoles: { none: {} } },
  });
  if (orphans.count > 0) console.log(`  removed ${String(orphans.count)} leftover harness user(s)`);
}

/**
 * Delete one suite-owned property and everything hanging off it.
 *
 * Order matters and comes from the real schema, not from hope:
 * `ReservationRoom.roomType` and `.room` are `onDelete: Restrict`
 * (schema.prisma:1045, 1049) and `Room.roomType` is `Restrict` (:692), so the
 * stays go before the rooms and the rooms before the categories. Everything
 * keyed only on `propertyId` cascades, but it is deleted explicitly anyway so
 * a Restrict further down cannot strand the property row.
 */
async function dropProperty(propertyId, userId = null) {
  const scope = { propertyId };
  await prisma.$transaction(
    async (tx) => {
      await tx.folioLine.deleteMany({ where: { folio: { propertyId } } });
      await tx.folio.deleteMany({ where: scope });
      await tx.reservationRoom.deleteMany({ where: scope });
      await tx.reservation.deleteMany({ where: scope });
      await tx.room.deleteMany({ where: scope });
      await tx.inventoryDay.deleteMany({ where: scope });
      await tx.roomType.deleteMany({ where: scope });
      await tx.auditLog.deleteMany({ where: scope });
      await tx.outboxEvent.deleteMany({ where: scope });
      await tx.userPropertyRole.deleteMany({ where: scope });
      await tx.propertySettings.deleteMany({ where: scope });
      await tx.property.delete({ where: { id: propertyId } });

      // The suite's own user, once its only grant is gone with the property.
      if (userId !== null) await tx.user.deleteMany({ where: { id: userId } });
    },
    { timeout: 60_000 },
  );
}

/** Build the property, two categories, their rooms, and a front-desk grant. */
async function buildFixture() {
  const runId = Date.now().toString(36).toUpperCase().slice(-6);
  const code = `${FIXTURE_PREFIX}${runId}`;
  const businessDate = isoDate(new Date());

  const role = await prisma.role.findFirst({
    where: { key: 'PROPERTY_ADMIN', propertyId: null },
    select: { id: true },
  });
  if (role === null) throw new Error('no global PROPERTY_ADMIN role template.');

  const property = await prisma.property.create({
    data: {
      slug: `zz-race-${runId.toLowerCase()}`,
      code,
      name: `ZZ Race Harness ${runId}`,
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      businessDate: new Date(`${businessDate}T00:00:00.000Z`),
      status: 'ACTIVE',
    },
    select: { id: true, code: true, businessDate: true },
  });

  /**
   * A user this suite owns, holding exactly one grant.
   *
   * Not a seeded user, and the "exactly one" is load-bearing rather than
   * tidy: the reservation routes name their path parameter `:hotelId`, which
   * `ActivePropertyGuard` does not read, so it falls back to
   * `soleGrantedProperty(userId)` — which returns null the moment a user has
   * two. Borrowing a seeded clerk would therefore resolve to *their* property
   * or to nothing at all, and this suite would either 404 or quietly race
   * against seeded inventory. Created and removed with the fixture.
   *
   * `passwordHash` is deliberately an unusable placeholder: the session below
   * is minted directly from `JWT_SECRET`, so this account can never be logged
   * into even while it exists.
   */
  const actor = await prisma.user.create({
    data: {
      email: `zzrace-${runId.toLowerCase()}@race.invalid`,
      passwordHash: 'not-a-usable-hash',
      firstName: 'Race',
      lastName: 'Harness',
      isActive: true,
      isTwoFactorEnabled: false,
    },
    select: { id: true, email: true },
  });

  await prisma.userPropertyRole.create({
    data: { userId: actor.id, propertyId: property.id, roleId: role.id },
  });

  // Two categories: A holds two rooms so the three-way race has somewhere to
  // put a second stay; B holds one, so a move and a creation must fight over
  // a single unit.
  const categoryA = await prisma.roomType.create({
    data: {
      propertyId: property.id,
      code: `${FIXTURE_PREFIX}A`,
      name: 'ZZ Race Category A',
      maxGuests: 2,
      baseRateMinor: 500_000,
      currency: 'INR',
      sortOrder: 1,
    },
    select: { id: true, name: true },
  });
  const categoryB = await prisma.roomType.create({
    data: {
      propertyId: property.id,
      code: `${FIXTURE_PREFIX}B`,
      name: 'ZZ Race Category B',
      maxGuests: 2,
      baseRateMinor: 700_000,
      currency: 'INR',
      sortOrder: 2,
    },
    select: { id: true, name: true },
  });

  const rooms = {};
  for (const [key, roomTypeId, number] of [
    ['a1', categoryA.id, `${FIXTURE_PREFIX}-A1`],
    ['a2', categoryA.id, `${FIXTURE_PREFIX}-A2`],
    ['b1', categoryB.id, `${FIXTURE_PREFIX}-B1`],
  ]) {
    rooms[key] = await prisma.room.create({
      data: { propertyId: property.id, roomTypeId, number, status: 'VACANT_CLEAN' },
      select: { id: true, number: true, roomTypeId: true },
    });
  }

  fixture = {
    propertyId: property.id,
    propertyCode: property.code,
    businessDate: isoDate(property.businessDate),
    categoryA: categoryA.id,
    categoryB: categoryB.id,
    rooms,
    actor,
    names: new Map([
      [categoryA.id, 'A'],
      [categoryB.id, 'B'],
    ]),
  };

  console.log(`Fixture   property ${property.code} (${property.id})`);
  console.log(`          category A ${categoryA.id}`);
  console.log(`          category B ${categoryB.id}`);
  console.log(`          rooms ${rooms.a1.number}, ${rooms.a2.number}, ${rooms.b1.number}`);
  console.log(`          acting as ${actor.email}`);
  console.log(`          business date ${fixture.businessDate}\n`);

  return fixture;
}

/** Inventory rows for one window, at exactly the physical count a round needs. */
async function ensureInventory(roomTypeId, dates, physical) {
  for (const date of dates) {
    const stayDate = new Date(`${date}T00:00:00.000Z`);
    const existing = await prisma.inventoryDay.findFirst({
      where: { propertyId: fixture.propertyId, roomTypeId, stayDate },
      select: { id: true },
    });
    if (existing === null) {
      await prisma.inventoryDay.create({
        data: {
          propertyId: fixture.propertyId,
          roomTypeId,
          stayDate,
          physical,
          sold: 0,
          blocked: 0,
        },
      });
    } else {
      await prisma.inventoryDay.update({ where: { id: existing.id }, data: { physical } });
    }
  }
}

/** A booking through the real endpoint, so inventory moves the way production moves it. */
async function book(cookie, roomTypeId, arrival, departure, overrides = {}) {
  const response = await call('POST', `/properties/${fixture.propertyCode}/reservations`, cookie, {
    roomTypeId,
    roomId: null,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Race', lastName: 'Fixture' }],
    isInstantCheckIn: false,
    ...overrides,
  });
  if (response.status !== 201) {
    throw new Error(
      `fixture booking failed: ${String(response.status)} ${JSON.stringify(response.payload)}`,
    );
  }
  createdReservations.add(response.payload.id);
  return response.payload;
}

/* -------------------------------------------------------------------------- */
/*  The suite                                                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  await assertIsolatedDatabase();
  await sweepLeftovers();
  await buildFixture();

  const cookie = `easeit_session=${mintSession(fixture.actor.id, fixture.actor.email)}`;
  await assertApiSharesDatabase(cookie, fixture.propertyId);

  /* ------------------------------------------------------------ operations */

  const opCancel = (reservationId, tag) => () =>
    call(
      'POST',
      `/properties/${fixture.propertyCode}/reservations/${reservationId}/cancel`,
      cookie,
      {
        reason: tag,
      },
    );

  const opMove = (reservationId, roomId, tag) => () =>
    call('POST', `/properties/${fixture.propertyCode}/reservations/${reservationId}/room`, cookie, {
      roomId,
      acknowledgeCategoryChange: true,
      reason: tag,
    });

  const opCreate = (roomTypeId, arrival, departure, who) => () =>
    call('POST', `/properties/${fixture.propertyCode}/reservations`, cookie, {
      roomTypeId,
      roomId: null,
      arrivalDate: arrival,
      departureDate: departure,
      adults: 2,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Race', lastName: who }],
      isInstantCheckIn: false,
    });

  /** Rounds get their own window so no two can interfere. */
  let windowCursor = 2;
  function nextWindow() {
    const arrival = shiftDays(fixture.businessDate, windowCursor);
    windowCursor += 4;
    return {
      arrival,
      departure: shiftDays(arrival, 2),
      dates: stayDates(arrival, shiftDays(arrival, 2)),
    };
  }

  /**
   * Every (category, night) pair this suite has given inventory to.
   *
   * Tracked per category rather than as a flat set of dates: A1 and A2 only
   * create rows for category A, so sweeping every owned date across both
   * categories would report B's absent rows as a failure when nothing is
   * wrong. A genuinely missing row stays a failure, which is the point.
   */
  const ownedPairs = new Map();
  function own(roomTypeId, dates) {
    const set = ownedPairs.get(roomTypeId) ?? new Set();
    for (const date of dates) set.add(date);
    ownedPairs.set(roomTypeId, set);
  }

  /* ===================================================================== A1 */
  console.log('A1. Creation racing cancellation for the same last unit.');
  console.log('    Queue order is staged, so each ordering is deterministic.\n');

  const a1Rounds = 3;

  for (const ordering of ['creation first', 'cancellation first']) {
    console.log(`  — ${ordering} —`);
    for (let round = 1; round <= a1Rounds; round += 1) {
      const { arrival, departure, dates } = nextWindow();
      own(fixture.categoryA, dates);

      // One unit, already sold to `stay`: a creation can only succeed if the
      // cancellation got there first and gave it back.
      await ensureInventory(fixture.categoryA, dates, 1);
      const stay = await book(cookie, fixture.categoryA, arrival, departure, {
        roomId: fixture.rooms.a1.id,
      });

      const moneyBefore = await folioFingerprint(stay.id);
      const label = `A1 ${ordering} round ${String(round)}`;

      const cancel = opCancel(stay.id, 'race A1');
      const create = opCreate(fixture.categoryA, arrival, departure, 'Creator');
      const creationFirst = ordering === 'creation first';

      const { settled, parked, parkedSeen } = await raceUnderLock({
        roomTypeIds: [fixture.categoryA],
        dates,
        expectParked: 2,
        staged: true,
        operations: creationFirst ? [create, cancel] : [cancel, create],
      });

      const created = creationFirst ? settled[0] : settled[1];
      const cancelled = creationFirst ? settled[1] : settled[0];
      if (created.status === 201) createdReservations.add(created.payload.id);

      console.log(
        `    round ${String(round)}: cancel ${String(cancelled.status)}, create ${String(
          created.status,
        )} ${created.payload?.code ?? ''} (${parked ? 'queue staged' : `NOT STAGED, peak +${String(parkedSeen)}`})`,
      );

      check(
        `${label}: both operations were queued in the intended order`,
        parked,
        `peak +${String(parkedSeen)}`,
      );
      assertTyped(`${label}: cancellation answered typed`, cancelled, [200, 409]);
      assertTyped(`${label}: creation answered typed`, created, [201, 409, 422]);

      if (parked) {
        if (creationFirst) {
          /**
           * The creation holds the inventory lock while the cancellation is
           * still queued behind it, so it must see the category full. A 201
           * here would mean it sold a unit that was still held — the oversell
           * this suite exists to rule out.
           */
          check(
            `${label}: the creation is refused because the unit is still held`,
            created.status === 409,
            `HTTP ${String(created.status)} ${created.payload?.code ?? ''}`,
          );
          check(
            `${label}: the cancellation behind it still succeeds`,
            cancelled.status === 200,
            `HTTP ${String(cancelled.status)}`,
          );
        } else {
          /**
           * The cancellation commits first and the unit is genuinely free by
           * the time the creation gets the lock, so it must succeed. A 409
           * here would mean the creation read a counter the cancellation had
           * already decremented — a stale read under the lock.
           */
          check(
            `${label}: the cancellation releases the unit`,
            cancelled.status === 200,
            `HTTP ${String(cancelled.status)}`,
          );
          check(
            `${label}: the creation behind it takes the freed unit`,
            created.status === 201,
            `HTTP ${String(created.status)} ${created.payload?.code ?? ''}`,
          );
        }
      }

      await assertCounters(label, [fixture.categoryA], dates);

      const violations = await constraintViolations();
      check(
        `${label}: no inventory row violates the oversell invariant`,
        violations === 0,
        `${String(violations)} bad row(s)`,
      );

      const moneyAfter = await folioFingerprint(stay.id);
      check(
        `${label}: the cancelled stay's money was not touched`,
        moneyAfter.lines === moneyBefore.lines && moneyAfter.total === moneyBefore.total,
        `${String(moneyBefore.lines)} line(s), total ${moneyBefore.total}`,
      );

      // Exactly one audit row: a retry that re-ran the transaction body rather
      // than the whole attempt would leave two.
      const auditAfter = await auditCount(stay.id);
      check(
        `${label}: exactly one audit row for the cancellation`,
        auditAfter === (cancelled.status === 200 ? 1 : 0),
        `${String(auditAfter)} row(s)`,
      );

      const finalStay = await prisma.reservation.findUnique({
        where: { id: stay.id },
        select: { status: true },
      });
      check(
        `${label}: the cancelled stay is CANCELLED`,
        finalStay.status === 'CANCELLED',
        finalStay.status,
      );
    }
    console.log('');
  }

  /* ===================================================================== A2 */
  console.log('A2. A creation whose pre-flight availability is invalidated under the lock.');
  console.log('    The competing sale is applied from inside the gate, so this is exact.\n');

  for (let round = 1; round <= 3; round += 1) {
    const { arrival, departure, dates } = nextWindow();
    own(fixture.categoryA, dates);

    // Free at pre-flight: the creation's availability read sees room, which is
    // precisely the stale answer it must re-check under the lock.
    await ensureInventory(fixture.categoryA, dates, 1);
    const label = `A2 round ${String(round)}`;

    const { settled, parked, parkedSeen } = await raceUnderLock({
      roomTypeIds: [fixture.categoryA],
      dates,
      expectParked: 1,
      staged: true,
      operations: [opCreate(fixture.categoryA, arrival, departure, 'Stale')],
      /**
       * The category fills while the creation is parked.
       *
       * Written through the gate's own transaction, which already holds these
       * rows, because the alternative — a second real endpoint — would park on
       * the same lock and could not commit inside the window. The subject under
       * test is still the real creation endpoint; only the competitor is
       * simulated, and the report says so rather than glossing it.
       */
      mutate: async (tx) => {
        await tx.$executeRaw`
          UPDATE inventory_day SET sold = physical
          WHERE "propertyId" = ${fixture.propertyId}::uuid
            AND "roomTypeId" = ${fixture.categoryA}::uuid
            AND "stayDate" = ANY(${dates.map((d) => new Date(`${d}T00:00:00.000Z`))}::date[])`;
      },
    });

    const [created] = settled;
    if (created.status === 201) createdReservations.add(created.payload.id);

    console.log(
      `  round ${String(round)}: create ${String(created.status)} ${created.payload?.code ?? ''} (${
        parked ? 'parked' : `NOT PARKED, peak +${String(parkedSeen)}`
      })`,
    );

    check(
      `${label}: the creation parked on the inventory lock`,
      parked,
      `peak +${String(parkedSeen)}`,
    );
    assertTyped(`${label}: the stale creation is refused, typed`, created, [409, 422]);
    check(
      `${label}: it re-read under the lock instead of trusting its pre-flight`,
      created.status !== 201,
      created.status === 201 ? 'A CREATION SUCCEEDED AGAINST A FULL CATEGORY' : 'refused',
    );

    const days = await soldByDate(fixture.categoryA, dates);
    const oversold = dates.filter((d) => days.get(d).sold > days.get(d).physical);
    check(
      `${label}: no night exceeds its physical count`,
      oversold.length === 0,
      oversold.length === 0
        ? `sold == physical == 1 on ${String(dates.length)} night(s)`
        : oversold.join(', '),
    );

    const violations = await constraintViolations();
    check(
      `${label}: no inventory row violates the oversell invariant`,
      violations === 0,
      `${String(violations)} bad row(s)`,
    );

    // Put the simulated sale back, so the final sweep compares like with like.
    await prisma.$executeRaw`
      UPDATE inventory_day SET sold = 0
      WHERE "propertyId" = ${fixture.propertyId}::uuid
        AND "roomTypeId" = ${fixture.categoryA}::uuid
        AND "stayDate" = ANY(${dates.map((d) => new Date(`${d}T00:00:00.000Z`))}::date[])
        AND sold > 0`;
  }

  /* ====================================================================== B */
  console.log('\nB. Creation racing a cross-category room move into that category.');
  console.log('   B holds one unit; the move and the creation both want it.\n');

  const bRounds = 3;

  for (const ordering of ['creation first', 'move first']) {
    console.log(`  — ${ordering} —`);
    for (let round = 1; round <= bRounds; round += 1) {
      const { arrival, departure, dates } = nextWindow();
      own(fixture.categoryA, dates);
      own(fixture.categoryB, dates);

      await ensureInventory(fixture.categoryA, dates, 2);
      await ensureInventory(fixture.categoryB, dates, 1);

      const stay = await book(cookie, fixture.categoryA, arrival, departure, {
        roomId: fixture.rooms.a1.id,
      });
      const moneyBefore = await folioFingerprint(stay.id);
      const label = `B ${ordering} round ${String(round)}`;

      const move = opMove(stay.id, fixture.rooms.b1.id, 'race B');
      const create = opCreate(fixture.categoryB, arrival, departure, 'IntoB');
      const creationFirst = ordering === 'creation first';

      /**
       * The gate holds only B's rows, and that is what makes the ordering
       * selectable at all.
       *
       * With A held too, the move blocks on A's first row and never reaches
       * B — so it cannot be ahead of a B-only creation in B's queue, whatever
       * order they were fired in. Holding B alone lets the move take A
       * uncontended and then queue on B, where staging decides who is first.
       */
      const { settled, parked, parkedSeen } = await raceUnderLock({
        roomTypeIds: [fixture.categoryB],
        dates,
        expectParked: 2,
        staged: true,
        operations: creationFirst ? [create, move] : [move, create],
      });

      const created = creationFirst ? settled[0] : settled[1];
      const moved = creationFirst ? settled[1] : settled[0];
      if (created.status === 201) createdReservations.add(created.payload.id);

      console.log(
        `    round ${String(round)}: move ${String(moved.status)} ${
          moved.payload?.code ?? ''
        }, create ${String(created.status)} ${created.payload?.code ?? ''} (${
          parked ? 'queue staged' : `NOT STAGED, peak +${String(parkedSeen)}`
        })`,
      );

      check(
        `${label}: both operations were queued in the intended order`,
        parked,
        `peak +${String(parkedSeen)}`,
      );
      // A successful move answers 201, like every other POST here.
      assertTyped(`${label}: the move answered typed`, moved, [200, 201, 400, 409]);
      assertTyped(`${label}: the creation answered typed`, created, [201, 409, 422]);

      if (parked) {
        if (creationFirst) {
          check(
            `${label}: the creation takes B's only unit`,
            created.status === 201,
            `HTTP ${String(created.status)} ${created.payload?.code ?? ''}`,
          );
          /**
           * The move is refused because B is genuinely full, and the message
           * has to say that rather than "that room was taken": the room is
           * free, the category is not. This is the distinction room-move's
           * exhaustion branch draws between `23514` and a transient conflict.
           */
          check(
            `${label}: the move behind it is refused because the category is full`,
            moved.status === 409 || moved.status === 400,
            `HTTP ${String(moved.status)} ${moved.payload?.code ?? ''}`,
          );
          const reason = JSON.stringify(moved.payload?.details ?? moved.payload?.message ?? '');
          check(
            `${label}: the refusal blames the category, not the room`,
            /fully sold/i.test(reason),
            reason.slice(0, 140),
          );
        } else {
          check(
            `${label}: the move takes B's only unit`,
            moved.status === 201 || moved.status === 200,
            `HTTP ${String(moved.status)} ${moved.payload?.code ?? ''}`,
          );
          check(
            `${label}: the creation behind it is refused`,
            created.status === 409,
            `HTTP ${String(created.status)} ${created.payload?.code ?? ''}`,
          );
        }
      }

      // Per category, per night, against the live room rows. Aggregate totals
      // matched while both categories were wrong when Defect 2 was found, so
      // this is the assertion that has actually caught something.
      await assertCounters(label, [fixture.categoryA, fixture.categoryB], dates);

      const violations = await constraintViolations();
      check(
        `${label}: no inventory row violates the oversell invariant`,
        violations === 0,
        `${String(violations)} bad row(s)`,
      );

      // Whichever way it went, the room row's category and the physical room's
      // category must agree — the incoherence the check-in race produced.
      const assignment = await prisma.$queryRaw`
        SELECT rr."roomTypeId"::text AS room_type_id, rr."roomId"::text AS room_id,
               rm."roomTypeId"::text AS room_category
        FROM reservation_room rr
        LEFT JOIN room rm ON rm."id" = rr."roomId"
        WHERE rr."reservationId" = ${stay.id}::uuid`;
      const row = assignment[0];
      check(
        `${label}: the assigned room's category matches its room row`,
        row !== undefined && (row.room_id === null || row.room_category === row.room_type_id),
        row === undefined
          ? 'no room row'
          : `row says ${fixture.names.get(row.room_type_id) ?? '?'}, room is in ${
              fixture.names.get(row.room_category) ?? 'none'
            }`,
      );

      check(
        `${label}: the moved stay's money was not touched`,
        (await folioFingerprint(stay.id)).total === moneyBefore.total,
        `total ${moneyBefore.total}`,
      );
    }
    console.log('');
  }

  /* ====================================================================== C */
  console.log('C. Three-way: a cancellation, a cross-category move and a creation.');
  console.log('   All three staged onto the same rows, so the whole sequence is exact.\n');

  const cRounds = 2;

  for (const ordering of ['cancel, move, create', 'create, move, cancel']) {
    console.log(`  — ${ordering} —`);
    for (let round = 1; round <= cRounds; round += 1) {
      const { arrival, departure, dates } = nextWindow();
      own(fixture.categoryA, dates);
      own(fixture.categoryB, dates);

      // A holds two stays, B one unit: the cancellation frees an A unit while
      // the move tries to leave A for B and a creation tries to take B.
      await ensureInventory(fixture.categoryA, dates, 2);
      await ensureInventory(fixture.categoryB, dates, 1);

      const toCancel = await book(cookie, fixture.categoryA, arrival, departure, {
        roomId: fixture.rooms.a1.id,
      });
      const toMove = await book(cookie, fixture.categoryA, arrival, departure, {
        roomId: fixture.rooms.a2.id,
      });

      const label = `C [${ordering}] round ${String(round)}`;
      const cancel = opCancel(toCancel.id, 'race C');
      const move = opMove(toMove.id, fixture.rooms.b1.id, 'race C');
      const create = opCreate(fixture.categoryB, arrival, departure, 'ThreeWay');
      const cancelFirst = ordering === 'cancel, move, create';

      const { settled, parked, parkedSeen } = await raceUnderLock({
        roomTypeIds: [fixture.categoryA, fixture.categoryB],
        dates,
        expectParked: 3,
        staged: true,
        operations: cancelFirst ? [cancel, move, create] : [create, move, cancel],
      });

      const cancelled = cancelFirst ? settled[0] : settled[2];
      const moved = settled[1];
      const created = cancelFirst ? settled[2] : settled[0];
      if (created.status === 201) createdReservations.add(created.payload.id);

      console.log(
        `    round ${String(round)}: cancel ${String(cancelled.status)}, move ${String(
          moved.status,
        )}, create ${String(created.status)} (${
          parked ? 'queue staged' : `only +${String(parkedSeen)} of 3 parked`
        })`,
      );

      check(
        `${label}: all three were queued in the intended order`,
        parked,
        `peak +${String(parkedSeen)} of 3`,
      );
      assertTyped(`${label}: cancellation answered typed`, cancelled, [200, 409]);
      assertTyped(`${label}: the move answered typed`, moved, [200, 201, 400, 409]);
      assertTyped(`${label}: the creation answered typed`, created, [201, 409, 422]);

      if (parked) {
        /**
         * One winner for B, and no claim about which.
         *
         * The cancellation only ever frees a category-A unit and nothing else
         * in this round competes for A, so it succeeds in both orderings. The
         * move and the creation both want B's single unit, and exactly one of
         * them may have it — that is the invariant, and it is asserted.
         *
         * Which one wins is deliberately NOT asserted. It is decided by the
         * order the two reach B's row, and that depends on how far each
         * transaction gets before asking for it: the creation needs B alone,
         * while the move must take A first because inventory is always locked
         * `ORDER BY "stayDate", "roomTypeId"` (CLAUDE.md section 3.1), so it
         * cannot even queue for B until A is granted. Both outcomes were
         * observed here while developing this suite — the creation wins when
         * everything is fired at once, the move wins when the queue is staged —
         * and an assertion fixing either one would be encoding an artefact of
         * the harness rather than a property of the system. Pinning it down
         * properly needs the per-row lock-queue inspection noted in the
         * report's gaps, so the honest assertion is the exclusive one below.
         */
        check(
          `${label}: the cancellation succeeds`,
          cancelled.status === 200,
          `HTTP ${String(cancelled.status)}`,
        );

        const moveWon = moved.status === 201 || moved.status === 200;
        const createWon = created.status === 201;
        check(
          `${label}: exactly one of the move and the creation took B's only unit`,
          moveWon !== createWon,
          `move ${moveWon ? 'won' : 'refused'}, creation ${createWon ? 'won' : 'refused'}`,
        );

        // Whoever lost must have been told the category is full, not that a
        // room was taken: the room was free, the category was not.
        if (!moveWon) {
          const reason = JSON.stringify(moved.payload?.details ?? moved.payload?.message ?? '');
          check(
            `${label}: the move's refusal blames the category, not the room`,
            /fully sold/i.test(reason),
            reason.slice(0, 140),
          );
        }
      }

      await assertCounters(label, [fixture.categoryA, fixture.categoryB], dates);

      const violations = await constraintViolations();
      check(
        `${label}: no inventory row violates the oversell invariant`,
        violations === 0,
        `${String(violations)} bad row(s)`,
      );

      const cancelledStay = await prisma.reservation.findUnique({
        where: { id: toCancel.id },
        select: { status: true, cancelledAt: true },
      });
      check(
        `${label}: the cancelled stay is CANCELLED with a timestamp`,
        cancelledStay.status === 'CANCELLED' && cancelledStay.cancelledAt !== null,
        `${cancelledStay.status}, cancelledAt ${cancelledStay.cancelledAt === null ? 'null' : 'set'}`,
      );

      check(
        `${label}: the cancellation wrote exactly one audit row`,
        (await auditCount(toCancel.id)) === 1,
        `${String(await auditCount(toCancel.id))} row(s)`,
      );
    }
    console.log('');
  }

  /* ================================================================== final */
  console.log('Final sweep across every night this suite gave inventory to.');
  for (const [roomTypeId, dates] of ownedPairs) {
    await assertCounters(
      `final (category ${fixture.names.get(roomTypeId) ?? '?'})`,
      [roomTypeId],
      [...dates],
    );
  }
  const finalViolations = await constraintViolations();
  check(
    'final: the property has no violating inventory row at all',
    finalViolations === 0,
    `${String(finalViolations)} bad row(s)`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Teardown                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Remove the fixture property and everything under it.
 *
 * Runs whether the suite passed, failed an assertion, or threw — and reports
 * its own failure loudly rather than swallowing it, because a silent cleanup
 * failure in a race suite leaves inventory rows that make the *next* run lie.
 */
async function teardown() {
  if (fixture === null) {
    console.log('\nTeardown: nothing to remove (no fixture was created).');
    return true;
  }

  console.log(
    `\nTeardown: removing ${fixture.propertyCode} and ${String(createdReservations.size)} reservation(s).`,
  );
  try {
    await dropProperty(fixture.propertyId, fixture.actor.id);
  } catch (error) {
    console.error(`  CLEANUP FAILED — ${String(error.message ?? error)}`);
    console.error(
      `  The fixture property ${fixture.propertyCode} (${fixture.propertyId}) is STILL PRESENT.`,
    );
    console.error(`  Remove it with: DELETE FROM property WHERE code = '${fixture.propertyCode}';`);
    console.error(
      `  (stays → rooms → room types → property; ReservationRoom.roomType is Restrict.)`,
    );
    return false;
  }

  const left = await prisma.property.count({ where: { id: fixture.propertyId } });
  if (left !== 0) {
    console.error(`  CLEANUP INCOMPLETE — property ${fixture.propertyCode} still present.`);
    return false;
  }
  console.log('  removed cleanly.');
  return true;
}

/* -------------------------------------------------------------------------- */

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
  failures += 1;
  console.error(`\nFATAL  ${String(error.message ?? error)}`);
  if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
}

const cleaned = await teardown();
if (!cleaned) failures += 1;

await prisma.$disconnect();

if (failures === 0) {
  console.log('\nAll creation-race checks passed.');
} else {
  console.log(`\n${String(failures)} check(s) failed.`);
}
process.exit(failures === 0 ? 0 : 1);
