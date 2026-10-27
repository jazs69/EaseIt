/**
 * The cancellation suite.
 *
 * ===========================================================================
 * The risk here is the opposite of overselling, and no constraint catches it.
 *
 * `inventory_day_not_oversold` refuses a transaction that sells too much. It
 * says nothing about one that *releases* too much: `sold = 2` is perfectly
 * legal when the truth is 3, so a decrement that runs twice silently invents a
 * room. Every assertion about counters below exists because the database
 * cannot make that one for us.
 *
 * Runs against the real Postgres with the real constraints, through the real
 * HTTP endpoint, like the race and check-in suites beside it — an in-memory
 * fake proves nothing about `FOR UPDATE`, the partial GiST exclusion, or the
 * `reservation_cancelled_at_matches_status` CHECK.
 *
 * What it asserts, in order: a confirmed stay gives every night back exactly
 * once; the counters stay inside the oversell invariant; the room number
 * becomes re-sellable, proven by booking it again; a repeat cancellation
 * releases nothing further; N concurrent cancellations produce exactly one
 * transition and one decrement per night; a status that never consumed
 * inventory does not decrement; a checked-in stay is refused with a typed
 * domain error and leaves no audit row behind; another property's reservation
 * 404s rather than 403s; a grant without `reservations:edit` is refused 403 and
 * changes nothing; the audit row and the status change commit together; and no
 * folio or folio line is touched by any of it.
 *
 * Everything it creates is removed in teardown, including on failure. Nights
 * released by a cancellation are NOT released again there — doing so would
 * reintroduce the exact double-decrement this suite exists to rule out.
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
  console.error('DATABASE_URL is not set and no .env was found. Run pnpm db:seed first.');
  process.exit(1);
}

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;

const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4000/api/v1';
const PROPERTY_CODE = process.env.EASEIT_PROPERTY ?? '31001';

const prisma = createPrismaClient();

/** Everything this suite made, for teardown. */
const created = [];
/** Reservations whose nights a cancellation already gave back. */
const releasedByCancel = new Set();
/** Room statuses to put back. */
const restoreRooms = [];

let failures = 0;

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
    exp: now + 900,
  })}`;

  return `${input}.${createHmac('sha256', secret).update(input, 'utf8').digest('base64url')}`;
}

const isoDate = (date) => date.toISOString().slice(0, 10);

function shiftDays(iso, days) {
  return isoDate(new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + days * 86_400_000));
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
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/** `sold` per night for a category, as a map keyed by `YYYY-MM-DD`. */
async function soldByDate(propertyId, roomTypeId, arrival, departure) {
  const rows = await prisma.inventoryDay.findMany({
    where: {
      propertyId,
      roomTypeId,
      stayDate: {
        gte: new Date(`${arrival}T00:00:00.000Z`),
        lt: new Date(`${departure}T00:00:00.000Z`),
      },
    },
    select: { stayDate: true, sold: true, blocked: true, physical: true, overbookingAllowance: true },
    orderBy: { stayDate: 'asc' },
  });

  return new Map(rows.map((row) => [isoDate(row.stayDate), row]));
}

/** The oversell invariant, and non-negativity, across the whole property. */
async function inventoryViolations(propertyId) {
  const rows = await prisma.$queryRaw`
    SELECT count(*) FILTER (
             WHERE "sold" + "blocked" > "physical" + "overbookingAllowance"
           ) AS oversold,
           count(*) FILTER (WHERE "sold" < 0 OR "blocked" < 0) AS negative
    FROM inventory_day
    WHERE "propertyId" = ${propertyId}::uuid
  `;
  return { oversold: Number(rows[0].oversold), negative: Number(rows[0].negative) };
}

/**
 * A fingerprint of every folio and folio line at this property.
 *
 * Cancellation must not touch money. A count alone could hide an edit, so the
 * amounts are in the digest.
 */
async function financialFingerprint(propertyId) {
  const rows = await prisma.$queryRaw`
    SELECT (SELECT count(*) FROM folio WHERE "propertyId" = ${propertyId}::uuid) AS folios,
           (SELECT count(*) FROM folio_line WHERE "propertyId" = ${propertyId}::uuid) AS lines,
           (SELECT md5(coalesce(string_agg(
                    id || ':' || "amountMinor" || ':' || currency, ',' ORDER BY id), ''))
              FROM folio_line WHERE "propertyId" = ${propertyId}::uuid) AS line_digest
  `;
  const row = rows[0];
  return {
    folios: Number(row.folios),
    lines: Number(row.lines),
    digest: row.line_digest,
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

async function createBooking(cookie, roomType, arrival, departure, overrides = {}) {
  const response = await call('POST', `/properties/${PROPERTY_CODE}/reservations`, cookie, {
    roomTypeId: roomType.id,
    roomId: null,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Cancel', lastName: 'Probe' }],
    isInstantCheckIn: false,
    ...overrides,
  });

  if (response.status !== 201) {
    throw new Error(
      `fixture booking failed: ${response.status} ${JSON.stringify(response.payload)}`,
    );
  }
  created.push(response.payload.id);
  return response.payload;
}

/** A category with at least `headroom` sellable units on every night. */
async function findSellableRoomType(propertyId, arrival, departure, headroom = 1) {
  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId, rooms: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const nights = Math.round(
    (new Date(`${departure}T00:00:00.000Z`) - new Date(`${arrival}T00:00:00.000Z`)) / 86_400_000,
  );

  for (const roomType of roomTypes) {
    const days = await soldByDate(propertyId, roomType.id, arrival, departure);
    if (days.size !== nights) continue;
    const free = [...days.values()].every(
      (day) => day.physical + day.overbookingAllowance - day.sold - day.blocked >= headroom,
    );
    if (free) return roomType;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The suite                                                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  // `reservations:edit` is what the endpoint requires; the grant alone is not
  // enough, which is the same shape the check-in suite uses.
  const grant = await prisma.userPropertyRole.findFirst({
    where: {
      property: { code: PROPERTY_CODE },
      role: { key: { in: ['PROPERTY_ADMIN', 'FRONT_DESK'] } },
    },
    select: {
      user: { select: { id: true, email: true } },
      property: { select: { id: true, code: true, name: true, businessDate: true } },
    },
  });

  if (grant === null) {
    throw new Error(`no front-desk grant at property ${PROPERTY_CODE}. Run pnpm db:seed first.`);
  }

  const { user, property } = grant;
  const cookie = `easeit_session=${mintSession(user.id, user.email)}`;
  const businessDate = isoDate(property.businessDate);

  console.log(`Property ${property.code} (${property.name})`);
  console.log(`  business date ${businessDate}, acting as ${user.email}\n`);

  /* ------------------------------------------------------------------ 1-3 */
  console.log('1. A confirmed stay releases every night, once.');

  const arrival = shiftDays(businessDate, 2);
  const departure = shiftDays(businessDate, 5);
  const roomType = await findSellableRoomType(property.id, arrival, departure);
  if (roomType === null) throw new Error('no category has room for the probe stay.');

  // A room number, so the exclusion constraint is exercised rather than
  // skipped: an unassigned stay has a NULL roomId and never conflicts.
  const room = await prisma.room.findFirst({
    where: { propertyId: property.id, roomTypeId: roomType.id, status: { not: 'OUT_OF_ORDER' } },
    select: { id: true, number: true },
    orderBy: { number: 'asc' },
  });
  if (room === null) throw new Error('no room to assign for the re-sell check.');

  const soldBefore = await soldByDate(property.id, roomType.id, arrival, departure);
  const booking = await createBooking(cookie, roomType, arrival, departure, { roomId: room.id });
  const soldAfterBooking = await soldByDate(property.id, roomType.id, arrival, departure);

  const nights = [...soldBefore.keys()];
  check(
    'booking the stay raised sold by 1 on every night',
    nights.every((date) => soldAfterBooking.get(date).sold === soldBefore.get(date).sold + 1),
    `${String(nights.length)} night(s), room ${room.number}`,
  );

  /**
   * The money fingerprint is taken immediately either side of the cancellation,
   * not once around the whole suite: the in-house fixture in step 7 opens a
   * folio at check-in, so a suite-wide comparison would measure that fixture
   * rather than this feature.
   */
  const financialsBefore = await financialFingerprint(property.id);

  const cancelled = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${booking.id}/cancel`,
    cookie,
    { reason: 'Integration suite: first cancellation' },
  );
  const financialsAfterFirstCancel = await financialFingerprint(property.id);
  if (cancelled.status === 200) releasedByCancel.add(booking.id);

  check('cancel returned 200', cancelled.status === 200, JSON.stringify(cancelled.payload));
  check(
    'it reported one night released per night of the stay',
    cancelled.payload?.nightsReleased === nights.length,
    `nightsReleased=${String(cancelled.payload?.nightsReleased)}, expected ${String(nights.length)}`,
  );
  check('it reported financials unchanged', cancelled.payload?.financialsUnchanged === true);
  check('it was not reported as a replay', cancelled.payload?.alreadyCancelled === false);

  const soldAfterCancel = await soldByDate(property.id, roomType.id, arrival, departure);
  check(
    'sold is back to its pre-booking value on every night',
    nights.every((date) => soldAfterCancel.get(date).sold === soldBefore.get(date).sold),
    nights
      .map((date) => `${date}:${String(soldAfterCancel.get(date).sold)}`)
      .join(' '),
  );

  const stayRow = await prisma.reservation.findUnique({
    where: { id: booking.id },
    select: { status: true, cancelledAt: true, rooms: { select: { status: true } } },
  });
  check('the reservation is CANCELLED', stayRow.status === 'CANCELLED');
  check('cancelledAt is set', stayRow.cancelledAt instanceof Date);
  check(
    'every reservation_room row is CANCELLED, which is what frees the room number',
    stayRow.rooms.length > 0 && stayRow.rooms.every((row) => row.status === 'CANCELLED'),
    stayRow.rooms.map((row) => row.status).join(','),
  );

  console.log('\n2. The invariants hold.');
  const violations = await inventoryViolations(property.id);
  check('no oversold night at the property', violations.oversold === 0);
  check('no negative counter at the property', violations.negative === 0);

  console.log('\n3. The room is re-sellable for the released dates.');
  const resell = await call('POST', `/properties/${PROPERTY_CODE}/reservations`, cookie, {
    roomTypeId: roomType.id,
    roomId: room.id,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Resell', lastName: 'Probe' }],
    isInstantCheckIn: false,
  });
  if (resell.status === 201) created.push(resell.payload.id);
  check(
    'the same room and the same nights can be booked again',
    resell.status === 201,
    `status ${String(resell.status)} ${resell.status === 201 ? `as ${resell.payload.bookingCode}` : JSON.stringify(resell.payload)}`,
  );

  /* -------------------------------------------------------------------- 4 */
  console.log('\n4. A repeat cancellation releases nothing further.');
  const soldBeforeRepeat = await soldByDate(property.id, roomType.id, arrival, departure);
  const repeat = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${booking.id}/cancel`,
    cookie,
    { reason: 'Integration suite: repeat' },
  );
  const soldAfterRepeat = await soldByDate(property.id, roomType.id, arrival, departure);

  check('the repeat is accepted, not an error', repeat.status === 200, JSON.stringify(repeat.payload));
  check('it is reported as already cancelled', repeat.payload?.alreadyCancelled === true);
  check('it released no further nights', repeat.payload?.nightsReleased === 0);
  check(
    'no counter moved',
    nights.every((date) => soldAfterRepeat.get(date).sold === soldBeforeRepeat.get(date).sold),
  );

  const repeatAudits = await prisma.auditLog.count({
    where: { entityId: booking.id, event: 'RESERVATION_CANCELLED' },
  });
  check(
    'the replay wrote no second audit row',
    repeatAudits === 1,
    `${String(repeatAudits)} RESERVATION_CANCELLED row(s)`,
  );

  /* -------------------------------------------------------------------- 5 */
  console.log('\n5. Concurrent cancellations: exactly one transition, one decrement.');
  const raceArrival = shiftDays(businessDate, 7);
  const raceDeparture = shiftDays(businessDate, 9);
  const raceType = await findSellableRoomType(property.id, raceArrival, raceDeparture);
  if (raceType === null) throw new Error('no category has room for the race stay.');

  const raceBooking = await createBooking(cookie, raceType, raceArrival, raceDeparture);
  const raceSoldBefore = await soldByDate(property.id, raceType.id, raceArrival, raceDeparture);

  const PARALLEL = 8;
  const results = await Promise.all(
    Array.from({ length: PARALLEL }, () =>
      call(
        'POST',
        `/properties/${PROPERTY_CODE}/reservations/${raceBooking.id}/cancel`,
        cookie,
        { reason: 'Integration suite: race' },
      ),
    ),
  );
  const ok = results.filter((result) => result.status === 200);
  const winners = ok.filter((result) => result.payload?.alreadyCancelled === false);
  const replays = ok.filter((result) => result.payload?.alreadyCancelled === true);

  /**
   * Recorded from the result, not assumed from having made the calls.
   *
   * Teardown skips the night-release for anything a cancellation already
   * released. Marking this booking unconditionally would, if every request had
   * failed, make teardown skip a release that never happened and leak a night
   * into the shared development database — a wrong counter left behind by the
   * suite that exists to prove counters stay right.
   */
  if (winners.length > 0 || results.some((result) => result.payload?.nightsReleased > 0)) {
    releasedByCancel.add(raceBooking.id);
  }

  check(
    `all ${String(PARALLEL)} requests were answered 200`,
    ok.length === PARALLEL,
    results.map((result) => result.status).join(','),
  );
  check('exactly one performed the cancellation', winners.length === 1, `${String(winners.length)} winner(s)`);
  check(`the other ${String(PARALLEL - 1)} were replays`, replays.length === PARALLEL - 1);

  const raceSoldAfter = await soldByDate(property.id, raceType.id, raceArrival, raceDeparture);
  const raceNights = [...raceSoldBefore.keys()];
  check(
    'sold fell by exactly 1 on every night, never more',
    raceNights.every((date) => raceSoldAfter.get(date).sold === raceSoldBefore.get(date).sold - 1),
    raceNights
      .map((date) => `${date}:${String(raceSoldBefore.get(date).sold)}->${String(raceSoldAfter.get(date).sold)}`)
      .join(' '),
  );

  const raceAudits = await prisma.auditLog.count({
    where: { entityId: raceBooking.id, event: 'RESERVATION_CANCELLED' },
  });
  check('exactly one audit row was written', raceAudits === 1, `${String(raceAudits)} row(s)`);

  /* -------------------------------------------------------------------- 6 */
  console.log('\n6. A status that never consumed inventory does not decrement.');
  const holdArrival = shiftDays(businessDate, 11);
  const holdDeparture = shiftDays(businessDate, 13);
  const holdType = await findSellableRoomType(property.id, holdArrival, holdDeparture);
  if (holdType === null) throw new Error('no category has room for the on-hold stay.');

  const holdBooking = await createBooking(cookie, holdType, holdArrival, holdDeparture);

  /**
   * Moved to ON_HOLD directly, because no endpoint creates one: the create
   * path only ever writes CONFIRMED or CHECKED_IN. The enum documents ON_HOLD
   * as holding a room *without* consuming inventory, so cancelling one must
   * not hand back a night the hotel never sold. Writing the status here is
   * the only way to reach that branch, and it is this suite's own row.
   */
  await prisma.reservation.update({
    where: { id: holdBooking.id },
    data: { status: 'ON_HOLD' },
  });
  await prisma.reservationRoom.updateMany({
    where: { reservationId: holdBooking.id },
    data: { status: 'ON_HOLD' },
  });

  const holdSoldBefore = await soldByDate(property.id, holdType.id, holdArrival, holdDeparture);
  const holdCancel = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${holdBooking.id}/cancel`,
    cookie,
    { reason: 'Integration suite: on hold' },
  );
  const holdSoldAfter = await soldByDate(property.id, holdType.id, holdArrival, holdDeparture);

  check('an ON_HOLD booking cancels', holdCancel.status === 200, JSON.stringify(holdCancel.payload));
  check('it released no nights', holdCancel.payload?.nightsReleased === 0);
  check(
    'no counter moved',
    [...holdSoldBefore.keys()].every(
      (date) => holdSoldAfter.get(date).sold === holdSoldBefore.get(date).sold,
    ),
  );

  /* -------------------------------------------------------------------- 7 */
  console.log('\n7. A checked-in stay is refused, and leaves nothing behind.');
  const inArrival = businessDate;
  const inDeparture = shiftDays(businessDate, 2);
  const inType = await findSellableRoomType(property.id, inArrival, inDeparture);
  if (inType === null) throw new Error('no category has room for the in-house stay.');

  const inRoom = await prisma.room.findFirst({
    where: {
      propertyId: property.id,
      roomTypeId: inType.id,
      status: { notIn: ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY', 'OUT_OF_ORDER'] },
    },
    select: { id: true, number: true, status: true },
    orderBy: { number: 'asc' },
  });
  if (inRoom === null) throw new Error('no clean room for the in-house stay.');
  restoreRooms.push({ id: inRoom.id, status: inRoom.status });

  const inHouse = await createBooking(cookie, inType, inArrival, inDeparture, {
    roomId: inRoom.id,
    isInstantCheckIn: true,
    guests: [
      {
        firstName: 'Inhouse',
        lastName: 'Probe',
        govtIdType: 'PASSPORT',
        govtIdNumber: 'CANCELSUITE1',
      },
    ],
  });

  const inSoldBefore = await soldByDate(property.id, inType.id, inArrival, inDeparture);
  const financialsBeforeRefusal = await financialFingerprint(property.id);
  const refused = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${inHouse.id}/cancel`,
    cookie,
    { reason: 'Integration suite: should be refused' },
  );
  const inSoldAfter = await soldByDate(property.id, inType.id, inArrival, inDeparture);
  const financialsAroundRefusal = {
    before: financialsBeforeRefusal,
    after: await financialFingerprint(property.id),
  };

  check('it is refused with 409', refused.status === 409, `status ${String(refused.status)}`);
  check(
    'the code is the typed INVALID_STATE_TRANSITION, not a generic failure',
    refused.payload?.code === 'INVALID_STATE_TRANSITION',
    `code ${String(refused.payload?.code)}`,
  );

  const inHouseRow = await prisma.reservation.findUnique({
    where: { id: inHouse.id },
    select: { status: true, cancelledAt: true },
  });
  check('the stay is still CHECKED_IN', inHouseRow.status === 'CHECKED_IN');
  check('cancelledAt was not set', inHouseRow.cancelledAt === null);
  check(
    'no night was released',
    [...inSoldBefore.keys()].every(
      (date) => inSoldAfter.get(date).sold === inSoldBefore.get(date).sold,
    ),
  );
  const refusedAudits = await prisma.auditLog.count({
    where: { entityId: inHouse.id, event: 'RESERVATION_CANCELLED' },
  });
  check('the refusal wrote no audit row — it rolled back whole', refusedAudits === 0);

  /* -------------------------------------------------------------------- 8 */
  console.log('\n8. Another property’s reservation is not found.');
  const foreign = await prisma.reservation.findFirst({
    where: { propertyId: { not: property.id }, status: 'CONFIRMED' },
    select: { id: true, propertyId: true },
  });

  if (foreign === null) {
    console.log('  SKIP  no reservation at another property to probe with.');
  } else {
    const leak = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${foreign.id}/cancel`,
      cookie,
      { reason: 'Integration suite: cross-tenant probe' },
    );
    check(
      'it 404s rather than 403 — a 403 would confirm the booking exists',
      leak.status === 404,
      `status ${String(leak.status)}`,
    );
    const foreignRow = await prisma.reservation.findUnique({
      where: { id: foreign.id },
      select: { status: true, cancelledAt: true },
    });
    check('the other property’s booking is untouched', foreignRow.status === 'CONFIRMED');
    check('and has no cancellation timestamp', foreignRow.cancelledAt === null);
  }

  /* -------------------------------------------------------------------- 9 */
  console.log('\n9. The audit row and the state change committed together.');
  const audit = await prisma.auditLog.findFirst({
    where: { entityId: booking.id, event: 'RESERVATION_CANCELLED' },
    select: { actorUserId: true, propertyId: true, entityType: true, before: true, after: true, reason: true },
  });
  check('an audit row exists', audit !== null);
  check('it names the actor', audit?.actorUserId === user.id);
  check('it is scoped to the property', audit?.propertyId === property.id);
  check('it names the entity type', audit?.entityType === 'reservation');
  check('it records the previous status', audit?.before?.status === 'CONFIRMED');
  check('it records the new status', audit?.after?.status === 'CANCELLED');
  check(
    'it records how many nights were released',
    audit?.after?.nightsReleased === nights.length,
    `${String(audit?.after?.nightsReleased)}`,
  );
  check('it keeps the reason', audit?.reason === 'Integration suite: first cancellation');

  /* -------------------------------------------------------------------- 9a */
  console.log('\n9a. A grant without reservations:edit cannot cancel.');
  const housekeeping = await prisma.userPropertyRole.findFirst({
    where: { propertyId: property.id, role: { key: 'HOUSEKEEPING' } },
    select: { user: { select: { id: true, email: true } } },
  });

  if (housekeeping === null) {
    console.log('  SKIP  no housekeeping grant at this property.');
  } else {
    const guardArrival = shiftDays(businessDate, 15);
    const guardDeparture = shiftDays(businessDate, 17);
    const guardType = await findSellableRoomType(property.id, guardArrival, guardDeparture);
    if (guardType === null) throw new Error('no category has room for the authorisation probe.');

    const guarded = await createBooking(cookie, guardType, guardArrival, guardDeparture);
    const guardSoldBefore = await soldByDate(
      property.id,
      guardType.id,
      guardArrival,
      guardDeparture,
    );

    const denied = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${guarded.id}/cancel`,
      `easeit_session=${mintSession(housekeeping.user.id, housekeeping.user.email)}`,
      { reason: 'Integration suite: unauthorised probe' },
    );

    check(
      'a housekeeping grant is refused with 403',
      denied.status === 403,
      `status ${String(denied.status)} for ${housekeeping.user.email}`,
    );
    check(
      'the code names the missing permission, not a generic failure',
      denied.payload?.code === 'FORBIDDEN',
      `code ${String(denied.payload?.code)}`,
    );

    const guardRow = await prisma.reservation.findUnique({
      where: { id: guarded.id },
      select: { status: true, cancelledAt: true, rooms: { select: { status: true } } },
    });
    check('the reservation is still CONFIRMED', guardRow.status === 'CONFIRMED');
    check('cancelledAt was not set', guardRow.cancelledAt === null);
    check(
      'the room rows are untouched, so the room stays held',
      guardRow.rooms.every((row) => row.status === 'CONFIRMED'),
      guardRow.rooms.map((row) => row.status).join(','),
    );

    const guardSoldAfter = await soldByDate(
      property.id,
      guardType.id,
      guardArrival,
      guardDeparture,
    );
    check(
      'no night was released',
      [...guardSoldBefore.keys()].every(
        (date) => guardSoldAfter.get(date).sold === guardSoldBefore.get(date).sold,
      ),
    );
    check(
      'and it wrote no audit row',
      (await prisma.auditLog.count({
        where: { entityId: guarded.id, event: 'RESERVATION_CANCELLED' },
      })) === 0,
    );
  }

  /* ------------------------------------------------------------------- 10 */
  console.log('\n10. No folio or folio line was touched by a cancellation.');
  check(
    'the folio count is unchanged across the cancellation',
    financialsAfterFirstCancel.folios === financialsBefore.folios,
    `${String(financialsBefore.folios)} -> ${String(financialsAfterFirstCancel.folios)}`,
  );
  check(
    'the folio-line count is unchanged across the cancellation',
    financialsAfterFirstCancel.lines === financialsBefore.lines,
    `${String(financialsBefore.lines)} -> ${String(financialsAfterFirstCancel.lines)}`,
  );
  check(
    'the folio-line amount digest is byte-identical across the cancellation',
    financialsAfterFirstCancel.digest === financialsBefore.digest,
  );
  check(
    'and across the refused cancellation of the in-house stay',
    financialsAroundRefusal.before.digest === financialsAroundRefusal.after.digest &&
      financialsAroundRefusal.before.lines === financialsAroundRefusal.after.lines,
    `${String(financialsAroundRefusal.before.lines)} -> ${String(financialsAroundRefusal.after.lines)} line(s)`,
  );
  console.log(
    '  NOTE  measured immediately either side of each cancellation. A ' +
      'suite-wide comparison would instead measure the folio that step 7\u2019s ' +
      'instant check-in opens, which is the fixture, not this feature.',
  );
}

/* -------------------------------------------------------------------------- */
/*  Teardown                                                                  */
/* -------------------------------------------------------------------------- */

async function teardown() {
  let released = 0;

  for (const reservationId of created) {
    const stay = await prisma.reservation
      .findUnique({
        where: { id: reservationId },
        select: {
          propertyId: true,
          arrivalDate: true,
          departureDate: true,
          rooms: { select: { roomTypeId: true }, take: 1 },
        },
      })
      .catch(() => null);

    await prisma.reservation.delete({ where: { id: reservationId } }).catch(() => null);

    /**
     * Only the nights a cancellation did NOT already release.
     *
     * Releasing them twice is precisely the double-decrement this suite
     * exists to prove impossible, and doing it in teardown would hand a room
     * back to the hotel that it never got — leaving the dev database quietly
     * wrong in the same way a bug would.
     */
    if (releasedByCancel.has(reservationId)) continue;

    const roomTypeId = stay?.rooms[0]?.roomTypeId;
    if (stay !== null && roomTypeId !== undefined) {
      const result = await prisma.inventoryDay
        .updateMany({
          where: {
            propertyId: stay.propertyId,
            roomTypeId,
            stayDate: { gte: stay.arrivalDate, lt: stay.departureDate },
            sold: { gt: 0 },
          },
          data: { sold: { decrement: 1 } },
        })
        .catch(() => ({ count: 0 }));
      released += result.count;
    }
  }

  for (const room of restoreRooms) {
    await prisma.room
      .update({ where: { id: room.id }, data: { status: room.status } })
      .catch(() => null);
  }

  console.log(
    `\nTeardown: removed ${String(created.length)} reservation(s), released ${String(released)} ` +
      `night(s) that no cancellation had released, and restored ` +
      `${String(restoreRooms.length)} room status(es).`,
  );
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\nFATAL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await teardown().catch((error) => {
    console.error(`Teardown failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await prisma.$disconnect().catch(() => null);
}

console.log(failures === 0 ? '\nAll cancellation checks passed.' : `\n${String(failures)} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
