/**
 * Shared fixture scaffolding for the room / room-type integration suites.
 *
 * ===========================================================================
 * WHY SHARED, when `inventory-horizon.test.mjs` and `create-race.test.mjs`
 * each carry their own copy.
 *
 * Those two differ in what they build and in how they must tear it down. The
 * four room suites do not: each needs one property, a few users at known
 * roles, two categories and some rooms, and each must then delete exactly
 * those and nothing else. Replicating ~250 lines of ownership and cleanup
 * logic four times would mean four places for a cleanup bug to live, and a
 * cleanup bug is the one defect in a test suite that can damage data it does
 * not own.
 *
 * So the dangerous half is written once and parameterised by prefix, and each
 * suite keeps its own assertions. This is the same reasoning that already puts
 * the database-identity guard in `test/support/isolation-guard.mjs` rather
 * than in every suite.
 *
 * WHAT IS NOT SHARED, deliberately: the prefix, the slug prefix and the email
 * domain. Each suite passes its own, so two suites can never see each other's
 * fixtures and a sweep for one can never match the other's.
 *
 * OWNERSHIP IS RECORDED AS IT IS ACQUIRED, never discovered by lookup. Every
 * id in `owned` came from a `create` in this process; nothing is ever read
 * from the database into it, so a seeded row cannot enter it and cleanup can
 * only ever name rows this run made.
 * ===========================================================================
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { assertIsolatedDatabase, apiMismatchMessage } from './isolation-guard.mjs';

const DAY_MS = 86_400_000;

export const isoDate = (date) => date.toISOString().slice(0, 10);
export const utcMidnight = (iso) => new Date(`${iso}T00:00:00.000Z`);
export const todayUtc = () => isoDate(new Date());
export function shiftDays(iso, days) {
  return isoDate(new Date(utcMidnight(iso).getTime() + days * DAY_MS));
}

/**
 * Refuse to run without an explicit target.
 *
 * No default and no `.env` lookup: these suites create a property and delete
 * it again, so they will not guess which database receives that.
 */
export function requireEnvironment(suiteName) {
  if (!process.env.DATABASE_URL) {
    console.error(
      `DATABASE_URL is not set.\n` +
        `There is no default and no .env lookup: ${suiteName} creates a property and\n` +
        `deletes it again, so it will not guess a target. Set it explicitly to a\n` +
        `disposable test database.`,
    );
    process.exit(1);
  }
  if (!process.env.EASEIT_API_URL) {
    console.error(
      `EASEIT_API_URL is not set.\n` +
        `There is no default: :4000 is the shared development API, and assuming a\n` +
        `port is assuming which stack this suite exercises. Point it at an API\n` +
        `running against the SAME isolated database.`,
    );
    process.exit(1);
  }
  return { API: process.env.EASEIT_API_URL };
}

/** The role templates a suite may ask for, by `RoleKey`. */
const ROLE_KEYS = ['PROPERTY_ADMIN', 'FRONT_DESK', 'HOUSEKEEPING', 'REVENUE_MANAGER'];

export function createHarness({ suiteName, prefix, slugPrefix, emailDomain, prisma }) {
  if (!prefix || !slugPrefix || !emailDomain) {
    throw new Error('createHarness needs prefix, slugPrefix and emailDomain.');
  }

  const API = process.env.EASEIT_API_URL;

  /** Recorded as acquired. Teardown drives off THIS, never off `fixture`. */
  const owned = {
    propertyId: null,
    propertyCode: null,
    userIds: [],
    roomTypeIds: [],
    roomIds: [],
    reservationIds: [],
  };

  let failures = 0;

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

  /**
   * A session cookie, signed with the API's own secret.
   *
   * Read from `apps/api/.env` rather than passed in: the point is to mint a
   * token the running API will accept, and the API's secret is the only thing
   * that defines that.
   */
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
    const token = `${input}.${createHmac('sha256', secret).update(input, 'utf8').digest('base64url')}`;
    return `easeit_session=${token}`;
  }

  async function call(method, path, cookie, body, options = {}) {
    const { timeoutMs } = options;
    const started = Date.now();

    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(cookie === null || cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload, elapsedMs: Date.now() - started };
  }

  /* ---------------------------------------------------------------------- */
  /*  Identity guards — the suite refuses to run without them               */
  /* ---------------------------------------------------------------------- */

  async function guardDatabase() {
    const extra = [process.env.EASEIT_TEST_DB, process.env.EASEIT_TEST_DBS]
      .filter(Boolean)
      .join(',');
    const confirmed = await assertIsolatedDatabase({
      prisma,
      suite: suiteName,
      env: { ...process.env, EASEIT_TEST_DBS: extra },
    });
    return confirmed.liveName;
  }

  /**
   * Assert from the SERVER that this is easeit_test.
   *
   * `assertIsolatedDatabase` already classifies the connection string; this
   * asks PostgreSQL what database it actually opened, which is the only answer
   * that cannot be wrong about itself.
   */
  async function assertLiveDatabaseIsTest() {
    const rows = await prisma.$queryRaw`SELECT current_database() AS db`;
    const live = rows[0]?.db;
    if (live !== 'easeit_test') {
      throw new Error(
        `REFUSING TO RUN: the server reports current_database() = "${String(live)}". ` +
          'These suites run against easeit_test only. Nothing was created.',
      );
    }
    return live;
  }

  /**
   * Are the room routes loaded in the API we are pointed at?
   *
   * `SessionAuthGuard` is attached at the controller class, so a registered
   * route answers an unauthenticated request with 401. A 404 means the running
   * process was built before these controllers existed — a different failure
   * with the opposite remedy from a database mismatch, and the two are
   * indistinguishable once fixtures start failing.
   */
  async function assertRoutesAreLoaded(paths) {
    for (const path of paths) {
      const probe = await call('GET', path, null);
      if (probe.status === 401) continue;
      if (probe.status === 404) {
        throw new Error(
          `REFUSING TO RUN: the API at ${API} has no route for ${path}.\n` +
            '  An unauthenticated request returned 404; a registered route would\n' +
            '  return 401, because SessionAuthGuard rejects it before resolving a\n' +
            '  property. The running process predates these controllers.\n' +
            '  Fix: restart the API serving this port. This suite does not restart it.',
        );
      }
      throw new Error(
        `REFUSING TO RUN: an unauthenticated probe of ${path} answered HTTP ` +
          `${String(probe.status)}. Expected 401 (loaded) or 404 (stale build).`,
      );
    }
    note(`room routes are loaded (401 from the auth guard on ${String(paths.length)} probe(s))`);
  }

  /** The API must be reading the database this suite just wrote to. */
  async function assertApiSharesDatabase(fixture, cookie, isolatedDb) {
    const probe = await call('GET', `/properties/${fixture.propertyCode}/room-types`, cookie);
    if (probe.status !== 200) {
      throw new Error(
        apiMismatchMessage({
          api: API,
          propertyId: fixture.propertyId,
          status: probe.status,
          isolatedDb,
        }),
      );
    }
    note(`API and suite share ${isolatedDb}; room-types probe answered 200`);
  }

  /* ---------------------------------------------------------------------- */
  /*  Fixtures                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Remove anything a previous interrupted run of THIS suite left behind.
   *
   * Matched on this suite's own prefix, so it can never touch another suite's
   * fixtures or a seeded property.
   */
  async function sweepLeftovers() {
    const stale = await prisma.property.findMany({
      where: { code: { startsWith: prefix } },
      select: { id: true, code: true },
    });
    for (const property of stale) {
      await dropProperty(property.id);
      console.log(`  swept leftover fixture ${property.code}`);
    }

    const orphans = await prisma.user.deleteMany({
      where: { email: { endsWith: `@${emailDomain}` }, propertyRoles: { none: {} } },
    });
    if (orphans.count > 0) {
      console.log(`  swept ${String(orphans.count)} leftover harness user(s)`);
    }
  }

  /**
   * Delete one suite-owned property and everything hanging off it.
   *
   * Deletion order comes from the real schema: `ReservationRoom.roomType` and
   * `.room` are `onDelete: Restrict` and `Room.roomType` is `Restrict`, so
   * stays go before rooms and rooms before categories. Every statement is
   * scoped by `propertyId`; there is no unscoped delete here.
   */
  async function dropProperty(propertyId) {
    const scope = { propertyId };
    await prisma.$transaction(
      async (tx) => {
        await tx.folioLine.deleteMany({ where: { folio: { propertyId } } });
        await tx.folio.deleteMany({ where: scope });
        // Redemptions RESTRICT the reservation they consumed, so they go first.
        await tx.promotionRedemption.deleteMany({ where: scope });
        await tx.reservationGuest.deleteMany({ where: scope });
        await tx.reservationRoom.deleteMany({ where: scope });
        await tx.reservation.deleteMany({ where: scope });
        // Blocks reference rooms and room types with RESTRICT, so they go first.
        await tx.roomBlock.deleteMany({ where: scope });
        // Promotions and rate plans reference room types (and each other) with
        // RESTRICT; plans cascade to their assignments, days, rules and prices.
        await tx.promoCode.deleteMany({ where: scope });
        await tx.promotionRoomType.deleteMany({ where: scope });
        await tx.promotionRatePlan.deleteMany({ where: scope });
        await tx.promotion.deleteMany({ where: scope });
        // Derived plans RESTRICT their parent, checked per row: unlink first.
        await tx.ratePlan.updateMany({
          where: scope,
          data: { parentRatePlanId: null, derivationKind: null, derivationValue: null },
        });
        await tx.ratePlan.deleteMany({ where: scope });
        await tx.room.deleteMany({ where: scope });
        await tx.inventoryDay.deleteMany({ where: scope });
        await tx.roomType.deleteMany({ where: scope });
        await tx.auditLog.deleteMany({ where: scope });
        await tx.outboxEvent.deleteMany({ where: scope });
        await tx.userPropertyRole.deleteMany({ where: scope });
        await tx.propertySettings.deleteMany({ where: scope });
        await tx.property.delete({ where: { id: propertyId } });
      },
      { timeout: 60_000 },
    );
  }

  /**
   * One property, the requested users, two categories and the requested rooms.
   *
   * `roles` names which users to make, keyed by label. Each gets exactly one
   * grant, so a permission assertion is about that role and nothing else.
   */
  async function buildFixture({ roles, rooms: roomSpecs, propertyStatus = 'ACTIVE' }) {
    const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
      .toString(36)
      .padStart(2, '0')}`
      .toUpperCase()
      .slice(-7);
    const code = `${prefix}${runId}`;
    const today = todayUtc();

    const roleRows = {};
    for (const key of new Set(Object.values(roles))) {
      if (!ROLE_KEYS.includes(key)) throw new Error(`unknown role key ${key}`);
      const row = await prisma.role.findFirst({
        where: { key, propertyId: null },
        select: { id: true },
      });
      if (row === null) throw new Error(`global ${key} role template is missing.`);
      roleRows[key] = row.id;
    }

    const property = await prisma.property.create({
      data: {
        slug: `${slugPrefix}${runId.toLowerCase()}`,
        code,
        name: `ZZ ${suiteName} ${runId}`,
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        businessDate: utcMidnight(today),
        status: propertyStatus,
      },
      select: { id: true, code: true },
    });

    // Recorded before anything else exists, so a throw from here on is
    // recoverable by teardown rather than a silent leak.
    owned.propertyId = property.id;
    owned.propertyCode = property.code;

    const users = {};
    for (const [label, key] of Object.entries(roles)) {
      const user = await prisma.user.create({
        data: {
          email: `${label}-${runId.toLowerCase()}@${emailDomain}`,
          passwordHash: 'not-a-usable-hash',
          firstName: 'Harness',
          lastName: label,
          isActive: true,
          isTwoFactorEnabled: false,
        },
        select: { id: true, email: true },
      });
      owned.userIds.push(user.id);
      await prisma.userPropertyRole.create({
        data: { userId: user.id, propertyId: property.id, roleId: roleRows[key] },
      });
      users[label] = { ...user, cookie: mintSession(user.id, user.email), roleKey: key };
    }

    const makeType = async (suffix, name, rate, order) => {
      const row = await prisma.roomType.create({
        data: {
          propertyId: property.id,
          code: `${prefix}${suffix}`,
          name: `ZZ ${name} ${runId}`,
          baseRateMinor: rate,
          currency: 'INR',
          maxGuests: 2,
          sortOrder: order,
        },
        select: { id: true, code: true },
      });
      owned.roomTypeIds.push(row.id);
      return row;
    };

    const categoryA = await makeType('A', 'Category A', 500000, 1);
    const categoryB = await makeType('B', 'Category B', 400000, 2);

    const roomsByLabel = {};
    for (const spec of roomSpecs ?? []) {
      const row = await prisma.room.create({
        data: {
          propertyId: property.id,
          roomTypeId: spec.category === 'B' ? categoryB.id : categoryA.id,
          number: `${prefix}-${spec.label}`,
          status: spec.status,
        },
        select: { id: true, number: true, status: true, roomTypeId: true },
      });
      owned.roomIds.push(row.id);
      roomsByLabel[spec.label] = row;
    }

    const fixture = {
      propertyId: property.id,
      propertyCode: property.code,
      runId,
      users,
      categoryA: categoryA.id,
      categoryACode: categoryA.code,
      categoryB: categoryB.id,
      categoryBCode: categoryB.code,
      rooms: roomsByLabel,
      today,
    };

    note(
      `fixture ${property.code}=${property.id}; A=${categoryA.id} B=${categoryB.id}; ` +
        Object.entries(users)
          .map(([label, user]) => `${label}=${user.id}`)
          .join(' '),
    );
    return fixture;
  }

  /**
   * Create an in-house stay occupying one room, directly in the database.
   *
   * Direct rather than through check-in: the status suite needs the
   * `reservation_room.status = CHECKED_IN` row that the room-status endpoint
   * reads, and driving a real check-in would also post a folio and touch
   * inventory, which is a different suite's subject.
   */
  async function createInHouseStay(fixture, room) {
    const arrival = fixture.today;
    const departure = shiftDays(fixture.today, 3);

    const reservation = await prisma.reservation.create({
      data: {
        propertyId: fixture.propertyId,
        confirmationCode: `${prefix}-${fixture.runId}-1`,
        status: 'CHECKED_IN',
        arrivalDate: utcMidnight(arrival),
        departureDate: utcMidnight(departure),
        guestFirstName: 'Harness',
        guestLastName: 'Guest',
        currency: 'INR',
        totalAmountMinor: 500000,
      },
      select: { id: true, confirmationCode: true },
    });
    owned.reservationIds.push(reservation.id);

    await prisma.reservationRoom.create({
      data: {
        propertyId: fixture.propertyId,
        reservationId: reservation.id,
        roomTypeId: room.roomTypeId,
        roomId: room.id,
        arrivalDate: utcMidnight(arrival),
        departureDate: utcMidnight(departure),
        status: 'CHECKED_IN',
      },
      select: { id: true },
    });

    note(`in-house stay ${reservation.confirmationCode} occupies room ${room.number}`);
    return reservation;
  }

  /**
   * Prove the suite owns the property before anything destructive runs.
   *
   * Three independent facts, all required: the id is one this process created,
   * the code carries this suite's prefix, and the slug carries this suite's
   * slug prefix. If any fails the suite stops rather than deleting something
   * it may not own.
   */
  async function assertOwnership(fixture, expected) {
    const row = await prisma.property.findUnique({
      where: { id: fixture.propertyId },
      select: { id: true, code: true, slug: true },
    });
    if (row === null) throw new Error('the fixture property is not in the database.');
    if (row.id !== owned.propertyId) {
      throw new Error('the fixture property id is not the one this process recorded.');
    }
    if (!row.code.startsWith(prefix)) {
      throw new Error(`refusing to proceed: ${row.code} is not a ${prefix} fixture.`);
    }
    if (!row.slug.startsWith(slugPrefix)) {
      throw new Error(`refusing to proceed: slug ${row.slug} is not a suite fixture.`);
    }

    const [types, rooms, grants, stays] = await Promise.all([
      prisma.roomType.count({ where: { propertyId: fixture.propertyId } }),
      prisma.room.count({ where: { propertyId: fixture.propertyId } }),
      prisma.userPropertyRole.count({ where: { propertyId: fixture.propertyId } }),
      prisma.reservation.count({ where: { propertyId: fixture.propertyId } }),
    ]);
    const shape = { types, rooms, grants, stays };
    for (const [key, want] of Object.entries(expected)) {
      if (shape[key] !== want) {
        throw new Error(
          `refusing to proceed: unexpected fixture shape — ${key}=${String(shape[key])}, ` +
            `expected ${String(want)}. Full shape: ${JSON.stringify(shape)}`,
        );
      }
    }

    check('ownership proven before any destructive step', true, `${row.code} / ${row.id}`);
  }

  /** Remove exactly what this run created, by recorded id, nothing else. */
  async function teardown() {
    if (owned.propertyId === null) {
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
    } else if (!row.code.startsWith(prefix)) {
      // Unreachable unless `owned` was corrupted, and exactly the case where
      // guessing would be unforgivable.
      throw new Error(
        `REFUSING to clean up: ${owned.propertyId} has code "${row.code}", which is not ` +
          `a ${prefix} fixture. Nothing was deleted. Investigate by hand.`,
      );
    } else {
      await dropProperty(owned.propertyId);
      console.log(`\nTeardown: removed ${row.code} with its categories, rooms, stays and grants.`);
    }

    let removed = 0;
    for (const userId of owned.userIds) {
      const gone = await prisma.user.deleteMany({
        where: { id: userId, propertyRoles: { none: {} } },
      });
      removed += gone.count;
    }
    if (owned.userIds.length > 0) {
      console.log(
        `  removed ${String(removed)} of ${String(owned.userIds.length)} harness user(s)`,
      );
    }
  }

  return {
    API,
    owned,
    prefix,
    check,
    note,
    call,
    mintSession,
    guardDatabase,
    assertLiveDatabaseIsTest,
    assertRoutesAreLoaded,
    assertApiSharesDatabase,
    sweepLeftovers,
    buildFixture,
    createInHouseStay,
    assertOwnership,
    dropProperty,
    teardown,
    failureCount: () => failures,
    addFailure: () => {
      failures += 1;
    },
  };
}

/** Standard entry point: run, tear down whatever happened, exit on failure. */
export async function runSuite({ harness, prisma, label, body }) {
  try {
    await body();
  } catch (error) {
    harness.addFailure();
    console.error(`\nThe suite stopped: ${String(error?.message ?? error)}`);
  } finally {
    try {
      await harness.teardown();
    } catch (error) {
      harness.addFailure();
      console.error(`Teardown failed: ${String(error?.message ?? error)}`);
      if (harness.owned.propertyId !== null) {
        console.error(
          `  Fixture left behind: ${String(harness.owned.propertyCode)} / ` +
            `${String(harness.owned.propertyId)}`,
        );
      }
    }
    await prisma.$disconnect();
  }

  console.log('');
  if (harness.failureCount() === 0) {
    console.log(`All ${label} checks passed.`);
  } else {
    console.error(`${String(harness.failureCount())} ${label} check(s) FAILED.`);
    process.exit(1);
  }
}
