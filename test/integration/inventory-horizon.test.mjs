/**
 * Integration tests for the inventory horizon — generation, idempotency,
 * gap-filling, atomicity, authorization and the audit trail.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS.
 *
 * `inventory_day` decides what can be sold: `create-reservation` locks one row
 * per night and refuses when the count comes back short, so a night with no
 * row is unsellable however many rooms stand empty. Day 2 added the first
 * runtime writer that *inserts* those rows, and every claim about it that
 * matters is a claim about the database:
 *
 *   * that `ON CONFLICT DO NOTHING` is idempotent against the live unique
 *     index, not merely against my reading of the schema;
 *   * that `physical` matches the room table;
 *   * that a failure in a *later* 180-day chunk rolls the whole extension
 *     back, which is the one structural claim that otherwise rests on the
 *     argument "it is all one `$transaction`";
 *   * that an existing row's `sold`, `blocked` and `physical` survive
 *     untouched, because a decrement that runs against a rewritten counter is
 *     how a room gets sold twice;
 *   * that a missing night is reported as a missing night and not as
 *     "no rooms available", which sent a clerk hunting for dates.
 *
 * FIXTURE OWNERSHIP IS THE SAFETY MODEL.
 * This suite creates its own property, its own user, its own categories and
 * its own rooms, all prefixed `ZZINVH`, and removes them again. It never reads
 * or writes a seeded hotel. Every destructive statement carries the
 * suite-created `propertyId`; the one that deletes an inventory row carries
 * `propertyId` AND `roomTypeId` AND one exact `stayDate`. The prefix is
 * deliberately different from `ZZRACE` so this suite and the creation-race
 * suite can never sweep each other's leftovers.
 *
 * It refuses to start unless `assertIsolatedDatabase` confirms a disposable
 * database and `assertApiSharesDatabase` confirms the API is talking to that
 * same one — otherwise a passing run would prove nothing about the stack under
 * test.
 * ===========================================================================
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The test database is **required**, and never inferred.
 *
 * No default and no `.env` lookup: this suite creates a property, generates
 * tens of thousands of inventory rows and installs a trigger, so it will not
 * guess a target. Run it through `pnpm gate:integration`, or set it explicitly
 * to a disposable test database.
 */
if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set.\n' +
      'There is no default and no .env lookup: this suite creates a property and\n' +
      'generates inventory, so it will not guess a target. Run it through\n' +
      '`pnpm gate:integration`, or set it explicitly to a disposable test database.',
  );
  process.exit(1);
}

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;

if (!process.env.EASEIT_API_URL) {
  console.error(
    'EASEIT_API_URL is not set.\n' +
      'There is no default: :4000 is the shared development API, and assuming a\n' +
      'port is assuming which stack receives the inventory this suite generates.\n' +
      'Point it at an API running against the SAME isolated database.',
  );
  process.exit(1);
}
const API = process.env.EASEIT_API_URL;

/** Extra database names this run may use, beyond the shared built-in list. */
const EXTRA_ALLOWED = [process.env.EASEIT_TEST_DB, process.env.EASEIT_TEST_DBS]
  .filter(Boolean)
  .join(',');

/**
 * Constants for the rollback blocker (test 11).
 *
 * `BLOCKER_ROLLBACK` is matched by substring to tell the deliberate rollback
 * apart from a real failure, so a genuine error is never swallowed as "expected".
 * `READY_TIMEOUT_MS` bounds the wait for the blocker to hold its key: a cold
 * `createPrismaClient()` has to open a connection first, and a fixed sleep would
 * either be too short on a slow machine or waste time on a fast one.
 */
const BLOCKER_ROLLBACK = 'ZZINVH blocker: deliberate rollback';
const READY_TIMEOUT_MS = 15_000;
/** Bound on waiting for the blocker transaction to settle after release. */
const HELD_TIMEOUT_MS = 15_000;
/** Bound on the blocker's connection close during cleanup. */
const DISCONNECT_TIMEOUT_MS = 10_000;

/**
 * The service's own stated transaction budget, imported rather than guessed.
 *
 * Test 11 waits for this deadline to expire, so a literal here would stop
 * matching the moment the service changed its mind, and the test would fail
 * for a reason that has nothing to do with rollback.
 *
 * Declared HERE, above the constants below, because `ROLLBACK_ELAPSED_FLOOR_MS`
 * is derived from it. It used to sit further down the file, which put the
 * derivation in `const`'s temporal dead zone: module evaluation threw
 * "Cannot access 'TRANSACTION_TIMEOUT_MS' before initialization" before a
 * single test ran. `node --check` cannot catch that -- the code is
 * syntactically valid -- so the ordering is load-bearing, not cosmetic.
 */
const { TRANSACTION_TIMEOUT_MS } =
  await import('../../apps/api/src/modules/inventory/inventory-horizon.policy.ts');

/**
 * Test 11's client-side request budget, and the floor its elapsed time must clear.
 *
 * ===========================================================================
 * `ROLLBACK_REQUEST_TIMEOUT_MS` must stay comfortably LONGER than the
 * service's own transaction deadline. The server is supposed to abort at
 * `TRANSACTION_TIMEOUT_MS` and then still has to roll back, map the error and
 * write a response; a client budget at or near 20 s would race that and turn a
 * correct server abort into a client-side timeout, which proves nothing.
 * 35 s leaves 15 s of margin.
 *
 * `ROLLBACK_ELAPSED_FLOOR_MS` is 80% of the service deadline. It is the
 * assertion that closes a false positive: an immediate 5xx -- pool
 * acquisition failure, a crashed worker, a startup error -- returns in
 * milliseconds and produces exactly the same observable signature as a real
 * rollback (5xx, nothing in the band, retry succeeds), because in that case
 * chunk 1 never ran and "no rows survived" is vacuously true. Only a request
 * that actually sat on the conflicting key can take ~20 s.
 *
 * 80% rather than 100% because the measured wall-clock includes connection
 * setup and response delivery but the deadline is measured by Prisma from a
 * slightly later instant; a strict `>= 20000` would be flaky at the boundary.
 * ===========================================================================
 */
const ROLLBACK_REQUEST_TIMEOUT_MS = 35_000;
const ROLLBACK_ELAPSED_FLOOR_MS = Math.floor(TRANSACTION_TIMEOUT_MS * 0.8);

/** Set when the blocker fails for a real reason, so test 11 can say so. */
let blockerFault = null;

/** Everything this suite owns starts here, so a crashed run is sweepable. */
const FIXTURE_PREFIX = 'ZZINVH';

const { assertIsolatedDatabase, apiMismatchMessage } =
  await import('../support/isolation-guard.mjs');

const prisma = createPrismaClient();

let failures = 0;
/** Set once the suite owns a property, so teardown knows what to remove. */
let fixture = null;

/**
 * What this process has created, recorded BEFORE each resource exists.
 *
 * ===========================================================================
 * `fixture` used to be assigned only after every create had succeeded, and
 * teardown began `if (fixture === null) return`. A throw partway through setup
 * therefore left a property, two users, two grants, two categories and up to
 * four rooms behind, and teardown cleaned nothing while reporting nothing. The
 * next run's prefix sweep recovered it, so it self-healed — but a suite that
 * silently leaks on the one path where failure is most likely is not a suite
 * you can trust about anything else.
 *
 * So ownership is now recorded as it is acquired, not after. `propertyId` is
 * written the instant the property row exists, and teardown drives off THIS
 * object rather than off `fixture`. Everything in it was created by this
 * process in this run; nothing is ever discovered by lookup, so a seeded
 * property can never enter it.
 * ===========================================================================
 */
const owned = {
  /** The suite's property. Set immediately after `property.create`. */
  propertyId: null,
  /** Its code, kept for the prefix assertion in teardown. */
  propertyCode: null,
  /** Every user this process created, in creation order. */
  userIds: [],
  /** Every room type, so an inventory cleanup can name each one. */
  roomTypeIds: [],
};

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

function note(text) {
  console.log(`  NOTE  ${text}`);
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

/** The suite's own horizon path. A function because `fixture` is late-bound. */
const HORIZON_PATH = () => `/properties/${fixture.propertyCode}/inventory/horizon`;

const isoDate = (date) => date.toISOString().slice(0, 10);
const utcMidnight = (iso) => new Date(`${iso}T00:00:00.000Z`);

function shiftDays(iso, days) {
  return isoDate(new Date(utcMidnight(iso).getTime() + days * 86_400_000));
}

/**
 * The suite's notion of today: the **current UTC calendar date**.
 *
 * The same rule the service uses (`todayUtc()`), so the expected windows here
 * and the generated ones cannot disagree. If this used the local date the two
 * would differ for part of every day in any non-UTC timezone, and the suite
 * would fail for a reason that has nothing to do with the code under test.
 */
const todayUtc = () => isoDate(new Date());

/**
 * Successful extensions, counted as they happen.
 *
 * Test 9 asserts the audit-row count equals THIS, not a literal. A hard-coded
 * number would have to be recounted by hand every time a test is added or an
 * expectation changes, and the first time somebody got it wrong the assertion
 * would start passing for the wrong reason. Derived from the actual responses,
 * it cannot drift.
 */
let successfulExtensions = 0;

/** A POST to the horizon endpoint that counts itself when it succeeds. */
async function extend(cookie, throughDate) {
  const result = await call('POST', HORIZON_PATH(), cookie, { throughDate });
  if (result.status === 200) successfulExtensions += 1;
  return result;
}

/**
 * One HTTP call. `options.timeoutMs` is opt-in and defaults to off.
 *
 * ===========================================================================
 * The timeout is a per-request option rather than a suite-wide default on
 * purpose: every other test here wants the old behaviour, and giving them all
 * a deadline would change what they prove. Only test 11 passes one, because
 * only test 11 deliberately makes the server sit on a lock.
 *
 * A timeout is reported as a THROWN error, never as a response. `fetch` with
 * an aborted signal rejects, and that rejection propagates out of `call` — so
 * a client-side timeout can never arrive at an assertion disguised as a
 * status code. It is surfaced with the elapsed time and the budget, because
 * "the client gave up" and "the server refused" need different fixes.
 * ===========================================================================
 */
async function call(method, path, cookie, body, options = {}) {
  const { timeoutMs } = options;
  const started = Date.now();

  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(cookie === null ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });
  } catch (error) {
    const elapsed = Date.now() - started;
    if (timeoutMs !== undefined && elapsed >= timeoutMs - 250) {
      throw new Error(
        `client-side timeout after ${String(elapsed)} ms (budget ${String(timeoutMs)} ms) ` +
          `on ${method} ${path}. The server did not answer within the budget; this is NOT ` +
          'the server-side transaction deadline and must not be read as one.',
      );
    }
    throw error;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload, elapsedMs: Date.now() - started };
}

/* -------------------------------------------------------------------------- */
/*  Identity guards — the suite refuses to run without them                   */
/* -------------------------------------------------------------------------- */

async function guardDatabase() {
  const confirmed = await assertIsolatedDatabase({
    prisma,
    suite: 'the inventory-horizon suite',
    env: { ...process.env, EASEIT_TEST_DBS: EXTRA_ALLOWED },
  });
  return confirmed.liveName;
}

/**
 * The API must be talking to the database this suite just claimed.
 *
 * Without this the suite could assert against one database while the endpoint
 * wrote to another, and every assertion would be vacuously true. The probe is
 * the suite's own property, read back through the API: a 404 means the API
 * cannot see the row this process just committed, which means they are not the
 * same database.
 */
async function assertApiSharesDatabase(cookie, isolatedDb) {
  const probe = await call('GET', `/properties/${fixture.propertyCode}/inventory/horizon`, cookie);
  if (probe.status !== 200) {
    // The shared message's exact parameter set: { api, propertyId, status, isolatedDb }.
    throw new Error(
      apiMismatchMessage({
        api: API,
        propertyId: fixture.propertyId,
        status: probe.status,
        isolatedDb,
      }),
    );
  }
  note(`API and suite share ${isolatedDb}; horizon probe answered 200`);
}

/**
 * Is the inventory-horizon route actually loaded in the API we are pointed at?
 *
 * ===========================================================================
 * Checked BEFORE anything is created, and before the database-identity probe,
 * because the two failures look identical and have opposite remedies.
 *
 * `SessionAuthGuard` is attached at the controller class, so a **registered**
 * route answers an unauthenticated request with **401** — the guard rejects it
 * before any property is resolved. A **404** with no cookie therefore means
 * Fastify has no such route: the running process was built before this module
 * existed.
 *
 * Without this check the suite's first failure is
 * `assertApiSharesDatabase` reporting "It is pointed at a different database.
 * Start an API whose DATABASE_URL names easeit_test" — which sends an operator
 * to debug a database that is perfectly fine, when the real answer is "rebuild
 * and restart the API". That exact state is what the process on :4100 was in
 * when this suite was written.
 *
 * The probe is a GET with no credentials against a property code that need not
 * exist: nothing is created, nothing is written, and no session is used.
 * ===========================================================================
 */
async function assertRouteIsLoaded() {
  const probe = await call('GET', '/properties/ZZINVH-PROBE/inventory/horizon', null);

  if (probe.status === 401) {
    note('inventory horizon route is loaded (401 from the auth guard, as expected)');
    return;
  }

  if (probe.status === 404) {
    throw new Error(
      'REFUSING TO RUN: the API at ' +
        `${API} has no inventory-horizon route.\n` +
        '  An unauthenticated request returned 404. A registered route would\n' +
        '  return 401, because SessionAuthGuard rejects it before resolving a\n' +
        '  property. 404 means the running process was built before the\n' +
        '  inventory module existed.\n' +
        '  Fix: rebuild and restart the API (pnpm --filter @repo/api build, then\n' +
        '  restart the process serving this port). This suite does not restart it.',
    );
  }

  throw new Error(
    `REFUSING TO RUN: an unauthenticated probe of the inventory-horizon route ` +
      `answered HTTP ${String(probe.status)}. Expected 401 (route present) or ` +
      '404 (stale build). Something else is serving this port.',
  );
}

/* -------------------------------------------------------------------------- */
/*  Fixtures — everything this suite owns                                     */
/* -------------------------------------------------------------------------- */

/**
 * Remove anything a previous crashed run left behind.
 *
 * Keyed on `FIXTURE_PREFIX`, which only this suite writes, and run after the
 * identity guard has established the database exists for this suite alone.
 * The trigger is dropped first: it is the one artefact that is not a row, so
 * nothing else would ever clean it up.
 */
async function sweepLeftovers() {
  const stale = await prisma.property.findMany({
    where: { code: { startsWith: FIXTURE_PREFIX } },
    select: { id: true, code: true },
  });
  if (stale.length > 0) {
    console.log(`Sweeping ${String(stale.length)} leftover fixture propert(ies).`);
    for (const property of stale) {
      await dropProperty(property.id);
      console.log(`  removed ${property.code}`);
    }
  }

  const orphans = await prisma.user.deleteMany({
    where: { email: { endsWith: '@invh.invalid' }, propertyRoles: { none: {} } },
  });
  if (orphans.count > 0) {
    console.log(`  removed ${String(orphans.count)} leftover harness user(s)`);
  }
}

/**
 * Delete one suite-owned property and everything hanging off it.
 *
 * Order comes from the real schema, not from hope: `ReservationRoom.roomType`
 * and `.room` are `onDelete: Restrict` and `Room.roomType` is `Restrict`, so
 * stays go before rooms and rooms before categories. Everything keyed only on
 * `propertyId` would cascade, and is deleted explicitly anyway so a Restrict
 * further down cannot strand the property row.
 *
 * Every statement is scoped by `propertyId`. There is no unscoped delete here.
 */
async function dropProperty(propertyId) {
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

      /**
       * Users are NOT removed here, deliberately.
       *
       * This used to take an optional `userId` and delete it in the same
       * transaction. Both call sites passed one argument, so the branch was
       * dead — and removing it is the right fix rather than wiring it up,
       * because the suite owns two users and teardown removes them by their
       * own recorded ids, each guarded by `propertyRoles: { none: {} }`. One
       * optional id could never have covered both, and widening this to a
       * list would put user deletion inside a property transaction where it
       * does not belong.
       */
    },
    { timeout: 60_000 },
  );
}

/**
 * Build the property, two categories, their rooms, and two users.
 *
 * `admin` holds PROPERTY_ADMIN (so it carries `property:settings` and can
 * POST); `clerk` holds FRONT_DESK (so it carries `reservations:read` but NOT
 * `property:settings`, which is what makes the 403 test meaningful rather than
 * a tautology). Each holds exactly one grant.
 *
 * No inventory is created here. Test 1 is the first thing that generates any,
 * so "rows created" has an unambiguous baseline of zero.
 */
async function buildFixture() {
  const runId = Date.now().toString(36).toUpperCase().slice(-6);
  const code = `${FIXTURE_PREFIX}${runId}`;
  const today = todayUtc();

  const adminRole = await prisma.role.findFirst({
    where: { key: 'PROPERTY_ADMIN', propertyId: null },
    select: { id: true },
  });
  const clerkRole = await prisma.role.findFirst({
    where: { key: 'FRONT_DESK', propertyId: null },
    select: { id: true },
  });
  if (adminRole === null || clerkRole === null) {
    throw new Error('global PROPERTY_ADMIN / FRONT_DESK role templates are missing.');
  }

  const property = await prisma.property.create({
    data: {
      slug: `zz-invh-${runId.toLowerCase()}`,
      code,
      name: `ZZ Inventory Horizon ${runId}`,
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      businessDate: utcMidnight(today),
      status: 'ACTIVE',
    },
    select: { id: true, code: true },
  });

  // Recorded before anything else is created, so a throw from here on is
  // recoverable by teardown rather than a silent leak.
  owned.propertyId = property.id;
  owned.propertyCode = property.code;

  const makeUser = async (label, roleId) => {
    const user = await prisma.user.create({
      data: {
        email: `zzinvh-${label}-${runId.toLowerCase()}@invh.invalid`,
        passwordHash: 'not-a-usable-hash',
        firstName: 'Horizon',
        lastName: label,
        isActive: true,
        isTwoFactorEnabled: false,
      },
      select: { id: true, email: true },
    });
    owned.userIds.push(user.id);
    await prisma.userPropertyRole.create({
      data: { userId: user.id, propertyId: property.id, roleId },
    });
    return user;
  };

  const admin = await makeUser('admin', adminRole.id);
  const clerk = await makeUser('clerk', clerkRole.id);

  /**
   * Two categories. A holds two sellable rooms plus one OUT_OF_ORDER, so
   * `physical` must come back 2 and not 3 — that is the seed-rule assertion.
   * B holds exactly one room, so a single booking fills it and test 7 can tell
   * "sold out" apart from "no inventory".
   */
  const categoryA = await prisma.roomType.create({
    data: {
      propertyId: property.id,
      code: `${FIXTURE_PREFIX}A`,
      name: 'ZZ Horizon Category A',
      description: 'Two sellable rooms and one out of order.',
      baseRateMinor: 500000,
      currency: 'INR',
      maxGuests: 2,
      sortOrder: 1,
    },
    select: { id: true, code: true },
  });
  owned.roomTypeIds.push(categoryA.id);

  const categoryB = await prisma.roomType.create({
    data: {
      propertyId: property.id,
      code: `${FIXTURE_PREFIX}B`,
      name: 'ZZ Horizon Category B',
      description: 'Exactly one sellable room.',
      baseRateMinor: 400000,
      currency: 'INR',
      maxGuests: 2,
      sortOrder: 2,
    },
    select: { id: true, code: true },
  });
  owned.roomTypeIds.push(categoryB.id);

  const rooms = [];
  for (const [number, roomTypeId, status] of [
    [`${FIXTURE_PREFIX}-A1`, categoryA.id, 'VACANT_CLEAN'],
    [`${FIXTURE_PREFIX}-A2`, categoryA.id, 'OUT_OF_SERVICE'],
    [`${FIXTURE_PREFIX}-A3`, categoryA.id, 'OUT_OF_ORDER'],
    [`${FIXTURE_PREFIX}-B1`, categoryB.id, 'VACANT_CLEAN'],
  ]) {
    const room = await prisma.room.create({
      data: { propertyId: property.id, roomTypeId, number, status },
      select: { id: true, number: true, status: true },
    });
    rooms.push(room);
  }

  fixture = {
    propertyId: property.id,
    propertyCode: property.code,
    admin,
    clerk,
    categoryA: categoryA.id,
    categoryB: categoryB.id,
    rooms,
    today,
  };

  /**
   * Printed so an interrupted run is recoverable: these ids are the only trace
   * this step can leave behind.
   */
  note(
    `fixture property ${property.code}=${property.id}; ` +
      `A=${categoryA.id} B=${categoryB.id}; ` +
      `admin=${admin.id} clerk=${clerk.id}`,
  );
  note('category A has 2 sellable rooms + 1 OUT_OF_ORDER; category B has 1 sellable room');
}

/**
 * Proves the suite owns the property before anything destructive runs.
 *
 * Three independent facts, all required: the id is the one this process
 * created, the code carries the suite's prefix, and the property holds no rows
 * this suite did not make. If any fails the suite stops rather than operating
 * on something it may not own.
 */
async function assertFixtureOwnership() {
  if (fixture === null) throw new Error('ownership check ran before the fixture was built.');

  const row = await prisma.property.findUnique({
    where: { id: fixture.propertyId },
    select: { id: true, code: true, slug: true },
  });
  if (row === null) throw new Error('the fixture property is not in the database.');
  if (!row.code.startsWith(FIXTURE_PREFIX)) {
    throw new Error(`refusing to proceed: ${row.code} is not a ${FIXTURE_PREFIX} fixture.`);
  }
  if (!row.slug.startsWith('zz-invh-')) {
    throw new Error(`refusing to proceed: slug ${row.slug} is not a suite fixture.`);
  }

  // Nothing of anybody else's can be hanging off it: the only room types,
  // rooms and grants are the ones built above.
  const [types, rooms, grants, stays] = await Promise.all([
    prisma.roomType.count({ where: { propertyId: fixture.propertyId } }),
    prisma.room.count({ where: { propertyId: fixture.propertyId } }),
    prisma.userPropertyRole.count({ where: { propertyId: fixture.propertyId } }),
    prisma.reservation.count({ where: { propertyId: fixture.propertyId } }),
  ]);
  if (types !== 2 || rooms !== 4 || grants !== 2 || stays !== 0) {
    throw new Error(
      `refusing to proceed: unexpected fixture shape ` +
        `(types=${String(types)} rooms=${String(rooms)} grants=${String(grants)} stays=${String(stays)}).`,
    );
  }

  check(
    'ownership proven before any destructive step',
    true,
    `${row.code} / ${fixture.propertyId}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Reads, all scoped to the fixture                                          */
/* -------------------------------------------------------------------------- */

const inventoryRows = (where = {}) =>
  prisma.inventoryDay.findMany({
    where: { propertyId: fixture.propertyId, ...where },
    select: {
      id: true,
      roomTypeId: true,
      stayDate: true,
      physical: true,
      sold: true,
      blocked: true,
      overbookingAllowance: true,
    },
    orderBy: [{ stayDate: 'asc' }, { roomTypeId: 'asc' }],
  });

const inventoryCount = (where = {}) =>
  prisma.inventoryDay.count({ where: { propertyId: fixture.propertyId, ...where } });

const horizonAudits = () =>
  prisma.auditLog.findMany({
    where: { propertyId: fixture.propertyId, event: 'INVENTORY_HORIZON_EXTENDED' },
    select: { id: true, actorUserId: true, before: true, after: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

/* -------------------------------------------------------------------------- */
/*  The rollback failure mechanism                                            */
/* -------------------------------------------------------------------------- */

/**
 * Block one key with an uncommitted insert, so a LATER chunk cannot complete.
 *
 * ===========================================================================
 * WHAT THIS REPLACED, AND WHY.
 *
 * The first version of this test installed a `BEFORE INSERT` trigger on
 * `inventory_day`. It worked, but the cost was unacceptable for a shared
 * table: `CREATE TRIGGER` takes an ACCESS EXCLUSIVE lock, every other
 * connection's inventory inserts then execute the function for every row while
 * it exists, and it was the one artefact that would survive a Ctrl-C. None of
 * that is worth a test.
 *
 * HOW THIS WORKS, WITH NO DDL AND NO PRODUCTION HOOK.
 * A second connection inserts ONE row -- `(suite property, suite category,
 * sentinel date)` -- and leaves the transaction open. The sentinel sits in the
 * SECOND chunk. When the real endpoint runs:
 *
 *   1. chunk 1 `[today, +179]` inserts its rows for real, uncommitted;
 *   2. chunk 2 `[+180, +200]` reaches the sentinel key and must WAIT. This is
 *      documented behaviour, not an assumption. PostgreSQL 17.6's own manual,
 *      section 62.5 "Index Uniqueness Checks" (the section the INSERT page
 *      points to for concurrency), states it directly:
 *
 *          "If a conflicting row has been inserted by an as-yet-uncommitted
 *           transaction, the would-be inserter must wait to see if that
 *           transaction commits. If it rolls back then there is no conflict.
 *           ... (In practice we just wait for the other transaction to end and
 *           then redo the visibility check in toto.)"
 *
 *      The wait is observable as the `spectoken` wait event -- "Waiting to
 *      acquire a speculative insertion lock" (monitoring-stats) -- and the
 *      INSERT page warns that "tables with unique indexes might block if
 *      concurrent sessions perform actions that lock or modify rows matching
 *      the unique index values being inserted". `ON CONFLICT DO NOTHING` has
 *      to arbitrate through that same uniqueness check, so it cannot skip a
 *      conflict it does not yet know exists;
 *   3. the service transaction exceeds its stated deadline
 *      (`TRANSACTION_TIMEOUT_MS`) and is aborted;
 *   4. **PostgreSQL rolls back the whole transaction**, chunk 1's rows and the
 *      audit row included.
 *
 * WHAT THIS PROVES, STATED PRECISELY.
 * The proposition under test is "a failure in a later chunk discards the rows
 * an earlier chunk already inserted". That is exactly what is demonstrated,
 * against real PostgreSQL MVCC, with two real connections and a real ROLLBACK.
 * Nothing is mocked, stubbed or injected.
 *
 * What it is NOT: a constraint violation raised by PostgreSQL inside chunk 2.
 * That variant is **impossible** here without DDL, and it is worth recording
 * why rather than leaving it as an unexplained omission:
 *
 *   * the statement writes `sold = 0, blocked = 0, overbookingAllowance = 0`,
 *     so `inventory_day_not_oversold` reduces to `0 <= physical` and
 *     `inventory_day_counters_non_negative` to `physical >= 0`. Both hold for
 *     every row that can exist;
 *   * `physical` is a `count(*)`, which is never negative;
 *   * `inventory_day_same_property_as_room_type` takes both columns from the
 *     same `room_type` row, so the pair always exists;
 *   * `ON CONFLICT DO NOTHING` absorbs the unique index by design.
 *
 * A deadlock (`40P01`) would be a genuine PostgreSQL error, but PostgreSQL
 * chooses the victim, so it cannot reliably be aimed at the API's transaction
 * -- it would abort the blocker about as often, and the test would silently
 * stop testing anything.
 *
 * BLAST RADIUS: one row key, in a property this process created. Speculative
 * insertion only blocks an inserter of the SAME key, so no other property's
 * request can wait on it. The table lock taken is ROW EXCLUSIVE, which is what
 * every ordinary insert takes and is compatible with all of them.
 *
 * CLEANUP: a transaction rollback. PostgreSQL performs it on COMMIT failure,
 * on an explicit rollback, on disconnect, and on SIGKILL -- there is no state
 * that can outlive the process, which is the whole advantage over DDL.
 * ===========================================================================
 */
/**
 * `promise`, but it must settle within `ms` or the wait is abandoned.
 *
 * ===========================================================================
 * One helper for all three bounded waits in `withBlockedKey`, because the
 * pattern was written out three times and each copy leaked its timer: a bare
 * `Promise.race([work, new Promise((_, r) => setTimeout(r, ms))])` leaves the
 * timer pending when `work` wins, and a pending `setTimeout` keeps Node's
 * event loop alive. Three of them meant a suite that had finished could sit
 * for up to the longest budget before exiting.
 *
 * `clearTimeout` in a `finally` fixes that, and it runs whether the work
 * resolved or rejected. The rejection carries the caller's message so each
 * site can explain what the bound means at that point.
 *
 * It does NOT cancel the underlying work: nothing here can abort an in-flight
 * query or connection close. Abandoning a wait and ending the work are
 * different things, and only the first is being claimed.
 * ===========================================================================
 */
async function withDeadline(promise, ms, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function withBlockedKey(roomTypeId, sentinelDate, body) {
  const blocker = createPrismaClient();

  /** Resolved only once the conflicting row is inserted and being held. */
  let signalReady = null;
  let signalFailed = null;
  const ready = new Promise((resolve, reject) => {
    signalReady = resolve;
    signalFailed = reject;
  });
  // A late failure (after the race below has settled) would otherwise reject a
  // promise nothing is listening to, which Node reports as an unhandled
  // rejection. `blockerFault` is the channel that carries it instead.
  ready.catch(() => {});

  /** Resolved by `finally` to let the blocker roll back. */
  let release = null;
  const released = new Promise((resolve) => {
    release = resolve;
  });

  /**
   * The blocker transaction.
   *
   * `released` is created BEFORE the transaction starts, so `release` is a
   * function from the first moment — never null when `finally` runs. The
   * previous version assigned it inside the callback, after the insert, so a
   * failure during connection setup or the insert left it null and `finally`
   * then waited on the blocker's own 120 s deadline with the real error
   * masked.
   *
   * Readiness is signalled only AFTER the insert returns, which is the point
   * at which PostgreSQL is actually holding the key. A failure anywhere before
   * that rejects `ready`, so the caller learns immediately instead of racing.
   */
  const held = blocker
    .$transaction(
      async (tx) => {
        await tx.inventoryDay.create({
          data: {
            propertyId: owned.propertyId,
            roomTypeId,
            stayDate: utcMidnight(sentinelDate),
            physical: 1,
            sold: 0,
            blocked: 0,
            overbookingAllowance: 0,
          },
        });

        // The row exists and is uncommitted: the key is held from here.
        signalReady();
        await released;

        // Always rolled back: the row must never become real.
        throw new Error(BLOCKER_ROLLBACK);
      },
      { maxWait: 10_000, timeout: 180_000 },
    )
    .catch((error) => {
      const message = String(error?.message ?? error);
      if (message.includes(BLOCKER_ROLLBACK)) return;

      // Setup, insert or deadline failure. Surface it through `ready` so the
      // caller fails fast rather than proceeding without a blocker, and
      // rethrow nothing here: `held` must settle so `finally` can await it.
      if (signalFailed !== null) signalFailed(new Error(`blocker failed: ${message}`));
      blockerFault = message;
    });

  let bodyError = null;
  try {
    /**
     * Bounded readiness wait. Without the bound a blocker that never reports
     * ready would hang the suite; with a fixed sleep instead, a slow cold
     * connection would let the request start before the key was held, the
     * extension would succeed, and the test would fail for the wrong reason.
     */
    await withDeadline(
      ready,
      READY_TIMEOUT_MS,
      `blocker was not ready within ${String(READY_TIMEOUT_MS)} ms`,
    );

    note(`blocker holds (${String(owned.propertyCode)}, ${sentinelDate}) uncommitted`);
    return await body();
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    /**
     * Cleanup that cannot mask the original error.
     *
     * `release()` is always callable. Each cleanup step is attempted
     * independently; a cleanup failure is reported and counted, but it is
     * never rethrown when `bodyError` is already set, because the first error
     * is the one worth reading.
     */
    try {
      release();

      /**
       * Bounded, like the readiness wait and for the mirror-image reason.
       *
       * If readiness timed out the blocker may still be stuck inside its own
       * statement, in which case `release()` has nothing to unblock and
       * `await held` would sit until the blocker's own 180 s deadline. Bounding
       * it keeps a stuck blocker from turning a 15 s diagnosis into a 3 minute
       * one. The connection is closed either way in the inner `finally`, and
       * closing it is what makes PostgreSQL roll the transaction back.
       */
      await withDeadline(
        held,
        HELD_TIMEOUT_MS,
        `blocker did not settle within ${String(HELD_TIMEOUT_MS)} ms; ` +
          'attempting to disconnect, after which PostgreSQL should roll it back ' +
          'once the connection actually closes',
      );
      note('blocker rolled back; no sentinel row was committed');
    } catch (cleanupError) {
      failures += 1;
      console.error(`  Blocker rollback failed: ${String(cleanupError?.message ?? cleanupError)}`);
      if (bodyError === null) throw cleanupError;
    } finally {
      /**
       * Bounded, like the two waits above and for the same reason.
       *
       * `$disconnect()` is reached precisely in the stuck-blocker case -- the
       * one where readiness or settlement already timed out -- which is also
       * the case where a disconnect is most likely to block on an in-flight
       * statement. An unbounded wait here would turn a 15 s diagnosis into an
       * indefinite hang, in the cleanup path, after the real error had already
       * been recorded.
       *
       * WHAT A TIMED-OUT DISCONNECT DOES AND DOES NOT TELL US.
       * It does NOT establish that the blocker's PostgreSQL transaction has
       * rolled back. The rollback happens when the backend connection actually
       * closes, which the server does on its own schedule; all this bound
       * proves is that the client stopped waiting to observe it. The message
       * says so explicitly, because "cleanup finished" and "the transaction is
       * gone" are different claims and only the first one is being made.
       *
       * The row is uncommitted either way, so it can never become visible --
       * but a subsequent assertion must not be read as proof of rollback if
       * this path was taken, which is why it counts as a failure.
       */
      try {
        /**
         * ONE `$disconnect()` call, inside the bound.
         *
         * Invoked exactly once and passed straight to `withDeadline`, so there
         * is no unbounded `await` ahead of the race that could defeat it. The
         * timer is cleared by `withDeadline`'s `finally` whether the
         * disconnect resolves or rejects.
         */
        await withDeadline(
          blocker.$disconnect(),
          DISCONNECT_TIMEOUT_MS,
          `blocker disconnect did not complete within ${String(DISCONNECT_TIMEOUT_MS)} ms. ` +
            'The client has stopped waiting; this does NOT prove the blocker transaction ' +
            'has rolled back, only that the connection close was not observed. Its row ' +
            'was never committed.',
        );
      } catch (disconnectError) {
        failures += 1;
        console.error(
          `  Blocker disconnect failed: ${String(disconnectError?.message ?? disconnectError)}`,
        );
        // Never rethrown: `bodyError` (or the settle error above) is the one
        // worth reading, and a cleanup problem must not replace it.
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

async function run() {
  console.log('════ inventory horizon suite ════\n');

  const isolatedDb = await guardDatabase();

  // Before anything is created: is the code under test even loaded?
  await assertRouteIsLoaded();

  await sweepLeftovers();
  await buildFixture();
  await assertFixtureOwnership();

  const adminCookie = `easeit_session=${mintSession(fixture.admin.id, fixture.admin.email)}`;
  const clerkCookie = `easeit_session=${mintSession(fixture.clerk.id, fixture.clerk.email)}`;
  await assertApiSharesDatabase(adminCookie, isolatedDb);

  const today = fixture.today;
  const HORIZON = HORIZON_PATH();

  /* ---------------------------------------------------------------- 1 */
  console.log('\n1. Initial horizon generation.');
  {
    const before = await inventoryCount();
    check('the fixture starts with no inventory', before === 0, `${String(before)} row(s)`);

    const to = shiftDays(today, 9);
    const res = await extend(adminCookie, to);

    check('the extension answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    check(
      'it reports 2 room types and 10 days',
      res.payload?.roomTypeCount === 2 && res.payload?.dayCount === 10,
      `types=${String(res.payload?.roomTypeCount)} days=${String(res.payload?.dayCount)}`,
    );
    check(
      'rowsCreated is types x days',
      res.payload?.rowsCreated === 20,
      `${String(res.payload?.rowsCreated)}`,
    );
    check('rowsSkipped is zero on a first run', res.payload?.rowsSkipped === 0);
    check(
      'fromDate is today and throughDate is what was asked',
      res.payload?.fromDate === today && res.payload?.throughDate === to,
      `${String(res.payload?.fromDate)}..${String(res.payload?.throughDate)}`,
    );
    check(
      'the reported horizon matches the request',
      res.payload?.fullyConfiguredThrough === to,
      String(res.payload?.fullyConfiguredThrough),
    );

    const rows = await inventoryRows();
    check('the database holds exactly 20 rows', rows.length === 20, `${String(rows.length)}`);
    check(
      'every date from today..+9 exists for BOTH categories',
      (() => {
        for (let offset = 0; offset <= 9; offset += 1) {
          const date = shiftDays(today, offset);
          for (const typeId of [fixture.categoryA, fixture.categoryB]) {
            const hit = rows.find((r) => isoDate(r.stayDate) === date && r.roomTypeId === typeId);
            if (hit === undefined) return false;
          }
        }
        return true;
      })(),
      'checked per date AND per category, not by total',
    );
    check(
      'new rows start at sold=0, blocked=0, overbookingAllowance=0',
      rows.every((r) => r.sold === 0 && r.blocked === 0 && r.overbookingAllowance === 0),
    );

    // The seed rule: OUT_OF_ORDER excluded, OUT_OF_SERVICE counted.
    const aRows = rows.filter((r) => r.roomTypeId === fixture.categoryA);
    const bRows = rows.filter((r) => r.roomTypeId === fixture.categoryB);
    check(
      'physical for A is 2: OUT_OF_SERVICE counted, OUT_OF_ORDER excluded',
      aRows.every((r) => r.physical === 2),
      `physical values: ${[...new Set(aRows.map((r) => r.physical))].join(',')}`,
    );
    check(
      'physical for B is 1',
      bRows.every((r) => r.physical === 1),
      `physical values: ${[...new Set(bRows.map((r) => r.physical))].join(',')}`,
    );
  }

  /* ---------------------------------------------------------------- 2 */
  console.log('\n2. Repeating the same request creates nothing.');
  {
    const to = shiftDays(today, 9);
    const rowsBefore = await inventoryRows();
    const res = await extend(adminCookie, to);

    check('the repeat answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    check('rowsCreated is 0', res.payload?.rowsCreated === 0, String(res.payload?.rowsCreated));
    check(
      'rowsSkipped accounts for every row it covered',
      res.payload?.rowsSkipped === 20,
      String(res.payload?.rowsSkipped),
    );

    const rowsAfter = await inventoryRows();
    check('the row count is unchanged', rowsAfter.length === rowsBefore.length);
    check(
      'no row was rewritten: ids and counters are byte-identical',
      JSON.stringify(rowsBefore.map((r) => [r.id, r.physical, r.sold, r.blocked])) ===
        JSON.stringify(rowsAfter.map((r) => [r.id, r.physical, r.sold, r.blocked])),
      'ON CONFLICT DO NOTHING, not DO UPDATE',
    );
  }

  /* ---------------------------------------------------------------- 3 */
  console.log('\n3. Extending an existing horizon appends only what is missing.');
  {
    const to = shiftDays(today, 19);
    const res = await extend(adminCookie, to);

    check('the extension answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    check(
      'only the 10 new days x 2 types were created',
      res.payload?.rowsCreated === 20,
      String(res.payload?.rowsCreated),
    );
    check(
      'the first 10 days were skipped, not rewritten',
      res.payload?.rowsSkipped === 20,
      String(res.payload?.rowsSkipped),
    );
    check('the total is now 40 rows', (await inventoryCount()) === 40);
    check(
      'the horizon advanced to the new date',
      res.payload?.fullyConfiguredThrough === to,
      String(res.payload?.fullyConfiguredThrough),
    );
  }

  /* ---------------------------------------------------------------- 4+5 */
  console.log('\n4/5. An internal gap is filled; existing counters survive.');
  {
    /**
     * A deliberately non-trivial state first: put real counters on a row the
     * fill must not touch, then remove one row from the MIDDLE of the window.
     *
     * The mutated row is +3 and the hole is +5, so they are different dates
     * and the assertion cannot pass by accident.
     */
    const keepDate = shiftDays(today, 3);
    const holeDate = shiftDays(today, 5);

    const mutated = await prisma.inventoryDay.updateMany({
      where: {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryA,
        stayDate: utcMidnight(keepDate),
      },
      data: { sold: 1, blocked: 1, overbookingAllowance: 3 },
    });
    check('one row was given live counters to defend', mutated.count === 1);

    const keptBefore = await inventoryRows({
      roomTypeId: fixture.categoryA,
      stayDate: utcMidnight(keepDate),
    });

    /**
     * THE ONLY INVENTORY DELETE IN THIS SUITE.
     *
     * Scoped by all three of `propertyId` (the uuid this process created),
     * `roomTypeId` (a category this process created) and one exact `stayDate`.
     * It can match at most one row, and that row can only belong to this
     * fixture. `deleteMany` is used rather than `delete` so a missing row is a
     * count of 0 rather than an exception, and the count is then asserted.
     */
    const removed = await prisma.inventoryDay.deleteMany({
      where: {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryB,
        stayDate: utcMidnight(holeDate),
      },
    });
    check(
      'exactly one fixture row was removed to make the gap',
      removed.count === 1,
      `${fixture.propertyCode} / B / ${holeDate}`,
    );

    // GET must now report the hole rather than the maximum.
    const view = await call('GET', HORIZON, adminCookie);
    check('GET answers 200', view.status === 200, `HTTP ${String(view.status)}`);
    check(
      'lastConfiguredDate still reaches the far end',
      view.payload?.lastConfiguredDate === shiftDays(today, 19),
      String(view.payload?.lastConfiguredDate),
    );
    check(
      'fullyConfiguredThrough collapses to the day before the hole',
      view.payload?.fullyConfiguredThrough === shiftDays(today, 4),
      `${String(view.payload?.fullyConfiguredThrough)} (MAX would have said ${shiftDays(today, 19)})`,
    );
    check(
      'the gap names the right category and date',
      view.payload?.gaps?.length === 1 &&
        view.payload.gaps[0].firstMissingDate === holeDate &&
        view.payload.gaps[0].code === `${FIXTURE_PREFIX}B`,
      JSON.stringify(view.payload?.gaps),
    );

    // Re-extending to the SAME far date must fill the hole, nothing else.
    const refill = await extend(adminCookie, shiftDays(today, 19));
    check(
      'the refill creates exactly the one missing row',
      refill.payload?.rowsCreated === 1,
      String(refill.payload?.rowsCreated),
    );
    check('the total is back to 40', (await inventoryCount()) === 40);
    check(
      'the horizon is whole again',
      refill.payload?.fullyConfiguredThrough === shiftDays(today, 19),
      String(refill.payload?.fullyConfiguredThrough),
    );

    const keptAfter = await inventoryRows({
      roomTypeId: fixture.categoryA,
      stayDate: utcMidnight(keepDate),
    });
    check(
      'the row with live counters is byte-identical: sold/blocked/physical/allowance',
      JSON.stringify(keptBefore) === JSON.stringify(keptAfter),
      `sold=${String(keptAfter[0]?.sold)} blocked=${String(keptAfter[0]?.blocked)} ` +
        `physical=${String(keptAfter[0]?.physical)} allowance=${String(keptAfter[0]?.overbookingAllowance)}`,
    );
    check(
      'and its id did not change, so it was never replaced',
      keptBefore[0]?.id === keptAfter[0]?.id,
    );

    // Put it back so later tests start from a clean counter state.
    await prisma.inventoryDay.updateMany({
      where: {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryA,
        stayDate: utcMidnight(keepDate),
      },
      data: { sold: 0, blocked: 0, overbookingAllowance: 0 },
    });
  }

  /* ---------------------------------------------------------------- 6 */
  console.log('\n6. Concurrent extensions and ON CONFLICT behaviour.');
  {
    const to = shiftDays(today, 39);
    const before = await inventoryCount();

    const results = await Promise.all(Array.from({ length: 8 }, () => extend(adminCookie, to)));

    check(
      'all 8 concurrent extensions answered 200',
      results.every((r) => r.status === 200),
      results.map((r) => r.status).join(','),
    );
    check(
      'none leaked a unique-violation to the caller',
      results.every((r) => r.payload?.rowsCreated !== undefined),
      'no 500, no P2002',
    );

    const created = results.reduce((sum, r) => sum + (r.payload?.rowsCreated ?? 0), 0);
    check(
      'the 20 new days x 2 types were created exactly once in total',
      created === 40,
      `${String(created)} across 8 requests`,
    );
    check(
      'the final row count is exact, with no duplicates',
      (await inventoryCount()) === before + 40,
      `${String(await inventoryCount())}`,
    );

    const dupes = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM inventory_day
         WHERE "propertyId" = ${fixture.propertyId}::uuid
         GROUP BY "propertyId", "roomTypeId", "stayDate"
        HAVING count(*) > 1
      ) d`;
    check(
      'no (property, roomType, date) appears twice',
      Number(dupes[0]?.n ?? -1) === 0,
      `${String(dupes[0]?.n)} duplicate key group(s)`,
    );
  }

  /* ---------------------------------------------------------------- 7 */
  console.log('\n7. Missing inventory versus genuinely sold-out inventory.');
  {
    // Beyond the configured horizon: a calendar gap, not an availability fact.
    const farArrival = shiftDays(today, 100);
    const beyond = await call(
      'POST',
      `/properties/${fixture.propertyCode}/reservations`,
      adminCookie,
      {
        roomTypeId: fixture.categoryB,
        roomId: null,
        arrivalDate: farArrival,
        departureDate: shiftDays(farArrival, 1),
        adults: 1,
        mealPlan: 'EP',
        source: 'WALK_IN',
        guests: [{ firstName: 'Horizon', lastName: 'Beyond' }],
        isInstantCheckIn: false,
      },
    );
    check(
      'a stay past the horizon is refused 409',
      beyond.status === 409,
      `HTTP ${String(beyond.status)}`,
    );
    check(
      'with INVENTORY_NOT_CONFIGURED, not ROOM_UNAVAILABLE',
      beyond.payload?.code === 'INVENTORY_NOT_CONFIGURED',
      String(beyond.payload?.code),
    );
    check(
      'the message tells the operator to extend the calendar',
      /extend the availability calendar/i.test(String(beyond.payload?.message)),
      String(beyond.payload?.message).slice(0, 70),
    );

    // Inside the horizon, fill B's single room, then try again.
    const nearArrival = shiftDays(today, 2);
    const first = await call(
      'POST',
      `/properties/${fixture.propertyCode}/reservations`,
      adminCookie,
      {
        roomTypeId: fixture.categoryB,
        roomId: null,
        arrivalDate: nearArrival,
        departureDate: shiftDays(nearArrival, 1),
        adults: 1,
        mealPlan: 'EP',
        source: 'WALK_IN',
        guests: [{ firstName: 'Horizon', lastName: 'First' }],
        isInstantCheckIn: false,
      },
    );
    check(
      'the first booking into B succeeds',
      first.status === 201,
      `HTTP ${String(first.status)}`,
    );

    const soldOut = await call(
      'POST',
      `/properties/${fixture.propertyCode}/reservations`,
      adminCookie,
      {
        roomTypeId: fixture.categoryB,
        roomId: null,
        arrivalDate: nearArrival,
        departureDate: shiftDays(nearArrival, 1),
        adults: 1,
        mealPlan: 'EP',
        source: 'WALK_IN',
        guests: [{ firstName: 'Horizon', lastName: 'Second' }],
        isInstantCheckIn: false,
      },
    );
    check(
      'a second booking into B is refused 409',
      soldOut.status === 409,
      `HTTP ${String(soldOut.status)}`,
    );
    check(
      'with ROOM_UNAVAILABLE: the row exists, the room does not',
      soldOut.payload?.code === 'ROOM_UNAVAILABLE',
      String(soldOut.payload?.code),
    );
    check(
      'the two refusals are distinguishable by code',
      beyond.payload?.code !== soldOut.payload?.code,
      `${String(beyond.payload?.code)} vs ${String(soldOut.payload?.code)}`,
    );

    // And the sale is reflected per date and per category.
    const sold = await inventoryRows({
      roomTypeId: fixture.categoryB,
      stayDate: utcMidnight(nearArrival),
    });
    check('B is sold 1 on that night', sold[0]?.sold === 1, `sold=${String(sold[0]?.sold)}`);
  }

  /* ---------------------------------------------------------------- 8 */
  console.log('\n8. Authorization on both endpoints.');
  {
    const unauthGet = await call('GET', HORIZON, null);
    check(
      'GET without a session is 401',
      unauthGet.status === 401,
      `HTTP ${String(unauthGet.status)}`,
    );
    const unauthPost = await extend(null, shiftDays(today, 5));
    check(
      'POST without a session is 401',
      unauthPost.status === 401,
      `HTTP ${String(unauthPost.status)}`,
    );

    const clerkGet = await call('GET', HORIZON, clerkCookie);
    check(
      'FRONT_DESK may GET: it holds reservations:read',
      clerkGet.status === 200,
      `HTTP ${String(clerkGet.status)}`,
    );

    const clerkPost = await extend(clerkCookie, shiftDays(today, 45));
    check(
      'FRONT_DESK may NOT POST: it lacks property:settings',
      clerkPost.status === 403,
      `HTTP ${String(clerkPost.status)}`,
    );
    check(
      'the refusal is the typed FORBIDDEN',
      clerkPost.payload?.code === 'FORBIDDEN',
      String(clerkPost.payload?.code),
    );
    check(
      'and the refused POST created nothing',
      // A read-only count, and the one place a range is the natural
      // expression: "nothing at all beyond the current horizon". No delete in
      // this suite uses a range.
      (await inventoryCount({ stayDate: { gt: utcMidnight(shiftDays(today, 39)) } })) === 0,
    );

    /**
     * Cross-property: another property's identifier must be NOT FOUND, never
     * forbidden — a 403 would confirm it exists (CLAUDE.md section 3.2). A
     * seeded code is used as the *subject* of a read-only probe; nothing is
     * written to it, and the expected answer is that it cannot be reached.
     */
    const foreign = await call('GET', '/properties/31001/inventory/horizon', adminCookie);
    check(
      "another property's horizon is 404, never 403",
      foreign.status === 404,
      `HTTP ${String(foreign.status)}`,
    );
    const foreignPost = await call('POST', '/properties/31001/inventory/horizon', adminCookie, {
      throughDate: shiftDays(today, 5),
    });
    check(
      'extending another property is 404, never 403',
      foreignPost.status === 404,
      `HTTP ${String(foreignPost.status)}`,
    );

    // Validation, while we are at the boundary.
    for (const [label, body, expected] of [
      ['a malformed date', { throughDate: '2026-11-7' }, 400],
      ['an impossible date', { throughDate: '2026-02-30' }, 400],
      ['a past date', { throughDate: shiftDays(today, -1) }, 400],
      ['beyond the 730-day cap', { throughDate: shiftDays(today, 731) }, 400],
      ['a missing field', {}, 400],
    ]) {
      const res = await extend(adminCookie, body.throughDate);
      check(
        `${label} is refused ${String(expected)}`,
        res.status === expected,
        `HTTP ${String(res.status)}`,
      );
    }
    check(
      'today itself is accepted at the boundary',
      (await extend(adminCookie, today)).status === 200,
    );
    check(
      'exactly 730 days ahead is accepted',
      (await extend(adminCookie, shiftDays(today, 730))).status === 200,
      'the cap is inclusive of 730',
    );
  }

  /* ---------------------------------------------------------------- 9 */
  console.log('\n9. The audit trail.');
  {
    const audits = await horizonAudits();

    /**
     * EXACTLY one row per successful extension, counted from the responses.
     *
     * `successfulExtensions` is incremented by `extend()` whenever the API
     * answers 200, so this is a derived expectation rather than a hand-counted
     * literal — it cannot drift as tests are added, and it catches both a
     * missing row and a spurious extra one. A `>=` assertion would have
     * tolerated either.
     */
    check(
      'exactly one audit row per successful extension',
      audits.length === successfulExtensions,
      `${String(audits.length)} row(s) vs ${String(successfulExtensions)} successful POST(s)`,
    );
    check(
      'the event is the one the service names',
      audits.length > 0,
      "all rows read back under event = 'INVENTORY_HORIZON_EXTENDED'",
    );
    check(
      'every row is the admin that made the request, not a seeded user',
      audits.every((a) => a.actorUserId === fixture.admin.id),
      `actor=${String(audits[0]?.actorUserId)}`,
    );
    check(
      'every row names the property this suite owns',
      (await prisma.auditLog.count({
        where: { event: 'INVENTORY_HORIZON_EXTENDED', propertyId: fixture.propertyId },
      })) === audits.length,
    );
    check(
      'every row records its requested dates and actual counts',
      audits.every(
        (a) =>
          typeof a.after?.fromDate === 'string' &&
          typeof a.after?.throughDate === 'string' &&
          typeof a.after?.rowsCreated === 'number' &&
          typeof a.after?.roomTypeCount === 'number' &&
          typeof a.after?.dayCount === 'number',
      ),
      'checked on every row, not just the newest',
    );
    check(
      'every fromDate is today, as the service always starts there',
      audits.every((a) => a.after?.fromDate === today),
    );

    const last = audits[audits.length - 1];
    check(
      'the entry records the requested dates',
      typeof last?.after?.fromDate === 'string' && typeof last?.after?.throughDate === 'string',
      `${String(last?.after?.fromDate)}..${String(last?.after?.throughDate)}`,
    );
    check(
      'and the ACTUAL outcome, not the request',
      typeof last?.after?.rowsCreated === 'number' &&
        typeof last?.after?.roomTypeCount === 'number' &&
        typeof last?.after?.dayCount === 'number',
      `rowsCreated=${String(last?.after?.rowsCreated)}`,
    );
    check(
      'the before-state carries the prior horizon',
      last !== undefined && 'fullyConfiguredThrough' in (last.before ?? {}),
      JSON.stringify(last?.before),
    );

    // Cross-check one entry against what the API reported for that call.
    const probe = await extend(adminCookie, shiftDays(today, 730));
    const after = await horizonAudits();
    const newest = after[after.length - 1];
    check(
      'the audit rowsCreated equals what the response reported',
      newest?.after?.rowsCreated === probe.payload?.rowsCreated,
      `audit=${String(newest?.after?.rowsCreated)} response=${String(probe.payload?.rowsCreated)}`,
    );
    check(
      'no audit row names another property',
      (await prisma.auditLog.count({
        where: { event: 'INVENTORY_HORIZON_EXTENDED', propertyId: { not: fixture.propertyId } },
      })) === 0,
    );
  }

  /* ---------------------------------------------------------------- 10 */
  console.log('\n10. UTC boundary handling.');
  {
    const view = await call('GET', HORIZON, adminCookie);
    check(
      'the API reports today as the current UTC calendar date',
      view.payload?.today === todayUtc(),
      `api=${String(view.payload?.today)} suiteUtc=${todayUtc()}`,
    );
    check(
      'maxExtendableThrough is exactly today+730 in UTC',
      view.payload?.maxExtendableThrough === shiftDays(todayUtc(), 730),
      String(view.payload?.maxExtendableThrough),
    );

    /**
     * Every stored date is a pure calendar date at UTC midnight.
     *
     * This is what would break first if the session time zone were not UTC:
     * `${from}::date` on a bound timestamp would resolve a day early or late
     * and the window would shift. `client-factory.ts` sets `-c timezone=UTC`,
     * and this asserts the consequence rather than trusting it.
     */
    const rows = await inventoryRows();
    check(
      'no stored stayDate carries a time component',
      rows.every((r) => r.stayDate.toISOString().endsWith('T00:00:00.000Z')),
      `${String(rows.length)} row(s) checked`,
    );
    check(
      'the earliest stored date is exactly today (UTC), not yesterday or tomorrow',
      isoDate(rows[0].stayDate) === todayUtc(),
      `earliest=${isoDate(rows[0].stayDate)} todayUtc=${todayUtc()}`,
    );
    const tz = await prisma.$queryRaw`SHOW TimeZone`;
    check(
      'the session time zone is UTC, which the ::date casts depend on',
      String(Object.values(tz[0] ?? {})[0]).toUpperCase() === 'UTC',
      String(Object.values(tz[0] ?? {})[0]),
    );
  }

  /* ---------------------------------------------------------------- 11 */
  console.log('\n11. Rollback when a LATER 180-day chunk fails.');
  {
    /**
     * 200 days spans two chunks: [today, today+179] and [today+180, today+200].
     * The sentinel sits at +190, inside the SECOND chunk, so the first chunk
     * has already inserted rows by the time the failure is raised. That is the
     * only arrangement that actually tests rollback rather than a first-
     * statement failure.
     *
     * The suite has already extended to +730, so to make the first chunk
     * insert anything at all this test first removes a band of rows — scoped,
     * as always, to the fixture property and a date range it owns.
     */
    const sentinel = shiftDays(today, 190);
    const throughDate = shiftDays(today, 200);

    /**
     * Clear a band so chunk 1 has real work to do.
     *
     * Enumerated, not a range: every statement names the suite-created
     * `propertyId`, one suite-created `roomTypeId`, and an explicit list of
     * exact `stayDate` values. A `stayDate: { gte, lte }` predicate would be
     * shorter and would still only match fixture rows because of the
     * `propertyId` — but "delete where the date is between" is the shape that
     * one day gets copied to a query whose property filter has been dropped,
     * and an enumerated list cannot be widened by accident.
     */
    const bandDates = [];
    for (let offset = 100; offset <= 200; offset += 1) {
      bandDates.push(utcMidnight(shiftDays(today, offset)));
    }

    let clearedCount = 0;
    for (const roomTypeId of [fixture.categoryA, fixture.categoryB]) {
      const gone = await prisma.inventoryDay.deleteMany({
        where: {
          propertyId: fixture.propertyId,
          roomTypeId,
          stayDate: { in: bandDates },
        },
      });
      clearedCount += gone.count;
    }
    const cleared = { count: clearedCount };
    note(
      `cleared ${String(cleared.count)} fixture rows across +100..+200 ` +
        `(2 categories x ${String(bandDates.length)} enumerated dates) so chunk 1 has work`,
    );

    const rowsBefore = await inventoryRows();
    const auditsBefore = await horizonAudits();
    const countBefore = rowsBefore.length;

    let elapsedMs = -1;
    const res = await withBlockedKey(fixture.categoryB, sentinel, async () => {
      note(
        `awaiting the service deadline (${String(TRANSACTION_TIMEOUT_MS)} ms) — this is slow by design`,
      );
      /**
       * Timed, and bounded.
       *
       * The elapsed time is what distinguishes a real rollback from an
       * immediate 5xx; the client budget stops a hung server from hanging the
       * suite. Deliberately NOT through `extend()`: this request is expected
       * to fail, and counting it would corrupt the audit expectation it exists
       * to test.
       */
      const startedAt = Date.now();
      const response = await call(
        'POST',
        HORIZON,
        adminCookie,
        { throughDate },
        {
          timeoutMs: ROLLBACK_REQUEST_TIMEOUT_MS,
        },
      );
      elapsedMs = Date.now() - startedAt;
      return response;
    });

    /**
     * Everything below runs AFTER `withBlockedKey` returned, which means its
     * `finally` has already released the blocker, awaited its rollback and
     * disconnected. So both transactions are definitively over before any
     * assertion reads the database — a read taken while either was still open
     * would prove nothing about what was committed.
     */
    check(
      'the blocker itself did not fail for an unrelated reason',
      blockerFault === null,
      blockerFault === null ? 'blocker behaved as designed' : `blocker fault: ${blockerFault}`,
    );

    /**
     * WHY THE FAILURE WAS THE TRANSACTION DEADLINE, and not something else.
     *
     * Each alternative is excluded by a separate fact, because "it returned
     * 5xx" on its own would be satisfied by a stale build, a bad cookie or a
     * dead database just as well as by the rollback this test exists to prove:
     *
     *   * stale API      — `assertRouteIsLoaded()` already refused on 404, and
     *                      ten earlier extensions answered 200 on this route;
     *   * authentication — the same `adminCookie` succeeded moments earlier and
     *                      succeeds again on the retry below; a rejected cookie
     *                      is 401, not 5xx;
     *   * validation     — the identical `throughDate` is accepted on the retry,
     *                      so it is inside the cap and well formed; a refusal
     *                      would be 400;
     *   * unrelated DB failure — the suite keeps reading and writing the same
     *                      database immediately afterwards, including the retry
     *                      that succeeds;
     *   * blocker malfunction — asserted directly above.
     *
     * What remains is the one condition this test arranged: chunk 2 waiting on
     * an uncommitted conflicting key until the service's own deadline expired.
     */
    /**
     * THE FALSE-POSITIVE GUARD.
     *
     * What this establishes: the request spent roughly the service's whole
     * transaction budget inside the server. Nothing that fails immediately —
     * pool acquisition (`maxWait`), a crashed or restarting worker, a startup
     * error, a connection refusal — can take that long. Those all return in
     * milliseconds while producing the *same* signature as a genuine rollback
     * (5xx, empty band, retry succeeds), because chunk 1 never ran and "no
     * rows survived" is then vacuously true. This assertion is what stops such
     * a run being reported as a passing rollback test.
     *
     * What it does NOT establish: that the wait was specifically the
     * `spectoken` speculative-insertion wait on the sentinel key. Elapsed time
     * cannot identify a wait event, and the response body deliberately carries
     * no database internals (asserted below). Any ~20 s server-side stall
     * would satisfy it. The attribution to the sentinel key rests on the other
     * facts in this test — the blocker held exactly that key, the band is
     * empty, the identical request succeeds once the blocker is gone — and on
     * PostgreSQL 17.6's documented behaviour quoted in this file's header.
     */
    check(
      `the request took at least ${String(ROLLBACK_ELAPSED_FLOOR_MS)} ms, so it waited rather than failing fast`,
      elapsedMs >= ROLLBACK_ELAPSED_FLOOR_MS,
      `elapsed ${String(elapsedMs)} ms vs floor ${String(ROLLBACK_ELAPSED_FLOOR_MS)} ms ` +
        `(service deadline ${String(TRANSACTION_TIMEOUT_MS)} ms)`,
    );
    check(
      'and it returned before the client budget, so the server answered',
      elapsedMs > 0 && elapsedMs < ROLLBACK_REQUEST_TIMEOUT_MS,
      `elapsed ${String(elapsedMs)} ms, budget ${String(ROLLBACK_REQUEST_TIMEOUT_MS)} ms`,
    );

    check('the extension did not report success', res.status >= 400, `HTTP ${String(res.status)}`);
    check(
      'the failure is a server-side fault, not a 4xx refusal',
      res.status >= 500,
      `HTTP ${String(res.status)} — a 400/401/403 would mean validation or auth, not a timeout`,
    );
    check(
      'no partial success was reported to the caller',
      res.payload?.rowsCreated === undefined,
      JSON.stringify(res.payload).slice(0, 80),
    );
    check(
      'no database internals leaked in the refusal',
      !/P20\d\d|SQLSTATE|INSERT INTO|inventory_day/i.test(JSON.stringify(res.payload ?? {})),
      JSON.stringify(res.payload ?? {}).slice(0, 80),
    );

    /**
     * The rollback proof, on a FRESH read.
     *
     * `$queryRaw` on a new statement rather than reusing `rowsBefore`'s client
     * state, and every row re-fetched. The band was emptied before the attempt,
     * so chunk 1 MUST have inserted into +100..+179 before chunk 2 blocked. If
     * those rows are absent now, work the first chunk had already done was
     * discarded — which only a transaction rollback does.
     */
    const bandRemaining = await prisma.inventoryDay.count({
      where: { propertyId: fixture.propertyId, stayDate: { in: bandDates } },
    });
    check(
      'EVERY row in the cleared band is still absent after rollback',
      bandRemaining === 0,
      `${String(bandRemaining)} row(s) found; chunk 1 covered +100..+179 and inserted before the failure`,
    );

    const rowsAfter = await inventoryRows();
    check(
      'the total row count is unchanged',
      rowsAfter.length === countBefore,
      `${String(rowsAfter.length)} vs ${String(countBefore)} before`,
    );
    check(
      'and the surviving rows are byte-identical to the pre-attempt state',
      JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter),
      'nothing was added, removed or rewritten',
    );
    check(
      'the sentinel row was never committed by the blocker',
      (await inventoryCount({
        roomTypeId: fixture.categoryB,
        stayDate: utcMidnight(sentinel),
      })) === 0,
      'the blocking transaction rolled back too',
    );

    const auditsAfter = await horizonAudits();
    check(
      'NO success audit record remains',
      auditsAfter.length === auditsBefore.length,
      `${String(auditsAfter.length)} vs ${String(auditsBefore.length)} before`,
    );
    check(
      'and the derived counter still matches, so no row was silently gained',
      auditsAfter.length === successfulExtensions,
      `${String(auditsAfter.length)} row(s) vs ${String(successfulExtensions)} successful POST(s)`,
    );
    check(
      'and no audit row mentions the failed throughDate',
      auditsAfter.every((a) => a.after?.throughDate !== throughDate),
      throughDate,
    );

    /**
     * With the blocker gone the identical request must now succeed. This is
     * what proves the failure was induced rather than inherent in the range,
     * and that the rollback left nothing behind to collide with.
     */
    const retry = await extend(adminCookie, throughDate);
    check(
      'the same request succeeds once the induced failure is removed',
      retry.status === 200,
      `HTTP ${String(retry.status)}`,
    );
    check(
      'and it creates the whole cleared band, proving nothing was left behind',
      retry.payload?.rowsCreated === cleared.count,
      `created=${String(retry.payload?.rowsCreated)} cleared=${String(cleared.count)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Teardown                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Remove everything this process created, from whatever stage it reached.
 *
 * ===========================================================================
 * Drives off `owned`, not off `fixture`. `owned.propertyId` is set the instant
 * the property row exists, so this works after a throw at ANY setup stage:
 * after the property but before the users, after one user but not the second,
 * after the categories but before the rooms. There is no stage at which a
 * created resource is invisible to this function.
 *
 * Two independent ownership assertions before anything is deleted:
 *   1. the id is one this process recorded (it cannot be anything else — it is
 *      only ever written from a `create` result, never from a lookup);
 *   2. the row still carries the suite's `ZZINVH` code.
 * Either failing means refuse and report, never guess.
 *
 * `dropProperty` is scoped to `propertyId` on every statement. That is the
 * whole-property cascade, which is correct here because the property itself is
 * going; the three-key rule applies to the *targeted* inventory operations in
 * the tests, which name `propertyId` + `roomTypeId` + an exact `stayDate` and
 * never a date range.
 * ===========================================================================
 */
async function teardown() {
  if (owned.propertyId === null) {
    // Nothing was created, so there is nothing to remove. Said out loud
    // because silence here used to mean "leaked" rather than "clean".
    console.log('\nTeardown: nothing was created, nothing to remove.');
    return;
  }

  const row = await prisma.property.findUnique({
    where: { id: owned.propertyId },
    select: { id: true, code: true },
  });

  if (row === null) {
    console.log(
      `\nTeardown: property ${String(owned.propertyCode)} is already gone; ` +
        'removing any orphaned harness users.',
    );
  } else if (!row.code.startsWith(FIXTURE_PREFIX)) {
    // Unreachable unless `owned` was corrupted, and precisely the case where
    // guessing would be unforgivable.
    throw new Error(
      `REFUSING to clean up: ${owned.propertyId} has code "${row.code}", which is ` +
        `not a ${FIXTURE_PREFIX} fixture. Nothing was deleted. Investigate by hand.`,
    );
  } else {
    const rows = await prisma.inventoryDay.count({ where: { propertyId: owned.propertyId } });
    await dropProperty(owned.propertyId);
    console.log(
      `\nTeardown: removed ${row.code} with ${String(rows)} inventory row(s), ` +
        'its categories, rooms, stays, folios, audit rows and grants.',
    );
  }

  /**
   * The harness users, last and individually.
   *
   * `propertyRoles: { none: {} }` is the safety: a user is only removed once
   * its last grant is gone with the property, so this can never delete an
   * account that still has access to something. Each id came from a `create`
   * in this run.
   */
  let removedUsers = 0;
  for (const userId of owned.userIds) {
    const gone = await prisma.user.deleteMany({
      where: { id: userId, propertyRoles: { none: {} } },
    });
    removedUsers += gone.count;
  }
  if (owned.userIds.length > 0) {
    console.log(
      `  removed ${String(removedUsers)} of ${String(owned.userIds.length)} harness user(s)`,
    );
  }
}

/* -------------------------------------------------------------------------- */

try {
  await run();
} catch (error) {
  failures += 1;
  console.error(`\nThe suite stopped: ${String(error?.message ?? error)}`);
} finally {
  try {
    await teardown();
  } catch (error) {
    failures += 1;
    console.error(`Teardown failed: ${String(error?.message ?? error)}`);
    if (fixture !== null) {
      console.error(
        `  Fixture property left behind: ${fixture.propertyCode} / ${fixture.propertyId}`,
      );
    }
  }
  await prisma.$disconnect();
}

console.log('');
if (failures === 0) {
  console.log('All inventory horizon integration checks passed.');
} else {
  console.error(`${String(failures)} check(s) FAILED.`);
  process.exit(1);
}
