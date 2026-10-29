/**
 * The parallel-booking race suite.
 *
 * ===========================================================================
 * CLAUDE.md section 3.1: "Every reservation write path has an integration test
 * that fires N parallel requests against the last available room and asserts
 * exactly one succeeds. Deleting or weakening these tests is not permitted."
 *
 * This runs against a **real Postgres with the real constraints**, through the
 * real HTTP endpoint. That is deliberate and section 5 says why: in-memory
 * fakes cannot prove constraint behaviour, and constraint behaviour is where
 * the correctness of this system actually lives. A mock would pass while the
 * CHECK was missing.
 *
 * Two races are exercised, because two different constraints guard them:
 *
 *   1. **Room-type oversell** — N bookings for the last sellable room of a
 *      type on one date. `inventory_day_not_oversold` is what must hold.
 *   2. **Same-room double booking** — N bookings for one physical room over
 *      overlapping dates. `reservation_room_no_overlap` is what must hold.
 *
 * The test sets inventory up so exactly one sale can succeed, fires the
 * requests simultaneously, and asserts exactly one 201. It then re-reads the
 * counters to prove the database is not oversold — because "one request
 * succeeded" and "the books are correct" are different claims, and only the
 * second one matters.
 *
 * Everything it creates is removed in teardown, including on failure.
 * ===========================================================================
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
/**
 * The repo's own factory, not `new PrismaClient()`: Prisma 7 requires a driver
 * adapter, and the factory is where the adapter, pooling and the tenancy
 * extension are configured. Bypassing it would exercise a different client
 * than the API uses, which is the one thing an integration test must not do.
 *
 * Imported dynamically because the factory reads `DATABASE_URL` at call time
 * and a static import is hoisted above the line that sets it — so the env has
 * to be in place first.
 */
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
  console.error('DATABASE_URL is not set and no .env was found. Run pnpm db:seed first.');
  process.exit(1);
}

// Resolved by path rather than by package name: this script runs from the
// repo root, which does not depend on the workspace package, and adding a
// root dependency just to reach it would be a heavier change than a path.
const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;

const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4000/api/v1';
const PARALLEL = Number(process.env.EASEIT_PARALLEL ?? 8);
const PROPERTY_CODE = process.env.EASEIT_PROPERTY ?? '31336';

const prisma = createPrismaClient();

/**
 * The isolation guard, shared with every other destructive suite.
 *
 * Imported here rather than relied upon from the release gate: this file is
 * reachable directly through its own npm script, and run that way the gate's
 * preflight never executes. See `test/support/isolation-guard.mjs`.
 */
const { assertIsolatedDatabase, assertApiSharesDatabase } = await import('../support/isolation-guard.mjs');
const created = [];
let failures = 0;

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Mints a session the same way `TokenService` signs one. */
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
    exp: now + 900,
  })}`;

  return `${input}.${createHmac('sha256', secret).update(input, 'utf8').digest('base64url')}`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

/* -------------------------------------------------------------------------- */
/*  Scenario 1 — the last room of a type                                      */
/* -------------------------------------------------------------------------- */

async function raceForLastRoomOfType(cookie, property, roomType, arrival, departure) {
  console.log(`\nScenario 1: ${PARALLEL} parallel bookings for the LAST ${roomType.name}`);
  console.log(`  stay ${arrival} -> ${departure}`);

  // Force exactly one sellable room on the stay date. This is the setup the
  // section 3.1 test describes: the race only proves anything when there is
  // precisely one unit to fight over.
  await prisma.inventoryDay.update({
    where: {
      inventory_day_unique_per_date: {
        propertyId: property.id,
        roomTypeId: roomType.id,
        stayDate: utcMidnight(arrival),
      },
    },
    data: { sold: 0, blocked: 0, physical: 1, overbookingAllowance: 0 },
  });

  const body = (n) => ({
    roomTypeId: roomType.id,
    roomId: null,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 1,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Race', lastName: `Contender${n}` }],
    isInstantCheckIn: false,
  });

  // Fired together rather than awaited in sequence — a sequential loop would
  // pass against a completely unguarded endpoint.
  const responses = await Promise.all(
    Array.from({ length: PARALLEL }, (_, n) =>
      fetch(`${API}/properties/${PROPERTY_CODE}/reservations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body(n)),
      }).then(async (response) => ({
        status: response.status,
        payload: await response.json().catch(() => ({})),
      })),
    ),
  );

  const won = responses.filter((r) => r.status === 201);
  const refused = responses.filter((r) => r.payload?.code === 'ROOM_UNAVAILABLE');
  const other = responses.filter(
    (r) => r.status !== 201 && r.payload?.code !== 'ROOM_UNAVAILABLE',
  );

  for (const winner of won) created.push(winner.payload.id);

  check('exactly one booking succeeded', won.length === 1, `${won.length} succeeded`);
  check(
    'every loser was refused as ROOM_UNAVAILABLE',
    refused.length === PARALLEL - 1,
    `${refused.length} of ${PARALLEL - 1}; other codes: ${JSON.stringify(
      other.map((r) => r.payload?.code ?? r.status),
    )}`,
  );

  const after = await prisma.inventoryDay.findUnique({
    where: {
      inventory_day_unique_per_date: {
        propertyId: property.id,
        roomTypeId: roomType.id,
        stayDate: utcMidnight(arrival),
      },
    },
    select: { sold: true, blocked: true, physical: true, overbookingAllowance: true },
  });

  // The claim that actually matters: the books are not oversold.
  check(
    'inventory counter is exactly 1, not oversold',
    after.sold === 1,
    `sold=${after.sold}`,
  );
  check(
    'oversell CHECK invariant holds',
    after.sold + after.blocked <= after.physical + after.overbookingAllowance,
    JSON.stringify(after),
  );
}

/* -------------------------------------------------------------------------- */
/*  Scenario 2 — the same physical room                                       */
/* -------------------------------------------------------------------------- */

async function raceForSameRoom(cookie, property, roomType, room, arrival, departure) {
  console.log(`\nScenario 2: ${PARALLEL} parallel bookings for room ${room.number}`);

  // Plenty of room-type inventory, so the ONLY thing that can stop a double
  // booking here is the exclusion constraint on the physical room.
  await prisma.inventoryDay.update({
    where: {
      inventory_day_unique_per_date: {
        propertyId: property.id,
        roomTypeId: roomType.id,
        stayDate: utcMidnight(arrival),
      },
    },
    data: { sold: 0, blocked: 0, physical: 50, overbookingAllowance: 0 },
  });

  const responses = await Promise.all(
    Array.from({ length: PARALLEL }, (_, n) =>
      fetch(`${API}/properties/${PROPERTY_CODE}/reservations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          roomTypeId: roomType.id,
          roomId: room.id,
          arrivalDate: arrival,
          departureDate: departure,
          adults: 1,
          mealPlan: 'EP',
          source: 'WALK_IN',
          guests: [{ firstName: 'Overlap', lastName: `Contender${n}` }],
          isInstantCheckIn: false,
        }),
      }).then(async (response) => ({
        status: response.status,
        payload: await response.json().catch(() => ({})),
      })),
    ),
  );

  const won = responses.filter((r) => r.status === 201);
  for (const winner of won) created.push(winner.payload.id);

  check(
    'exactly one booking took the room',
    won.length === 1,
    `${won.length} succeeded: ${JSON.stringify(responses.map((r) => r.status))}`,
  );

  const overlapping = await prisma.reservationRoom.count({
    where: {
      roomId: room.id,
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      arrivalDate: { lt: utcMidnight(departure) },
      departureDate: { gt: utcMidnight(arrival) },
    },
  });

  check(
    'exactly one assignment holds that room over those nights',
    overlapping === 1,
    `${overlapping} rows overlap`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Run                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  // Before any fixture is created, mutated or deleted.
  await assertIsolatedDatabase({ prisma, suite: 'the parallel-booking stress suite' });

  const property = await prisma.property.findFirst({
    where: { code: PROPERTY_CODE },
    select: { id: true, code: true, name: true, businessDate: true },
  });
  if (!property) throw new Error(`Property ${PROPERTY_CODE} not found. Run pnpm db:seed.`);

  const grant = await prisma.userPropertyRole.findFirst({
    where: { propertyId: property.id },
    select: { user: { select: { id: true, email: true } } },
  });
  if (!grant) throw new Error('No user holds a grant at that property.');

  const roomType = await prisma.roomType.findFirst({
    where: { propertyId: property.id },
    select: { id: true, name: true },
    orderBy: { sortOrder: 'asc' },
  });
  const room = await prisma.room.findFirst({
    where: { propertyId: property.id, roomTypeId: roomType.id, status: { not: 'OUT_OF_ORDER' } },
    select: { id: true, number: true },
  });

  const cookie = `easeit_session=${mintSession(grant.user.id, grant.user.email)}`;

  /**
   * Prove the API reached the same database before anything is written.
   *
   * Without this the suite could assert against the isolated database while
   * the endpoints quietly wrote to development -- every counter check passing
   * for the wrong reason. The probe is a reservation id read from THIS
   * database; seeded ids are random uuids, so an API on any other database
   * answers 404 for it. Read-only, and it runs before the first fixture.
   */
  {
    const probeRow = await prisma.reservation.findFirst({
      where: { propertyId: grant.property.id },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    await assertApiSharesDatabase({
      suite: 'the parallel-booking stress suite',
      api: API,
      probe: async () => {
        if (probeRow === null) {
          return { ok: false, detail: 'no seeded reservation to probe with' };
        }
        // Raw `fetch`: this suite has no `call()` helper, unlike the
        // integration suites.
        const probe = await fetch(
          `${API}/properties/${PROPERTY_CODE}/reservations/${probeRow.id}`,
          { headers: { cookie } },
        );
        return probe.status === 200
          ? { ok: true, detail: 'probe reservation visible' }
          : { ok: false, detail: `probe reservation returned HTTP ${String(probe.status)}` };
      },
    });
  }


  // Far enough out that no seeded booking already occupies the room, but
  // still inside the seeded inventory window.
  const base = new Date(property.businessDate.getTime() + 50 * 86_400_000);
  const arrival = isoDate(base);
  const departure = isoDate(new Date(base.getTime() + 86_400_000));

  console.log(`Property ${property.code} (${property.name}), room type "${roomType.name}"`);

  await raceForLastRoomOfType(cookie, property, roomType, arrival, departure);
  await raceForSameRoom(cookie, property, roomType, room, arrival, departure);
}

async function teardown() {
  // Reservations first: reservation_room cascades from them.
  if (created.length > 0) {
    await prisma.reservation.deleteMany({ where: { id: { in: created } } });
  }
  // Anything the race created that we failed to capture an id for.
  await prisma.reservation.deleteMany({
    where: { guestLastName: { startsWith: 'Contender' } },
  });
  console.log(`\nTeardown: removed ${created.length} reservation(s) created by this run.`);
  console.log('Note: inventory counters for the test date were rewritten; run pnpm db:seed to restore them.');
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error('\nSuite error:', error.message);
} finally {
  await teardown().catch((error) => {
    console.error('Teardown failed:', error.message);
  });
  await prisma.$disconnect();
}

console.log(failures === 0 ? '\nAll concurrency checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
