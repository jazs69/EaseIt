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
 * domain error and leaves no audit row behind; a checked-out stay is refused
 * and keeps the past night it consumed; a row locked elsewhere produces a typed
 * 409 that changes nothing and succeeds on a retry; a stay holding stock with no
 * room rows is refused rather than released; another property's reservation
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

  /* ------------------------------------------------------------------- 7b */
  console.log('\n7b. A checked-out stay is refused, and keeps its consumed night.');

  /**
   * The guard for the M-5 correction.
   *
   * `CHECKED_OUT` is now inside `CONSUMES_INVENTORY`, because that is what
   * `inventory_day.sold` actually holds — nothing releases a night at
   * check-out. That makes the refusal in `cancelRefusal` the only thing
   * standing between a checked-out stay and a decrement of a **past** date,
   * which would oversell history and move the occupancy and ADR figures that
   * read `sold`. This pins the refusal so a later edit cannot quietly remove
   * it now that the predicate would say yes.
   */
  const outArrival = shiftDays(businessDate, 19);
  const outDeparture = shiftDays(businessDate, 21);
  const outType = await findSellableRoomType(property.id, outArrival, outDeparture);
  if (outType === null) throw new Error('no category has room for the checked-out stay.');

  const outBooking = await createBooking(cookie, outType, outArrival, outDeparture);

  /**
   * Set directly, for the same reason step 6 sets ON_HOLD: no endpoint
   * performs a check-out — there is no check-out path in the codebase — so
   * this is the only way to reach the status, and it is this suite's own row.
   * A CHECKED_OUT reservation is an ordinary state the seeds also create; the
   * row is coherent, not malformed.
   */
  await prisma.reservation.update({
    where: { id: outBooking.id },
    data: { status: 'CHECKED_OUT' },
  });
  await prisma.reservationRoom.updateMany({
    where: { reservationId: outBooking.id },
    data: { status: 'CHECKED_OUT' },
  });

  const outSoldBefore = await soldByDate(property.id, outType.id, outArrival, outDeparture);
  const outRefused = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${outBooking.id}/cancel`,
    cookie,
    { reason: 'Integration suite: checked-out probe' },
  );
  const outSoldAfter = await soldByDate(property.id, outType.id, outArrival, outDeparture);

  check('it is refused with 409', outRefused.status === 409, `status ${String(outRefused.status)}`);
  check(
    'the code is the typed INVALID_STATE_TRANSITION',
    outRefused.payload?.code === 'INVALID_STATE_TRANSITION',
    `code ${String(outRefused.payload?.code)}`,
  );
  check(
    'the refusal names CHECKED_OUT as the state it came from',
    outRefused.payload?.details?.from === 'CHECKED_OUT',
    `from ${String(outRefused.payload?.details?.from)}`,
  );

  const outRow = await prisma.reservation.findUnique({
    where: { id: outBooking.id },
    select: { status: true, cancelledAt: true },
  });
  check('the stay is still CHECKED_OUT', outRow.status === 'CHECKED_OUT');
  check('cancelledAt was not set', outRow.cancelledAt === null);
  check(
    'the consumed night was NOT given back — no past date was released',
    [...outSoldBefore.keys()].every(
      (date) => outSoldAfter.get(date).sold === outSoldBefore.get(date).sold,
    ),
    [...outSoldBefore.keys()]
      .map((date) => `${date}:${String(outSoldBefore.get(date).sold)}->${String(outSoldAfter.get(date).sold)}`)
      .join(' '),
  );
  check(
    'and it wrote no cancellation audit row',
    (await prisma.auditLog.count({
      where: { entityId: outBooking.id, event: 'RESERVATION_CANCELLED' },
    })) === 0,
  );

  /* ------------------------------------------------------------------- 7c */
  console.log('\n7c. A lock held elsewhere becomes a typed 409, not a 500.');

  /**
   * The M-3 guard, exercised for real — including the bound on the wait.
   *
   * A contended reservation row used to make the cancellation wait until
   * Prisma's transaction deadline *should* have fired, which it does not do to
   * a query already blocked in Postgres: measured at **39,969 ms** against a
   * 10,000 ms timeout, because nothing capped the wait. The transaction now
   * sets `lock_timeout` on itself, so Postgres cancels the statement after
   * `ROW_LOCK_TIMEOUT_MS`.
   *
   * Three things are asserted together, because any one alone would be
   * misleading: the answer is a typed 409 (not the unhandled 500 this used to
   * be), it arrives **within a bounded time** (not whenever the holder lets
   * go), and it changed nothing — no night released, no status moved, no audit
   * row — because `55P03` rolls the whole transaction back.
   *
   * The lock is taken on **this suite's own reservation row** by a second
   * interactive transaction, held only for the duration of the one request,
   * and released in a `finally`. No shared or seeded row is touched, and
   * nothing is mutated to reach the branch.
   */
  const lockArrival = shiftDays(businessDate, 23);
  const lockDeparture = shiftDays(businessDate, 25);
  const lockType = await findSellableRoomType(property.id, lockArrival, lockDeparture);
  if (lockType === null) throw new Error('no category has room for the lock-contention stay.');

  const lockBooking = await createBooking(cookie, lockType, lockArrival, lockDeparture);
  const lockSoldBefore = await soldByDate(property.id, lockType.id, lockArrival, lockDeparture);

  /**
   * The gate is built before the transaction that waits on it, so
   * `releaseLock` is never an unassigned no-op: the previous shape assigned it
   * from inside the transaction callback, which left a window where the
   * `finally` below could fire before the resolver existed and the blocker
   * would then be freed only by its own timeout — which is how the earlier
   * run ended up waiting ~40s. 15s is the backstop if this suite dies between
   * taking the lock and releasing it; it is never reached on a passing run.
   */
  let releaseLock = () => {};
  const lockGate = new Promise((resolve) => {
    releaseLock = resolve;
  });
  let locked = false;

  const blocker = prisma
    .$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM reservation WHERE "id" = ${lockBooking.id}::uuid FOR UPDATE`;
        locked = true;
        await lockGate;
      },
      { timeout: 15_000, maxWait: 10_000 },
    )
    .catch((error) => {
      console.error(`  (blocker transaction failed: ${error.message})`);
    });

  // Wait for the lock to actually be held before provoking the contention.
  for (let i = 0; i < 100 && !locked; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  let blockedResult = null;
  let blockedMs = 0;
  try {
    check('the blocking transaction holds the reservation row', locked === true);
    const startedAt = Date.now();
    blockedResult = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${lockBooking.id}/cancel`,
      cookie,
      { reason: 'Integration suite: lock contention' },
    );
    blockedMs = Date.now() - startedAt;
    console.log(`  (the contended request took ${String(blockedMs)}ms)`);
  } finally {
    releaseLock();
    await blocker;
  }

  /**
   * The bound itself.
   *
   * 8s, not 3s: the assertion has to survive the lock wait plus the round
   * trip, authorisation queries and rollback without becoming flaky, while
   * still failing loudly if the cap is removed — the unbounded case measured
   * 39,969 ms and the blocker here holds the row for the whole request, so
   * there is no path between 8s and 15s that this would wrongly pass.
   */
  check(
    'the wait is bounded — it gives up in seconds, not when the holder lets go',
    blockedMs < 8_000,
    `${String(blockedMs)}ms, cap 8000ms`,
  );

  check(
    'it is answered 409, not 500',
    blockedResult?.status === 409,
    `status ${String(blockedResult?.status)}`,
  );
  check(
    'the code is the typed CONFLICT',
    blockedResult?.payload?.code === 'CONFLICT',
    `code ${String(blockedResult?.payload?.code)}`,
  );
  check(
    'no database internals leak — no SQLSTATE, Prisma code or SQL in the message',
    typeof blockedResult?.payload?.message === 'string' &&
      !/P\d{4}|SQLSTATE|40001|40P01|55P03|P2028|SELECT|prisma|lock/i.test(
        blockedResult.payload.message,
      ),
    JSON.stringify(blockedResult?.payload?.message),
  );

  const lockRow = await prisma.reservation.findUnique({
    where: { id: lockBooking.id },
    select: { status: true, cancelledAt: true },
  });
  check('the reservation is untouched — still CONFIRMED', lockRow.status === 'CONFIRMED');
  check('cancelledAt was not set', lockRow.cancelledAt === null);

  const lockSoldAfter = await soldByDate(property.id, lockType.id, lockArrival, lockDeparture);
  check(
    'no night was released by the timed-out attempt',
    [...lockSoldBefore.keys()].every(
      (date) => lockSoldAfter.get(date).sold === lockSoldBefore.get(date).sold,
    ),
  );
  check(
    'and it wrote no audit row — the transaction rolled back whole',
    (await prisma.auditLog.count({
      where: { entityId: lockBooking.id, event: 'RESERVATION_CANCELLED' },
    })) === 0,
  );

  // The payoff: "try again" is honest advice. With the lock gone the very same
  // request succeeds, which is what makes a 409 the right answer rather than a
  // permanent refusal.
  const afterLock = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${lockBooking.id}/cancel`,
    cookie,
    { reason: 'Integration suite: retry after the lock cleared' },
  );
  if (afterLock.status === 200) releasedByCancel.add(lockBooking.id);

  check(
    'once the lock clears the same request succeeds',
    afterLock.status === 200 && afterLock.payload?.alreadyCancelled === false,
    `status ${String(afterLock.status)}`,
  );
  check(
    'and it releases every night exactly once',
    afterLock.payload?.nightsReleased === lockSoldBefore.size,
    `nightsReleased=${String(afterLock.payload?.nightsReleased)} of ${String(lockSoldBefore.size)}`,
  );

  /* ------------------------------------------------------------------- 7d */
  console.log('\n7d. A stay holding stock with no room rows is refused, not released.');

  /**
   * The M-2 guard.
   *
   * A reservation that consumes inventory but has no `reservation_room` rows
   * is unreachable through the API — `create-reservation` writes the rows and
   * the counter in one transaction. It is reachable in the database, because
   * nothing in the schema requires a stay to have a room row, and that is the
   * whole point: if it ever happens, the release has no category to give the
   * nights back to. Carrying on would answer 200 with `nightsReleased: 0` and
   * leave the counter permanently high — a room the hotel can never sell
   * again, reported to the clerk as a success.
   *
   * Reaching it safely:
   *
   *   * the stay is created through the **real booking endpoint**, so its
   *     nights are consumed exactly as production consumes them;
   *   * the rows are removed by `reservationId`, scoped to **this suite's own
   *     reservation**. No seeded or shared stay is touched;
   *   * the rows are captured first and **restored in a `finally`**, which
   *     matters for more than tidiness: the teardown below derives the room
   *     type from `rooms[0]`, so a stay left with no rows would be deleted
   *     with its nights still sold. Restoring them hands the stay back to the
   *     ordinary teardown path.
   *
   * `roomId` is null on a fresh booking, and `reservation_room_no_overlap` is
   * keyed on `room_id WITH =`, so re-inserting the rows cannot collide with
   * anything.
   */
  const orphanArrival = shiftDays(businessDate, 27);
  const orphanDeparture = shiftDays(businessDate, 29);
  const orphanType = await findSellableRoomType(property.id, orphanArrival, orphanDeparture);
  if (orphanType === null) throw new Error('no category has room for the no-room-rows stay.');

  const orphanBooking = await createBooking(cookie, orphanType, orphanArrival, orphanDeparture);

  /** Verbatim, so the `finally` can put back exactly what it took away. */
  const orphanRooms = await prisma.reservationRoom.findMany({
    where: { reservationId: orphanBooking.id },
  });

  const orphanSoldBefore = await soldByDate(
    property.id,
    orphanType.id,
    orphanArrival,
    orphanDeparture,
  );
  const orphanFinanceBefore = await financialFingerprint(property.id);
  const orphanBeforeRow = await prisma.reservation.findUnique({
    where: { id: orphanBooking.id },
    select: { status: true, cancelledAt: true },
  });

  let orphanRefused = null;
  try {
    const removed = await prisma.reservationRoom.deleteMany({
      where: { reservationId: orphanBooking.id, propertyId: property.id },
    });
    check(
      "the suite's own stay is left holding stock with no room rows",
      orphanRooms.length > 0 && removed.count === orphanRooms.length,
      `removed ${String(removed.count)} of ${String(orphanRooms.length)} row(s)`,
    );

    orphanRefused = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${orphanBooking.id}/cancel`,
      cookie,
      { reason: 'Integration suite: no room rows' },
    );
  } finally {
    /**
     * Restored before anything else can observe the gap, and verified rather
     * than assumed: if this failed silently the teardown would delete the
     * stay and leave its nights sold, which is the one way this test could
     * damage the dev database.
     */
    if (orphanRooms.length > 0) {
      await prisma.reservationRoom
        .createMany({ data: orphanRooms, skipDuplicates: true })
        .catch((error) => {
          console.error(`  (restoring the room rows failed: ${error.message})`);
        });
    }
  }

  const orphanRestored = await prisma.reservationRoom.count({
    where: { reservationId: orphanBooking.id },
  });
  check(
    'the room rows are restored, so teardown can release the nights normally',
    orphanRestored === orphanRooms.length,
    `${String(orphanRestored)} of ${String(orphanRooms.length)} row(s)`,
  );

  check(
    'it is refused with 400',
    orphanRefused?.status === 400,
    `status ${String(orphanRefused?.status)}`,
  );
  check(
    'the code is the typed VALIDATION_FAILED',
    orphanRefused?.payload?.code === 'VALIDATION_FAILED',
    `code ${String(orphanRefused?.payload?.code)}`,
  );
  check(
    'the refusal names the reservation and asks for an operator, not a retry',
    typeof orphanRefused?.payload?.details?.issues?.reservationId === 'string' &&
      /reconcile/i.test(orphanRefused.payload.details.issues.reservationId),
    JSON.stringify(orphanRefused?.payload?.details?.issues?.reservationId),
  );

  const orphanAfterRow = await prisma.reservation.findUnique({
    where: { id: orphanBooking.id },
    select: { status: true, cancelledAt: true },
  });
  check(
    'the status is unchanged — still CONFIRMED',
    orphanAfterRow.status === 'CONFIRMED' && orphanAfterRow.status === orphanBeforeRow.status,
    `status ${String(orphanAfterRow.status)}`,
  );
  check('cancelledAt was not set', orphanAfterRow.cancelledAt === null);

  const orphanSoldAfter = await soldByDate(
    property.id,
    orphanType.id,
    orphanArrival,
    orphanDeparture,
  );
  check(
    'not one night was released — the counter is untouched on every date',
    [...orphanSoldBefore.keys()].every(
      (date) => orphanSoldAfter.get(date).sold === orphanSoldBefore.get(date).sold,
    ),
    [...orphanSoldBefore.keys()]
      .map(
        (date) =>
          `${date}:${String(orphanSoldBefore.get(date).sold)}->${String(orphanSoldAfter.get(date).sold)}`,
      )
      .join(' '),
  );
  check(
    'and it wrote no cancellation audit row',
    (await prisma.auditLog.count({
      where: { entityId: orphanBooking.id, event: 'RESERVATION_CANCELLED' },
    })) === 0,
  );

  const orphanFinanceAfter = await financialFingerprint(property.id);
  check(
    'no folio or folio line moved',
    orphanFinanceAfter.folios === orphanFinanceBefore.folios &&
      orphanFinanceAfter.lines === orphanFinanceBefore.lines &&
      orphanFinanceAfter.digest === orphanFinanceBefore.digest,
    `${String(orphanFinanceBefore.lines)} -> ${String(orphanFinanceAfter.lines)} line(s)`,
  );

  const orphanViolations = await inventoryViolations(property.id);
  check(
    'and the property is still neither oversold nor negative',
    orphanViolations.oversold === 0 && orphanViolations.negative === 0,
    `oversold ${String(orphanViolations.oversold)}, negative ${String(orphanViolations.negative)}`,
  );

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

  /* ------------------------------------------------------------------- 11 */
  console.log('\n11. Cancellation racing a check-in: never both, and never a 500.');

  /**
   * Two operations that both accept a CONFIRMED stay, fired together.
   *
   * `check-in.service.ts` validates status at :241-246 **outside** its
   * transaction and then, inside it, writes `status: CHECKED_IN` with no
   * `FOR UPDATE` on the reservation row and no re-check under lock.
   * Cancellation does take that row lock (`cancel-reservation.service.ts`
   * :211-224). So the two can interleave, and the only thing left standing
   * between them is a database CHECK:
   *
   *     reservation_cancelled_at_matches_status
   *       CHECK ("cancelledAt" IS NULL OR "status" IN ('CANCELLED','NO_SHOW'))
   *
   * If cancellation commits in the gap after check-in read CONFIRMED, that
   * CHECK rejects check-in's write with `23514`. The constraint is doing
   * exactly what section 3.1 asks of it; the open question is what the clerk
   * is then told, because check-in has no handler for `23514` on this path.
   *
   * What is asserted here is only what the contract actually guarantees.
   * **Not** "exactly one succeeds": if cancellation takes the row lock first,
   * check-in's own update blocks behind it with no `lock_timeout` of its own,
   * and both requests failing is a legitimate outcome. What must never happen
   * is both succeeding, an incoherent end state, or an infrastructure error
   * reaching the client.
   *
   * Arrival is the business date and cannot be moved: `blockersFor` raises
   * `ARRIVAL_IN_FUTURE` for anything later (`check-in.service.ts:402`), so an
   * unused far-future window is not available to this scenario. Each round
   * therefore takes its own room and its own one-night stay, and capacity is
   * verified per round rather than assumed.
   */
  const raceInArrival = businessDate;
  const raceInDeparture = shiftDays(businessDate, 1);
  const ROUNDS = 4;

  /** Rooms this step has already consumed, so each round gets a fresh one. */
  const usedRooms = new Set();
  const outcomes = [];
  let constraintHits = 0;
  let serverErrors = 0;

  for (let round = 1; round <= ROUNDS; round += 1) {
    /**
     * A free, sellable room whose category still has headroom on the night.
     *
     * Checked per round because the previous round's check-in consumed one.
     * A round that cannot be set up is reported and skipped, never forced.
     */
    const candidates = await prisma.room.findMany({
      where: {
        propertyId: property.id,
        status: { notIn: ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY', 'OUT_OF_ORDER'] },
        id: { notIn: [...usedRooms] },
      },
      select: { id: true, number: true, status: true, roomTypeId: true },
      orderBy: { number: 'asc' },
      take: 25,
    });

    let room = null;
    let sellable = null;
    for (const candidate of candidates) {
      const nights = await soldByDate(
        property.id,
        candidate.roomTypeId,
        raceInArrival,
        raceInDeparture,
      );
      const hasRoom =
        nights.size > 0 &&
        [...nights.values()].every(
          (night) => night.sold + night.blocked < night.physical + night.overbookingAllowance,
        );
      if (hasRoom) {
        room = candidate;
        sellable = nights;
        break;
      }
    }

    if (room === null) {
      console.log(`  SKIP  round ${String(round)}: no free room with headroom tonight.`);
      continue;
    }

    usedRooms.add(room.id);
    restoreRooms.push({ id: room.id, status: room.status });

    const stay = await createBooking(cookie, { id: room.roomTypeId }, raceInArrival, raceInDeparture, {
      guests: [
        {
          firstName: 'Race',
          lastName: 'Probe',
          govtIdType: 'PASSPORT',
          govtIdNumber: `CANCELRACE${String(round)}`,
        },
      ],
    });

    const soldBefore = await soldByDate(
      property.id,
      room.roomTypeId,
      raceInArrival,
      raceInDeparture,
    );
    const financeBefore = await financialFingerprint(property.id);

    // Both requests issued before either is awaited, which is what gives the
    // two transactions a chance to overlap at all.
    const [cancelled, checkedIn] = await Promise.all([
      call(
        'POST',
        `/properties/${PROPERTY_CODE}/reservations/${stay.id}/cancel`,
        cookie,
        { reason: `Integration suite: check-in race ${String(round)}` },
      ),
      call('POST', `/properties/${PROPERTY_CODE}/reservations/${stay.id}/check-in`, cookie, {
        roomId: room.id,
        primaryGuestIdType: 'PASSPORT',
        primaryGuestIdNumber: `CANCELRACE${String(round)}`,
        keyCardsIssued: 1,
        registrationCardSigned: true,
        acknowledgeRoomNotClean: true,
        initialPayment: null,
      }),
    ]);

    const cancelWon = cancelled.status === 200 && cancelled.payload?.alreadyCancelled === false;
    const checkInWon = checkedIn.status === 201;

    /**
     * Recorded from the response, never from having made the call — the same
     * reasoning as step 5. Marking a release that did not happen would make
     * teardown skip a night it still owes back.
     */
    if (cancelWon || cancelled.payload?.nightsReleased > 0) releasedByCancel.add(stay.id);

    const row = await prisma.reservation.findUnique({
      where: { id: stay.id },
      select: { status: true, cancelledAt: true },
    });
    const soldAfter = await soldByDate(
      property.id,
      room.roomTypeId,
      raceInArrival,
      raceInDeparture,
    );
    const audits = await prisma.auditLog.count({
      where: { entityId: stay.id, event: 'RESERVATION_CANCELLED' },
    });
    const financeAfter = await financialFingerprint(property.id);

    const nightsHeld = [...soldBefore.keys()];
    const releasedEvery = nightsHeld.every(
      (date) => soldAfter.get(date).sold === soldBefore.get(date).sold - 1,
    );
    const heldEvery = nightsHeld.every(
      (date) => soldAfter.get(date).sold === soldBefore.get(date).sold,
    );

    outcomes.push({
      round,
      cancel: cancelled.status,
      checkIn: checkedIn.status,
      status: row.status,
      cancelWon,
      checkInWon,
    });

    if (checkedIn.status >= 500 || cancelled.status >= 500) serverErrors += 1;
    if (
      /23514|constraint|cancelled_at_matches/i.test(JSON.stringify(checkedIn.payload ?? {})) ||
      /23514|constraint|cancelled_at_matches/i.test(JSON.stringify(cancelled.payload ?? {}))
    ) {
      constraintHits += 1;
    }

    /* ---- the invariants the contract does guarantee ---- */

    check(
      `round ${String(round)}: they did not both succeed`,
      !(cancelWon && checkInWon),
      `cancel ${String(cancelled.status)}, check-in ${String(checkedIn.status)}`,
    );

    check(
      `round ${String(round)}: neither request returned a 5xx`,
      cancelled.status < 500 && checkedIn.status < 500,
      `cancel ${String(cancelled.status)}, check-in ${String(checkedIn.status)}`,
    );

    /**
     * The loser's answer is the point of the fix, so it is named exactly.
     *
     * A 4xx alone would not be enough: the old failure was a 500 and the one
     * before it would have been a lock-timeout 409. When the cancellation
     * wins, check-in must give the same typed refusal a clerk would have got
     * had they tried a second later, which is the state-machine error, not a
     * conflict and not a validation complaint.
     */
    if (cancelWon) {
      check(
        `round ${String(round)}: the losing check-in is a typed 409, not a 500`,
        checkedIn.status === 409 &&
          checkedIn.payload?.code === 'INVALID_STATE_TRANSITION',
        `status ${String(checkedIn.status)}, code ${String(checkedIn.payload?.code)}`,
      );
      check(
        `round ${String(round)}: the refusal names the state it found`,
        checkedIn.payload?.details?.from === 'CANCELLED',
        `from ${String(checkedIn.payload?.details?.from)}`,
      );
    }

    check(
      `round ${String(round)}: no database internals reached the client`,
      ![cancelled, checkedIn].some(
        (response) =>
          typeof response.payload?.message === 'string' &&
          /\b23\d{3}\b|SQLSTATE|P20\d{2}|constraint "|prisma/i.test(response.payload.message),
      ),
      `${JSON.stringify(cancelled.payload?.message)} | ${JSON.stringify(checkedIn.payload?.message)}`,
    );

    /**
     * One coherent end state, not a blend of two.
     *
     * Each branch ties the status to its timestamp, its inventory and its
     * audit trail together, because any one of them alone can look right
     * while the set is wrong — a CANCELLED row whose night was never given
     * back reads perfectly in isolation.
     */
    const cancelledCoherently =
      row.status === 'CANCELLED' &&
      row.cancelledAt !== null &&
      releasedEvery &&
      audits === 1;
    const checkedInCoherently =
      row.status === 'CHECKED_IN' && row.cancelledAt === null && heldEvery && audits === 0;
    const untouched =
      row.status === 'CONFIRMED' && row.cancelledAt === null && heldEvery && audits === 0;

    check(
      `round ${String(round)}: the end state is coherent (${row.status})`,
      [cancelledCoherently, checkedInCoherently, untouched].filter(Boolean).length === 1,
      `cancelledAt ${row.cancelledAt === null ? 'null' : 'set'}, ${String(audits)} audit row(s), ` +
        nightsHeld
          .map(
            (date) =>
              `${date}:${String(soldBefore.get(date).sold)}->${String(soldAfter.get(date).sold)}`,
          )
          .join(' '),
    );

    /**
     * Money: a check-in that wins legitimately opens a folio and posts night
     * one, so the fingerprint is only required to be frozen when the
     * cancellation is what happened.
     */
    if (!checkInWon) {
      check(
        `round ${String(round)}: no folio or folio line moved`,
        financeAfter.folios === financeBefore.folios &&
          financeAfter.lines === financeBefore.lines &&
          financeAfter.digest === financeBefore.digest,
        `${String(financeBefore.lines)} -> ${String(financeAfter.lines)} line(s)`,
      );
    } else {
      console.log(
        `  NOTE  round ${String(round)}: the check-in won, so its folio is expected ` +
          `(${String(financeBefore.lines)} -> ${String(financeAfter.lines)} line(s)).`,
      );
    }

    const violations = await inventoryViolations(property.id);
    check(
      `round ${String(round)}: the property is neither oversold nor negative`,
      violations.oversold === 0 && violations.negative === 0,
      `oversold ${String(violations.oversold)}, negative ${String(violations.negative)}`,
    );
  }

  console.log(
    `  NOTE  outcomes: ${outcomes
      .map((o) => `#${String(o.round)} cancel ${String(o.cancel)}/check-in ${String(o.checkIn)} -> ${o.status}`)
      .join('; ')}`,
  );

  /**
   * Whether the narrow window was actually hit, stated rather than implied.
   *
   * The gap between check-in's status read and its write is milliseconds wide,
   * so a run can legitimately serialise every round and never exercise the
   * interleaving at all. Reporting that is the honest result; a pass here is
   * not evidence that the window is closed.
   */
  check(
    'no round produced a constraint violation or a server error',
    constraintHits === 0 && serverErrors === 0,
    `${String(constraintHits)} constraint leak(s), ${String(serverErrors)} server error(s)`,
  );
  console.log(
    `  NOTE  the interleaved window is narrow; ${String(outcomes.length)} round(s) ran. A pass ` +
      'here shows no round reached it or no round broke on it, not that it cannot be reached.',
  );

  /* ------------------------------------------------------------------ 11b */
  console.log('\n11b. The ordinary check-in path still works, and still refuses a cancel.');

  /**
   * The guard on the guard.
   *
   * Adding a row lock and an in-transaction status re-read to check-in could
   * just as easily have broken the uncontended path — refusing a perfectly
   * good arrival because the re-read disagreed with itself. So one plain
   * check-in is run with nothing racing it, end to end through the real
   * endpoint, and then the existing invalid-state rule is exercised against
   * its result: a checked-in stay still cannot be cancelled.
   */
  const plainCandidates = await prisma.room.findMany({
    where: {
      propertyId: property.id,
      status: { notIn: ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY', 'OUT_OF_ORDER'] },
      id: { notIn: [...usedRooms] },
    },
    select: { id: true, number: true, status: true, roomTypeId: true },
    orderBy: { number: 'asc' },
    take: 25,
  });

  let plainRoom = null;
  for (const candidate of plainCandidates) {
    const nights = await soldByDate(
      property.id,
      candidate.roomTypeId,
      raceInArrival,
      raceInDeparture,
    );
    if (
      nights.size > 0 &&
      [...nights.values()].every(
        (night) => night.sold + night.blocked < night.physical + night.overbookingAllowance,
      )
    ) {
      plainRoom = candidate;
      break;
    }
  }

  if (plainRoom === null) {
    console.log('  SKIP  no free room with headroom tonight for the uncontended check-in.');
  } else {
    usedRooms.add(plainRoom.id);
    restoreRooms.push({ id: plainRoom.id, status: plainRoom.status });

    const plainStay = await createBooking(
      cookie,
      { id: plainRoom.roomTypeId },
      raceInArrival,
      raceInDeparture,
      {
        guests: [
          {
            firstName: 'Plain',
            lastName: 'Probe',
            govtIdType: 'PASSPORT',
            govtIdNumber: 'CANCELPLAIN1',
          },
        ],
      },
    );

    const plainSoldBefore = await soldByDate(
      property.id,
      plainRoom.roomTypeId,
      raceInArrival,
      raceInDeparture,
    );

    const plainCheckIn = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${plainStay.id}/check-in`,
      cookie,
      {
        roomId: plainRoom.id,
        primaryGuestIdType: 'PASSPORT',
        primaryGuestIdNumber: 'CANCELPLAIN1',
        keyCardsIssued: 1,
        registrationCardSigned: true,
        acknowledgeRoomNotClean: true,
        initialPayment: null,
      },
    );

    check(
      'an uncontended check-in still succeeds',
      plainCheckIn.status === 201 && plainCheckIn.payload?.status === 'CHECKED_IN',
      `status ${String(plainCheckIn.status)} ${JSON.stringify(plainCheckIn.payload?.code ?? '')}`,
    );
    check(
      'it opens the arrival folio, as it did before the lock was added',
      Array.isArray(plainCheckIn.payload?.folio?.lines) &&
        plainCheckIn.payload.folio.lines.length > 0,
      `${String(plainCheckIn.payload?.folio?.lines?.length)} line(s)`,
    );

    const plainSoldAfter = await soldByDate(
      property.id,
      plainRoom.roomTypeId,
      raceInArrival,
      raceInDeparture,
    );
    check(
      'a check-in moves no inventory — the night was already consumed',
      [...plainSoldBefore.keys()].every(
        (date) => plainSoldAfter.get(date).sold === plainSoldBefore.get(date).sold,
      ),
    );

    // The existing rule, re-proved against a stay checked in by the endpoint
    // rather than by the instant-check-in fixture step 7 uses.
    const plainCancel = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${plainStay.id}/cancel`,
      cookie,
      { reason: 'Integration suite: cancelling an in-house stay' },
    );
    check(
      'and cancelling that checked-in stay is still refused 409',
      plainCancel.status === 409 && plainCancel.payload?.code === 'INVALID_STATE_TRANSITION',
      `status ${String(plainCancel.status)}, code ${String(plainCancel.payload?.code)}`,
    );
    check(
      'the refusal names CHECKED_IN as the state it came from',
      plainCancel.payload?.details?.from === 'CHECKED_IN',
      `from ${String(plainCancel.payload?.details?.from)}`,
    );
  }

  /* ------------------------------------------------------------------- 12 */
  console.log('\n12. Cancellation racing a cross-category room move.');

  /**
   * Run inside two room types this step creates and destroys.
   *
   * ===========================================================================
   * `room-move.service.ts` never locks the reservation row. It locks the two
   * categories' inventory rows (:259-266), moves the counter, then rewrites
   * `reservation_room.roomTypeId` (:285-291). Cancellation reads
   * `reservation_room` with a **plain SELECT, no FOR UPDATE** (:275-281) and
   * holds that `roomTypeId` in memory before it locks inventory. Under
   * ReadCommitted a move committing in that window leaves the cancellation
   * releasing a category the stay no longer occupies.
   *
   * Reproducing the damaging shape needs the source category to still hold a
   * *different* booking, otherwise cancellation's own `sold >= held` check
   * catches the stale read and refuses. So category A gets two rooms and a
   * second, uninvolved stay. If the stale release happens, A's counter falls
   * to 0 while that second stay is still in it — a room the hotel would sell
   * twice — and B stays incremented with nobody in it.
   *
   * Isolation is total: both categories, their rooms and their `inventory_day`
   * rows are created here. No seeded category, no shared counter and no seeded
   * reservation is read or written. Cleanup is by deletion, so a counter left
   * wrong by a genuine defect is thrown away rather than repaired by hand.
   *
   * Deletion order is dictated by the real schema, not assumed:
   *   * `ReservationRoom.roomType` and `.room` are **onDelete: Restrict**
   *     (schema.prisma:1045, :1049) - so the reservations go first;
   *   * `Room.roomType` is **Restrict** (:692) - so rooms go before the type;
   *   * `InventoryDay.roomType` is **Cascade** (:728) - so the counter rows
   *     disappear with the type, which is what makes this safe.
   * ===========================================================================
   */
  const moveNight1 = shiftDays(businessDate, 31);
  const moveNight3 = shiftDays(businessDate, 33);
  const moveDates = [
    new Date(`${moveNight1}T00:00:00.000Z`),
    new Date(`${shiftDays(businessDate, 32)}T00:00:00.000Z`),
  ];

  /** Currency is copied from a real category rather than guessed. */
  const currencySource = await prisma.roomType.findFirst({
    where: { propertyId: property.id },
    select: { currency: true },
  });
  if (currencySource === null) throw new Error('the property has no room type to copy currency from.');

  const fixture = { typeA: null, typeB: null, rooms: [], stays: [] };

  try {
    fixture.typeA = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZRCA',
        name: 'ZZ Cancellation Race A',
        maxGuests: 2,
        baseRateMinor: 100000,
        currency: currencySource.currency,
      },
      select: { id: true },
    });
    fixture.typeB = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZRCB',
        name: 'ZZ Cancellation Race B',
        maxGuests: 2,
        baseRateMinor: 120000,
        currency: currencySource.currency,
      },
      select: { id: true },
    });

    for (const [number, typeId] of [
      ['ZZ-RC-A1', fixture.typeA.id],
      ['ZZ-RC-A2', fixture.typeA.id],
      ['ZZ-RC-B1', fixture.typeB.id],
    ]) {
      const room = await prisma.room.create({
        data: {
          propertyId: property.id,
          roomTypeId: typeId,
          number,
          status: 'VACANT_CLEAN',
        },
        select: { id: true, number: true, roomTypeId: true },
      });
      fixture.rooms.push(room);
    }

    // physical matches the rooms created above: A holds two, B holds one.
    await prisma.inventoryDay.createMany({
      data: moveDates.flatMap((stayDate) => [
        { propertyId: property.id, roomTypeId: fixture.typeA.id, stayDate, physical: 2 },
        { propertyId: property.id, roomTypeId: fixture.typeB.id, stayDate, physical: 1 },
      ]),
    });

    /**
     * Printed so an interrupted run is recoverable: these ids are the only
     * trace this step can leave behind, and deleting them in this order
     * removes everything it made.
     */
    console.log(
      `  NOTE  fixture room types A=${fixture.typeA.id} B=${fixture.typeB.id}; ` +
        `rooms ${fixture.rooms.map((room) => `${room.number}=${room.id}`).join(' ')}`,
    );

    const targetRoom = fixture.rooms.find((room) => room.roomTypeId === fixture.typeB.id);

    /** The uninvolved stay that keeps category A occupied. */
    const bystander = await createBooking(
      cookie,
      { id: fixture.typeA.id },
      moveNight1,
      moveNight3,
      { guests: [{ firstName: 'Bystander', lastName: 'Probe' }] },
    );
    fixture.stays.push(bystander.id);

    /**
     * Every category's counter, checked against the rooms actually held on
     * that specific night.
     *
     * Per date, not aggregated: a stale release moves one night's counter in
     * one category, and a property-wide or stay-wide total can net that out
     * to zero and look clean. The comparison is against live
     * `reservation_room` rows whose own date range covers the night — the
     * same thing the counter is supposed to be a cache of — rather than
     * against a number this test expects, because several race outcomes are
     * legitimate and all of them must leave the counters matching reality.
     */
    async function categoryTruth(roomTypeId) {
      const [counters, rows] = await Promise.all([
        soldByDate(property.id, roomTypeId, moveNight1, moveNight3),
        prisma.reservationRoom.findMany({
          where: {
            propertyId: property.id,
            roomTypeId,
            status: { notIn: ['CANCELLED', 'NO_SHOW'] },
          },
          select: { arrivalDate: true, departureDate: true },
        }),
      ]);

      return moveDates.map((night) => {
        const date = isoDate(night);
        const held = rows.filter(
          (row) => row.arrivalDate <= night && row.departureDate > night,
        ).length;
        return { date, sold: counters.get(date)?.sold ?? null, held };
      });
    }

    const describe = (truth) =>
      truth.map((n) => `${n.date} sold ${String(n.sold)}/held ${String(n.held)}`).join(' ');

    const aSetup = await categoryTruth(fixture.typeA.id);
    const bSetup = await categoryTruth(fixture.typeB.id);
    check(
      'setup: both categories start with sold matching the rooms held',
      aSetup.every((n) => n.sold === n.held && n.sold === 1) &&
        bSetup.every((n) => n.sold === n.held && n.sold === 0),
      `A ${describe(aSetup)} | B ${describe(bSetup)}`,
    );

    /**
     * The race, run repeatedly with independent rounds.
     *
     * Each round books its own racer, races it, asserts, and then puts the
     * fixture back to "bystander only" through the real cancellation endpoint
     * — never by editing a counter — so the next round starts from a verified
     * clean state rather than from whatever the last one left.
     */
    const MOVE_ROUNDS = 3;

    for (let round = 1; round <= MOVE_ROUNDS; round += 1) {
      const racer = await createBooking(cookie, { id: fixture.typeA.id }, moveNight1, moveNight3, {
        guests: [{ firstName: 'Mover', lastName: `Probe${String(round)}` }],
      });
      fixture.stays.push(racer.id);

      const financeBefore = await financialFingerprint(property.id);

      // Issued together, so the move's transaction has a chance to land inside
      // the cancellation's read-then-lock window.
      const [cancelled, moved] = await Promise.all([
        call('POST', `/properties/${PROPERTY_CODE}/reservations/${racer.id}/cancel`, cookie, {
          reason: `Integration suite: move race ${String(round)}`,
        }),
        call('POST', `/properties/${PROPERTY_CODE}/reservations/${racer.id}/room`, cookie, {
          roomId: targetRoom.id,
          acknowledgeCategoryChange: true,
          reason: `Integration suite: move race ${String(round)}`,
        }),
      ]);

      const cancelWon = cancelled.status === 200 && cancelled.payload?.alreadyCancelled === false;
      if (cancelWon || cancelled.payload?.nightsReleased > 0) releasedByCancel.add(racer.id);

      const row = await prisma.reservation.findUnique({
        where: { id: racer.id },
        select: { status: true, cancelledAt: true },
      });
      const audits = await prisma.auditLog.count({
        where: { entityId: racer.id, event: 'RESERVATION_CANCELLED' },
      });
      const aTruth = await categoryTruth(fixture.typeA.id);
      const bTruth = await categoryTruth(fixture.typeB.id);
      const financeAfter = await financialFingerprint(property.id);

      console.log(
        `  NOTE  round ${String(round)}: cancel ${String(cancelled.status)}, move ` +
          `${String(moved.status)}${
            moved.status >= 400
              ? ` ${JSON.stringify(moved.payload?.details?.issues ?? moved.payload?.code)}`
              : ''
          } -> ${row.status}; A ${describe(aTruth)} | B ${describe(bTruth)}`,
      );

      check(
        `round ${String(round)}: neither request returned a 5xx`,
        cancelled.status < 500 && moved.status < 500,
        `cancel ${String(cancelled.status)}, move ${String(moved.status)}`,
      );
      check(
        `round ${String(round)}: no database internals reached the client`,
        ![cancelled, moved].some(
          (response) =>
            typeof response.payload?.message === 'string' &&
            /\b23\d{3}\b|SQLSTATE|P20\d{2}|constraint "|prisma/i.test(response.payload.message),
        ),
        `${JSON.stringify(cancelled.payload?.message)} | ${JSON.stringify(moved.payload?.message)}`,
      );

      /* ---- the invariant the defect broke ---- */
      check(
        `round ${String(round)}: category A sold matches rooms held, on every night`,
        aTruth.every((night) => night.sold === night.held),
        `A ${describe(aTruth)}`,
      );
      check(
        `round ${String(round)}: category B sold matches rooms held, on every night`,
        bTruth.every((night) => night.sold === night.held),
        `B ${describe(bTruth)}`,
      );

      check(
        `round ${String(round)}: the bystander is untouched and still CONFIRMED`,
        (
          await prisma.reservation.findUnique({
            where: { id: bystander.id },
            select: { status: true },
          })
        ).status === 'CONFIRMED',
      );

      const cancelledCoherently =
        row.status === 'CANCELLED' && row.cancelledAt !== null && audits === 1;
      const survivedCoherently =
        row.status !== 'CANCELLED' && row.cancelledAt === null && audits === 0;
      check(
        `round ${String(round)}: the end state is coherent (${row.status})`,
        [cancelledCoherently, survivedCoherently].filter(Boolean).length === 1,
        `cancelledAt ${row.cancelledAt === null ? 'null' : 'set'}, ${String(audits)} audit row(s)`,
      );

      check(
        `round ${String(round)}: no folio or folio line moved`,
        financeAfter.folios === financeBefore.folios &&
          financeAfter.lines === financeBefore.lines &&
          financeAfter.digest === financeBefore.digest,
        `${String(financeBefore.lines)} -> ${String(financeAfter.lines)} line(s)`,
      );

      const moveViolations = await inventoryViolations(property.id);
      check(
        `round ${String(round)}: the property is neither oversold nor negative`,
        moveViolations.oversold === 0 && moveViolations.negative === 0,
        `oversold ${String(moveViolations.oversold)}, negative ${String(moveViolations.negative)}`,
      );

      /* ---- back to a verified clean fixture for the next round ---- */
      if (row.status !== 'CANCELLED') {
        const settle = await call(
          'POST',
          `/properties/${PROPERTY_CODE}/reservations/${racer.id}/cancel`,
          cookie,
          { reason: 'Integration suite: resetting the move fixture' },
        );
        if (settle.status === 200) releasedByCancel.add(racer.id);
        check(
          `round ${String(round)}: the surviving racer cancels cleanly afterwards`,
          settle.status === 200,
          `status ${String(settle.status)}`,
        );
      }

      const aReset = await categoryTruth(fixture.typeA.id);
      const bReset = await categoryTruth(fixture.typeB.id);
      check(
        `round ${String(round)}: the fixture is back to bystander-only, counters matching`,
        aReset.every((n) => n.sold === n.held && n.sold === 1) &&
          bReset.every((n) => n.sold === n.held && n.sold === 0),
        `A ${describe(aReset)} | B ${describe(bReset)}`,
      );
    }
  } finally {
    /**
     * Deleted in the order the schema's Restrict rules demand: stays, then
     * rooms, then the categories - whose `inventory_day` rows cascade away
     * with them. Each failure is reported rather than swallowed, because a
     * leftover category is the one trace this step can leave.
     */
    for (const stayId of fixture.stays) {
      await prisma.reservation.delete({ where: { id: stayId } }).catch((error) => {
        console.error(`  (fixture stay ${stayId} not deleted: ${error.message})`);
      });
      // Taken off the teardown list once it is gone, so teardown does not log
      // a failed delete for a row this step already removed.
      const at = created.indexOf(stayId);
      if (at !== -1) created.splice(at, 1);
    }
    for (const room of fixture.rooms) {
      await prisma.room.delete({ where: { id: room.id } }).catch((error) => {
        console.error(`  (fixture room ${room.number} not deleted: ${error.message})`);
      });
    }
    for (const type of [fixture.typeA, fixture.typeB]) {
      if (type === null) continue;
      await prisma.roomType.delete({ where: { id: type.id } }).catch((error) => {
        console.error(`  (fixture room type ${type.id} not deleted: ${error.message})`);
      });
    }

    const leftovers = await prisma.roomType.count({
      where: { propertyId: property.id, code: { in: ['ZZRCA', 'ZZRCB'] } },
    });
    check('the fixture categories, rooms and inventory rows are gone', leftovers === 0, `${String(leftovers)} left`);
  }

  /* ------------------------------------------------------------------- 13 */
  console.log('\n13. Check-in racing a cross-category room move.');

  /**
   * The suspected stale-assignment race, probed with nothing production
   * changed.
   *
   * ===========================================================================
   * `check-in.service.ts` validates the room's category OUTSIDE its
   * transaction, against the assignment it loaded there:
   *
   *     targetRoom.roomTypeId !== assignment.roomTypeId   (:210-214)
   *
   * Inside the transaction it re-reads the **status** and nothing else
   * (:320-335), then writes `roomId` onto the assignment while never writing
   * `roomTypeId` (:362-368). A cross-category move rewrites exactly that
   * `roomTypeId` and moves the counter with it.
   *
   * Both now take the reservation row `FOR UPDATE`, so one ordering is
   * already safe: check-in first, and the move's own assignment re-read
   * refuses (`room-move.service.ts:340`). The other ordering is what this
   * step exists to settle - the move commits first, check-in then finds the
   * status unchanged and proceeds on a category it read before the lock.
   *
   * The invariant that decides it is not "who won". Several outcomes are
   * legitimate. What must hold is that the stay's physical room and its
   * category agree, and that each category's counter matches the rooms
   * actually held in it, per night.
   *
   * Isolation follows step 12 exactly: suite-owned categories, rooms and
   * `inventory_day` rows, created here and deleted here. No seeded category
   * is used and no shared counter is touched by hand. Arrival must be the
   * business date, because `blockersFor` raises `ARRIVAL_IN_FUTURE` for
   * anything later (`check-in.service.ts:402`), so this step cannot borrow a
   * far-future window the way step 12 does.
   * ===========================================================================
   */
  const ciRounds = 5;
  const ciNight = new Date(`${businessDate}T00:00:00.000Z`);
  const ciDeparture = shiftDays(businessDate, 1);

  const ciFixture = { typeA: null, typeB: null, rooms: [], stays: [] };

  try {
    const ciCurrency = await prisma.roomType.findFirst({
      where: { propertyId: property.id },
      select: { currency: true },
    });

    ciFixture.typeA = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZCIA',
        name: 'ZZ Check-in Race A',
        maxGuests: 2,
        baseRateMinor: 100000,
        currency: ciCurrency.currency,
      },
      select: { id: true },
    });
    ciFixture.typeB = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZCIB',
        name: 'ZZ Check-in Race B',
        maxGuests: 2,
        baseRateMinor: 120000,
        currency: ciCurrency.currency,
      },
      select: { id: true },
    });

    /**
     * One room per round in each category, so a round that checks a guest
     * into an A room does not starve the next round. Nothing is reset
     * between rounds; the assertions read live state, so accumulation is
     * fine and avoids resetting through an endpoint that would refuse a
     * checked-in stay anyway.
     */
    for (let i = 1; i <= ciRounds; i += 1) {
      for (const [prefix, typeId] of [
        ['ZZ-CI-A', ciFixture.typeA.id],
        ['ZZ-CI-B', ciFixture.typeB.id],
      ]) {
        const room = await prisma.room.create({
          data: {
            propertyId: property.id,
            roomTypeId: typeId,
            number: `${prefix}${String(i)}`,
            status: 'VACANT_CLEAN',
          },
          select: { id: true, number: true, roomTypeId: true },
        });
        ciFixture.rooms.push(room);
      }
    }

    await prisma.inventoryDay.createMany({
      data: [
        {
          propertyId: property.id,
          roomTypeId: ciFixture.typeA.id,
          stayDate: ciNight,
          physical: ciRounds,
        },
        {
          propertyId: property.id,
          roomTypeId: ciFixture.typeB.id,
          stayDate: ciNight,
          physical: ciRounds,
        },
      ],
    });

    console.log(
      `  NOTE  fixture room types A=${ciFixture.typeA.id} B=${ciFixture.typeB.id}; ` +
        `rooms ${ciFixture.rooms.map((room) => `${room.number}=${room.id}`).join(' ')}`,
    );

    /**
     * Each category's counter against the rooms genuinely held on the night,
     * plus the assignment-coherence facts this step is really about.
     */
    async function ciTruth() {
      const [aDay, bDay, rows] = await Promise.all([
        soldByDate(property.id, ciFixture.typeA.id, businessDate, ciDeparture),
        soldByDate(property.id, ciFixture.typeB.id, businessDate, ciDeparture),
        prisma.reservationRoom.findMany({
          where: {
            propertyId: property.id,
            roomTypeId: { in: [ciFixture.typeA.id, ciFixture.typeB.id] },
            status: { notIn: ['CANCELLED', 'NO_SHOW'] },
          },
          select: {
            reservationId: true,
            roomTypeId: true,
            roomId: true,
            room: { select: { number: true, roomTypeId: true } },
          },
        }),
      ]);

      return {
        soldA: aDay.get(businessDate)?.sold ?? null,
        soldB: bDay.get(businessDate)?.sold ?? null,
        heldA: rows.filter((row) => row.roomTypeId === ciFixture.typeA.id).length,
        heldB: rows.filter((row) => row.roomTypeId === ciFixture.typeB.id).length,
        rows,
      };
    }

    for (let round = 1; round <= ciRounds; round += 1) {
      const roomA = ciFixture.rooms.find((room) => room.number === `ZZ-CI-A${String(round)}`);
      const roomB = ciFixture.rooms.find((room) => room.number === `ZZ-CI-B${String(round)}`);

      const stay = await createBooking(
        cookie,
        { id: ciFixture.typeA.id },
        businessDate,
        ciDeparture,
        {
          guests: [
            {
              firstName: 'Shuffle',
              lastName: `Probe${String(round)}`,
              govtIdType: 'PASSPORT',
              govtIdNumber: `CANCELSHUF${String(round)}`,
            },
          ],
        },
      );
      ciFixture.stays.push(stay.id);

      const financeBefore = await financialFingerprint(property.id);

      // Issued together: the move's transaction gets its chance to commit
      // inside check-in's read-then-lock window.
      const [moved, checkedIn] = await Promise.all([
        call('POST', `/properties/${PROPERTY_CODE}/reservations/${stay.id}/room`, cookie, {
          roomId: roomB.id,
          acknowledgeCategoryChange: true,
          reason: `Integration suite: check-in vs move ${String(round)}`,
        }),
        call('POST', `/properties/${PROPERTY_CODE}/reservations/${stay.id}/check-in`, cookie, {
          roomId: roomA.id,
          primaryGuestIdType: 'PASSPORT',
          primaryGuestIdNumber: `CANCELSHUF${String(round)}`,
          keyCardsIssued: 1,
          registrationCardSigned: true,
          acknowledgeRoomNotClean: true,
          initialPayment: null,
        }),
      ]);

      const truth = await ciTruth();
      const mine = truth.rows.filter((row) => row.reservationId === stay.id);
      const row = await prisma.reservation.findUnique({
        where: { id: stay.id },
        select: { status: true, cancelledAt: true },
      });
      const financeAfter = await financialFingerprint(property.id);
      const folios = await prisma.folio.count({ where: { reservationId: stay.id } });

      const describeMine = mine
        .map(
          (r) =>
            `category ${r.roomTypeId === ciFixture.typeA.id ? 'A' : 'B'} / room ` +
            `${r.room?.number ?? 'none'}${
              r.room === null
                ? ''
                : ` (category ${r.room.roomTypeId === ciFixture.typeA.id ? 'A' : 'B'})`
            }`,
        )
        .join('; ');

      console.log(
        `  NOTE  round ${String(round)}: move ${String(moved.status)}` +
          `${
            moved.status >= 400
              ? ` ${JSON.stringify(moved.payload?.details?.issues ?? moved.payload?.code)}`
              : ''
          }, check-in ${String(checkedIn.status)}` +
          `${
            checkedIn.status >= 400
              ? ` ${JSON.stringify(checkedIn.payload?.details ?? checkedIn.payload?.code)}`
              : ''
          } -> ${row.status}; assignment ${describeMine}; ` +
          `soldA ${String(truth.soldA)}/heldA ${String(truth.heldA)} ` +
          `soldB ${String(truth.soldB)}/heldB ${String(truth.heldB)}`,
      );

      check(
        `round ${String(round)}: neither request returned a 5xx`,
        moved.status < 500 && checkedIn.status < 500,
        `move ${String(moved.status)}, check-in ${String(checkedIn.status)}`,
      );
      check(
        `round ${String(round)}: no database internals reached the client`,
        ![moved, checkedIn].some(
          (response) =>
            typeof response.payload?.message === 'string' &&
            /\b23\d{3}\b|SQLSTATE|P20\d{2}|constraint "|prisma/i.test(response.payload.message),
        ),
        `${JSON.stringify(moved.payload?.message)} | ${JSON.stringify(checkedIn.payload?.message)}`,
      );

      /**
       * The assignment must describe a possible room.
       *
       * This is the whole question. A `roomId` pointing at a room whose own
       * category differs from the row's `roomTypeId` means the guest is in
       * one category while the counters say another - the state check-in's
       * pre-transaction category guard exists to prevent.
       */
      check(
        `round ${String(round)}: the assigned room's category matches the assignment`,
        mine.every((r) => r.room === null || r.room.roomTypeId === r.roomTypeId),
        describeMine === '' ? 'no live room row' : describeMine,
      );

      check(
        `round ${String(round)}: category A sold matches the rooms held in it`,
        truth.soldA === truth.heldA,
        `sold ${String(truth.soldA)} vs ${String(truth.heldA)} held`,
      );
      check(
        `round ${String(round)}: category B sold matches the rooms held in it`,
        truth.soldB === truth.heldB,
        `sold ${String(truth.soldB)} vs ${String(truth.heldB)} held`,
      );

      /**
       * Money follows the check-in, not the move: a check-in that succeeded
       * must have opened its arrival folio, and one that was refused must
       * have left the ledger exactly as it found it.
       */
      if (checkedIn.status === 201) {
        check(
          `round ${String(round)}: the successful check-in opened its folio`,
          folios > 0 && financeAfter.lines > financeBefore.lines,
          `${String(folios)} folio(s), ${String(financeBefore.lines)} -> ${String(financeAfter.lines)} line(s)`,
        );
      } else {
        check(
          `round ${String(round)}: the refused check-in moved no money`,
          folios === 0 &&
            financeAfter.lines === financeBefore.lines &&
            financeAfter.digest === financeBefore.digest,
          `${String(folios)} folio(s), ${String(financeBefore.lines)} -> ${String(financeAfter.lines)} line(s)`,
        );
      }

      check(
        `round ${String(round)}: the stay is CONFIRMED or CHECKED_IN, never cancelled`,
        (row.status === 'CONFIRMED' || row.status === 'CHECKED_IN') && row.cancelledAt === null,
        `status ${row.status}`,
      );

      const ciViolations = await inventoryViolations(property.id);
      check(
        `round ${String(round)}: the property is neither oversold nor negative`,
        ciViolations.oversold === 0 && ciViolations.negative === 0,
        `oversold ${String(ciViolations.oversold)}, negative ${String(ciViolations.negative)}`,
      );
    }
  } finally {
    // Restrict order, same as step 12: stays, then rooms, then the
    // categories, whose inventory_day rows cascade away with them.
    for (const stayId of ciFixture.stays) {
      await prisma.reservation.delete({ where: { id: stayId } }).catch((error) => {
        console.error(`  (fixture stay ${stayId} not deleted: ${error.message})`);
      });
      const at = created.indexOf(stayId);
      if (at !== -1) created.splice(at, 1);
    }
    for (const room of ciFixture.rooms) {
      await prisma.room.delete({ where: { id: room.id } }).catch((error) => {
        console.error(`  (fixture room ${room.number} not deleted: ${error.message})`);
      });
    }
    for (const type of [ciFixture.typeA, ciFixture.typeB]) {
      if (type === null) continue;
      await prisma.roomType.delete({ where: { id: type.id } }).catch((error) => {
        console.error(`  (fixture room type ${type.id} not deleted: ${error.message})`);
      });
    }

    const ciLeftovers = await prisma.roomType.count({
      where: { propertyId: property.id, code: { in: ['ZZCIA', 'ZZCIB'] } },
    });
    check(
      'the check-in race fixture is completely gone',
      ciLeftovers === 0,
      `${String(ciLeftovers)} left`,
    );
  }

  /* ------------------------------------------------------------------ 13b */
  console.log('\n13b. The stale-assignment guards, made deterministic.');

  /**
   * Step 13 reproduces the race honestly but only when timing cooperates -
   * once in fifteen attempts. That is a probe, not a gate: a regression could
   * sit green for runs on end. This step pins the same two orderings so they
   * happen every time.
   *
   * ===========================================================================
   * How, without a single production hook.
   *
   * Both check-in and room-move now take the reservation row `FOR UPDATE`
   * before they validate anything that another transaction can move. So this
   * suite takes that lock first, from its own transaction:
   *
   *   1. hold `reservation ... FOR UPDATE` on the suite's own stay;
   *   2. fire the real endpoint under test - it completes its pre-transaction
   *      reads (the ones whose answers go stale) and then blocks on the lock,
   *      which is CONFIRMED by watching `pg_stat_activity`, not assumed;
   *   3. inside the holding transaction, apply the committed effect of the
   *      competing operation;
   *   4. release. The endpoint now acquires the lock and re-reads - and must
   *      refuse, because what it validated before the lock is no longer true.
   *
   * The lock is what makes this deterministic: the endpoint physically cannot
   * reach its re-read until step 4, however fast or slow the machine is.
   *
   * Step 3 writes the competing operation's effect directly rather than
   * calling its endpoint, because that endpoint would block on the very lock
   * this needs to hold. The writes are the same ones the real services make
   * (`room-move.service.ts:365-391` for a category change, check-in's own
   * `reservationRoom.update` for the assignment), and they touch ONLY this
   * step's own categories, rooms and `inventory_day` rows - created here,
   * deleted here, never a seeded category or a shared counter. The fixture is
   * left self-consistent, so the sold-versus-held assertions below are
   * meaningful rather than measuring damage this suite did.
   * ===========================================================================
   */
  const detFixture = { typeA: null, typeB: null, rooms: [], stays: [] };

  try {
    const detCurrency = await prisma.roomType.findFirst({
      where: { propertyId: property.id },
      select: { currency: true },
    });

    detFixture.typeA = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZDTA',
        name: 'ZZ Deterministic A',
        maxGuests: 2,
        baseRateMinor: 100000,
        currency: detCurrency.currency,
      },
      select: { id: true },
    });
    detFixture.typeB = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZDTB',
        name: 'ZZ Deterministic B',
        maxGuests: 2,
        baseRateMinor: 120000,
        currency: detCurrency.currency,
      },
      select: { id: true },
    });

    for (const [number, typeId] of [
      ['ZZ-DT-A1', detFixture.typeA.id],
      ['ZZ-DT-A2', detFixture.typeA.id],
      ['ZZ-DT-B1', detFixture.typeB.id],
      ['ZZ-DT-B2', detFixture.typeB.id],
    ]) {
      const room = await prisma.room.create({
        data: { propertyId: property.id, roomTypeId: typeId, number, status: 'VACANT_CLEAN' },
        select: { id: true, number: true, roomTypeId: true },
      });
      detFixture.rooms.push(room);
    }

    const detNight = new Date(`${businessDate}T00:00:00.000Z`);
    const detDeparture = shiftDays(businessDate, 1);

    await prisma.inventoryDay.createMany({
      data: [
        { propertyId: property.id, roomTypeId: detFixture.typeA.id, stayDate: detNight, physical: 2 },
        { propertyId: property.id, roomTypeId: detFixture.typeB.id, stayDate: detNight, physical: 2 },
      ],
    });

    console.log(
      `  NOTE  fixture room types A=${detFixture.typeA.id} B=${detFixture.typeB.id}; ` +
        `rooms ${detFixture.rooms.map((r) => `${r.number}=${r.id}`).join(' ')}`,
    );

    const roomOf = (number) => detFixture.rooms.find((r) => r.number === number);
    const categoryOf = (typeId) => (typeId === detFixture.typeA.id ? 'A' : 'B');

    /** Backends parked on a lock in this database — the proof of step 2. */
    async function lockWaiters() {
      const rows = await prisma.$queryRaw`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'`;
      return Number(rows[0].waiting);
    }

    /**
     * Hold the stay's row, let `fire()` reach the lock and stall there, apply
     * `mutate()` behind it, then release.
     *
     * The gate is created before the transaction awaits it, so `release` is
     * never an unassigned no-op — the same correction step 7c needed.
     */
    async function raceUnderLock(stayId, fire, mutate) {
      let release = () => {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let holding = false;
      let blocked = false;

      const holder = prisma
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM reservation WHERE "id" = ${stayId}::uuid FOR UPDATE`;
            holding = true;
            await gate;
            await mutate(tx);
          },
          { timeout: 25_000, maxWait: 10_000 },
        )
        .catch((error) => {
          console.error(`  (holder transaction failed: ${error.message})`);
        });

      for (let i = 0; i < 200 && !holding; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // Issued but not awaited: it will stall on the lock above.
      const pending = fire();

      // Confirmed blocked, rather than trusting a sleep to be long enough.
      for (let i = 0; i < 200 && !blocked; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        blocked = (await lockWaiters()) > 0;
      }

      release();
      await holder;
      return { response: await pending, holding, blocked };
    }

    /* ---------------------------------------------------------------- i --- */
    console.log('\n  i. A move that commits first refuses the stale check-in.');

    const staleStay = await createBooking(
      cookie,
      { id: detFixture.typeA.id },
      businessDate,
      detDeparture,
      {
        guests: [
          {
            firstName: 'Stale',
            lastName: 'Probe',
            govtIdType: 'PASSPORT',
            govtIdNumber: 'CANCELDET1',
          },
        ],
      },
    );
    detFixture.stays.push(staleStay.id);

    const staleRow = await prisma.reservationRoom.findFirst({
      where: { reservationId: staleStay.id },
      select: { id: true },
    });
    const financeBeforeStale = await financialFingerprint(property.id);

    const staleResult = await raceUnderLock(
      staleStay.id,
      () =>
        call('POST', `/properties/${PROPERTY_CODE}/reservations/${staleStay.id}/check-in`, cookie, {
          roomId: roomOf('ZZ-DT-A1').id,
          primaryGuestIdType: 'PASSPORT',
          primaryGuestIdNumber: 'CANCELDET1',
          keyCardsIssued: 1,
          registrationCardSigned: true,
          acknowledgeRoomNotClean: true,
          initialPayment: null,
        }),
      // Exactly what a cross-category move commits: the assignment's category
      // and room, and the night moved from one counter to the other.
      async (tx) => {
        await tx.$executeRaw`
          UPDATE reservation_room
          SET "roomTypeId" = ${detFixture.typeB.id}::uuid, "roomId" = ${roomOf('ZZ-DT-B1').id}::uuid
          WHERE "id" = ${staleRow.id}::uuid`;
        await tx.$executeRaw`
          UPDATE inventory_day SET "sold" = "sold" - 1
          WHERE "propertyId" = ${property.id}::uuid
            AND "roomTypeId" = ${detFixture.typeA.id}::uuid
            AND "stayDate" = ${detNight}`;
        await tx.$executeRaw`
          UPDATE inventory_day SET "sold" = "sold" + 1
          WHERE "propertyId" = ${property.id}::uuid
            AND "roomTypeId" = ${detFixture.typeB.id}::uuid
            AND "stayDate" = ${detNight}`;
      },
    );

    check('the suite held the stay row and the check-in stalled on it', staleResult.holding && staleResult.blocked, `holding ${String(staleResult.holding)}, blocked ${String(staleResult.blocked)}`);

    const stale = staleResult.response;
    console.log(
      `  NOTE  check-in answered ${String(stale.status)} ` +
        `${JSON.stringify(stale.payload?.details?.issues ?? stale.payload?.code)}`,
    );

    check(
      'the stale check-in is refused 400 VALIDATION_FAILED',
      stale.status === 400 && stale.payload?.code === 'VALIDATION_FAILED',
      `status ${String(stale.status)}, code ${String(stale.payload?.code)}`,
    );
    check(
      'the refusal is keyed on roomId and says the stay was moved',
      typeof stale.payload?.details?.issues?.roomId === 'string' &&
        /moved by someone else/i.test(stale.payload.details.issues.roomId),
      JSON.stringify(stale.payload?.details?.issues?.roomId),
    );
    check(
      'it is not a 5xx and leaks no database internals',
      stale.status < 500 &&
        !/\b23\d{3}\b|SQLSTATE|P20\d{2}|constraint "|prisma/i.test(
          JSON.stringify(stale.payload ?? {}),
        ),
    );

    const staleAfter = await prisma.reservation.findUnique({
      where: { id: staleStay.id },
      select: {
        status: true,
        cancelledAt: true,
        rooms: {
          select: {
            roomTypeId: true,
            roomId: true,
            status: true,
            room: { select: { number: true, roomTypeId: true } },
          },
        },
      },
    });

    check(
      'the stay was not checked in',
      staleAfter.status === 'CONFIRMED' && staleAfter.cancelledAt === null,
      `status ${staleAfter.status}`,
    );
    check(
      'the check-in did not retarget the stay to the room it chose',
      staleAfter.rooms.every((r) => r.roomId === roomOf('ZZ-DT-B1').id),
      staleAfter.rooms
        .map((r) => `${categoryOf(r.roomTypeId)}/${r.room?.number ?? 'none'}`)
        .join(' '),
    );
    check(
      'roomId and roomTypeId agree — the room is in the category the row names',
      staleAfter.rooms.every((r) => r.room === null || r.room.roomTypeId === r.roomTypeId),
      staleAfter.rooms
        .map(
          (r) =>
            `row ${categoryOf(r.roomTypeId)} / room ${r.room?.number ?? 'none'} ` +
            `(${r.room === null ? 'none' : categoryOf(r.room.roomTypeId)})`,
        )
        .join(' '),
    );

    const financeAfterStale = await financialFingerprint(property.id);
    check(
      'the refused check-in opened no folio and moved no money',
      (await prisma.folio.count({ where: { reservationId: staleStay.id } })) === 0 &&
        financeAfterStale.lines === financeBeforeStale.lines &&
        financeAfterStale.digest === financeBeforeStale.digest,
      `${String(financeBeforeStale.lines)} -> ${String(financeAfterStale.lines)} line(s)`,
    );

    /* --------------------------------------------------------------- ii --- */
    console.log('\n  ii. A check-in that commits first refuses the stale move.');

    const movedStay = await createBooking(
      cookie,
      { id: detFixture.typeA.id },
      businessDate,
      detDeparture,
      {
        guests: [
          {
            firstName: 'Mover',
            lastName: 'Probe',
            govtIdType: 'PASSPORT',
            govtIdNumber: 'CANCELDET2',
          },
        ],
      },
    );
    detFixture.stays.push(movedStay.id);

    const movedRow = await prisma.reservationRoom.findFirst({
      where: { reservationId: movedStay.id },
      select: { id: true },
    });

    const moveResult = await raceUnderLock(
      movedStay.id,
      () =>
        call('POST', `/properties/${PROPERTY_CODE}/reservations/${movedStay.id}/room`, cookie, {
          roomId: roomOf('ZZ-DT-B2').id,
          acknowledgeCategoryChange: true,
          reason: 'Integration suite: deterministic stale move',
        }),
      // What check-in commits to the assignment: the room it put the guest in.
      // The category is untouched, so this isolates the roomId half of the
      // guard, which the move's own pre-read had as null.
      async (tx) => {
        await tx.$executeRaw`
          UPDATE reservation_room SET "roomId" = ${roomOf('ZZ-DT-A2').id}::uuid
          WHERE "id" = ${movedRow.id}::uuid`;
      },
    );

    check('the suite held the stay row and the move stalled on it', moveResult.holding && moveResult.blocked, `holding ${String(moveResult.holding)}, blocked ${String(moveResult.blocked)}`);

    const staleMove = moveResult.response;
    console.log(
      `  NOTE  move answered ${String(staleMove.status)} ` +
        `${JSON.stringify(staleMove.payload?.details?.issues ?? staleMove.payload?.code)}`,
    );

    check(
      'the stale move is refused 400 VALIDATION_FAILED',
      staleMove.status === 400 && staleMove.payload?.code === 'VALIDATION_FAILED',
      `status ${String(staleMove.status)}, code ${String(staleMove.payload?.code)}`,
    );
    check(
      'it is not a 5xx and leaks no database internals',
      staleMove.status < 500 &&
        !/\b23\d{3}\b|SQLSTATE|P20\d{2}|constraint "|prisma/i.test(
          JSON.stringify(staleMove.payload ?? {}),
        ),
    );

    const movedAfter = await prisma.reservation.findUnique({
      where: { id: movedStay.id },
      select: {
        status: true,
        rooms: {
          select: {
            roomTypeId: true,
            roomId: true,
            room: { select: { number: true, roomTypeId: true } },
          },
        },
      },
    });
    check(
      'the refused move left the stay in its own category and room',
      movedAfter.rooms.every(
        (r) => r.roomTypeId === detFixture.typeA.id && r.roomId === roomOf('ZZ-DT-A2').id,
      ),
      movedAfter.rooms
        .map((r) => `${categoryOf(r.roomTypeId)}/${r.room?.number ?? 'none'}`)
        .join(' '),
    );
    check(
      'roomId and roomTypeId agree here too',
      movedAfter.rooms.every((r) => r.room === null || r.room.roomTypeId === r.roomTypeId),
    );

    /* ----------------------------- counters, per date and category ------- */
    const detRows = await prisma.reservationRoom.findMany({
      where: {
        propertyId: property.id,
        roomTypeId: { in: [detFixture.typeA.id, detFixture.typeB.id] },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      select: { roomTypeId: true, arrivalDate: true, departureDate: true },
    });

    for (const [label, typeId] of [
      ['A', detFixture.typeA.id],
      ['B', detFixture.typeB.id],
    ]) {
      const counters = await soldByDate(property.id, typeId, businessDate, detDeparture);
      const held = detRows.filter(
        (r) =>
          r.roomTypeId === typeId && r.arrivalDate <= detNight && r.departureDate > detNight,
      ).length;
      const sold = counters.get(businessDate)?.sold ?? null;
      check(
        `category ${label}: sold matches the rooms held on ${businessDate}`,
        sold === held,
        `sold ${String(sold)} vs ${String(held)} held`,
      );
    }

    const detViolations = await inventoryViolations(property.id);
    check(
      'the property is neither oversold nor negative',
      detViolations.oversold === 0 && detViolations.negative === 0,
      `oversold ${String(detViolations.oversold)}, negative ${String(detViolations.negative)}`,
    );
    check(
      'and neither refusal wrote a cancellation audit row',
      (await prisma.auditLog.count({
        where: {
          entityId: { in: detFixture.stays },
          event: 'RESERVATION_CANCELLED',
        },
      })) === 0,
    );
  } finally {
    for (const stayId of detFixture.stays) {
      await prisma.reservation.delete({ where: { id: stayId } }).catch((error) => {
        console.error(`  (fixture stay ${stayId} not deleted: ${error.message})`);
      });
      const at = created.indexOf(stayId);
      if (at !== -1) created.splice(at, 1);
    }
    for (const room of detFixture.rooms) {
      await prisma.room.delete({ where: { id: room.id } }).catch((error) => {
        console.error(`  (fixture room ${room.number} not deleted: ${error.message})`);
      });
    }
    for (const type of [detFixture.typeA, detFixture.typeB]) {
      if (type === null) continue;
      await prisma.roomType.delete({ where: { id: type.id } }).catch((error) => {
        console.error(`  (fixture room type ${type.id} not deleted: ${error.message})`);
      });
    }

    const detLeftovers = await prisma.roomType.count({
      where: { propertyId: property.id, code: { in: ['ZZDTA', 'ZZDTB'] } },
    });
    check(
      'the deterministic fixture is completely gone',
      detLeftovers === 0,
      `${String(detLeftovers)} left`,
    );
  }

  /* ------------------------------------------------------------------- 14 */
  console.log('');
  console.log('14. Bounded lock waits, and the room-conflict refusal.');

  /**
   * Three refusals that used to be 500s, each pinned deterministically.
   *
   * ===========================================================================
   * Cancellation has bounded its lock wait since M-3. Room-move and check-in
   * only started queueing on the reservation row when the stale-state fixes
   * gave them that lock, and neither had a `lock_timeout` of its own, so a
   * contended request waited as long as the holder chose to hold - the
   * unbounded case measured **39,969 ms** on the cancellation path before the
   * timeout existed. Both now set the shared `ROW_LOCK_TIMEOUT_MS`.
   *
   * The harness is the one step 13b established: this suite holds the stay's
   * row itself, so the endpoint under test is guaranteed to queue. Here it is
   * held until the endpoint gives up on its own, which is the whole point -
   * nothing releases the lock for it.
   *
   * Everything runs in categories, rooms and `inventory_day` rows this step
   * creates and deletes. No seeded category and no shared counter is touched.
   * ===========================================================================
   */
  const tmFixture = { typeA: null, typeB: null, rooms: [], stays: [] };

  try {
    const tmCurrency = await prisma.roomType.findFirst({
      where: { propertyId: property.id },
      select: { currency: true },
    });

    tmFixture.typeA = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZTOA',
        name: 'ZZ Timeout A',
        maxGuests: 2,
        baseRateMinor: 100000,
        currency: tmCurrency.currency,
      },
      select: { id: true },
    });
    tmFixture.typeB = await prisma.roomType.create({
      data: {
        propertyId: property.id,
        code: 'ZZTOB',
        name: 'ZZ Timeout B',
        maxGuests: 2,
        baseRateMinor: 120000,
        currency: tmCurrency.currency,
      },
      select: { id: true },
    });

    for (const [number, typeId] of [
      ['ZZ-TO-A1', tmFixture.typeA.id],
      ['ZZ-TO-A2', tmFixture.typeA.id],
      ['ZZ-TO-A3', tmFixture.typeA.id],
      ['ZZ-TO-A4', tmFixture.typeA.id],
      ['ZZ-TO-B1', tmFixture.typeB.id],
      ['ZZ-TO-B2', tmFixture.typeB.id],
    ]) {
      const room = await prisma.room.create({
        data: { propertyId: property.id, roomTypeId: typeId, number, status: 'VACANT_CLEAN' },
        select: { id: true, number: true, roomTypeId: true, status: true },
      });
      tmFixture.rooms.push(room);
    }

    const tmNight = new Date(`${businessDate}T00:00:00.000Z`);
    const tmDeparture = shiftDays(businessDate, 1);

    await prisma.inventoryDay.createMany({
      data: [
        { propertyId: property.id, roomTypeId: tmFixture.typeA.id, stayDate: tmNight, physical: 4 },
        { propertyId: property.id, roomTypeId: tmFixture.typeB.id, stayDate: tmNight, physical: 2 },
      ],
    });

    console.log(
      `  NOTE  fixture room types A=${tmFixture.typeA.id} B=${tmFixture.typeB.id}; ` +
        `rooms ${tmFixture.rooms.map((r) => `${r.number}=${r.id}`).join(' ')}`,
    );

    const tmRoom = (number) => tmFixture.rooms.find((r) => r.number === number);

    async function tmBook(label, idNumber) {
      const stay = await createBooking(
        cookie,
        { id: tmFixture.typeA.id },
        businessDate,
        tmDeparture,
        {
          guests: [
            {
              firstName: label,
              lastName: 'Probe',
              govtIdType: 'PASSPORT',
              govtIdNumber: idNumber,
            },
          ],
        },
      );
      tmFixture.stays.push(stay.id);
      return stay;
    }

    /**
     * Hold the stay's row and let `fire()` queue behind it until the endpoint
     * gives up by itself. The lock is released only afterwards, so the elapsed
     * time measures the endpoint's own bound and nothing else.
     */
    async function holdRowAndCall(stayId, fire) {
      let release = () => {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let holding = false;

      const holder = prisma
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM reservation WHERE "id" = ${stayId}::uuid FOR UPDATE`;
            holding = true;
            await gate;
          },
          { timeout: 30_000, maxWait: 10_000 },
        )
        .catch((error) => {
          console.error(`  (holder transaction failed: ${error.message})`);
        });

      for (let i = 0; i < 200 && !holding; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const startedAt = Date.now();
      let response = null;
      try {
        response = await fire();
      } finally {
        release();
        await holder;
      }
      return { response, ms: Date.now() - startedAt, holding };
    }

    const noLeak = (payload) =>
      !/\b23\d{3}\b|\b55P03\b|\b40P01\b|SQLSTATE|P20\d{2}|constraint "|prisma/i.test(
        JSON.stringify(payload ?? {}),
      );

    /* ---------------------------------------------------------------- i --- */
    console.log('');
    console.log('  i. A room move gives up on the lock with a typed 409.');

    const moveStay = await tmBook('Movewait', 'CANCELTMO1');
    const moveBefore = await prisma.reservationRoom.findFirst({
      where: { reservationId: moveStay.id },
      select: { roomTypeId: true, roomId: true },
    });

    const moveOut = await holdRowAndCall(moveStay.id, () =>
      call('POST', `/properties/${PROPERTY_CODE}/reservations/${moveStay.id}/room`, cookie, {
        roomId: tmRoom('ZZ-TO-B1').id,
        acknowledgeCategoryChange: true,
        reason: 'Integration suite: lock-timeout probe',
      }),
    );

    console.log(
      `  NOTE  move answered ${String(moveOut.response.status)} ` +
        `${String(moveOut.response.payload?.code)} in ${String(moveOut.ms)}ms`,
    );

    check('the suite held the stay row for the move', moveOut.holding);
    check(
      'the move is answered 409 CONFLICT, not a 500',
      moveOut.response.status === 409 && moveOut.response.payload?.code === 'CONFLICT',
      `status ${String(moveOut.response.status)}, code ${String(moveOut.response.payload?.code)}`,
    );
    check(
      'it gave up in seconds rather than when the holder let go',
      moveOut.ms < 8_000,
      `${String(moveOut.ms)}ms, cap 8000ms`,
    );
    check('no database internals reached the client', noLeak(moveOut.response.payload));

    const moveAfter = await prisma.reservationRoom.findFirst({
      where: { reservationId: moveStay.id },
      select: { roomTypeId: true, roomId: true },
    });
    check(
      'the assignment is untouched - the move rolled back whole',
      moveAfter.roomTypeId === moveBefore.roomTypeId && moveAfter.roomId === moveBefore.roomId,
    );

    /* --------------------------------------------------------------- ii --- */
    console.log('');
    console.log('  ii. A check-in gives up on the lock with a typed 409.');

    const ciStay = await tmBook('Checkinwait', 'CANCELTMO2');

    const ciOut = await holdRowAndCall(ciStay.id, () =>
      call('POST', `/properties/${PROPERTY_CODE}/reservations/${ciStay.id}/check-in`, cookie, {
        roomId: tmRoom('ZZ-TO-A1').id,
        primaryGuestIdType: 'PASSPORT',
        primaryGuestIdNumber: 'CANCELTMO2',
        keyCardsIssued: 1,
        registrationCardSigned: true,
        acknowledgeRoomNotClean: true,
        initialPayment: null,
      }),
    );

    console.log(
      `  NOTE  check-in answered ${String(ciOut.response.status)} ` +
        `${String(ciOut.response.payload?.code)} in ${String(ciOut.ms)}ms`,
    );

    check('the suite held the stay row for the check-in', ciOut.holding);
    check(
      'the check-in is answered 409 CONFLICT, not a 500',
      ciOut.response.status === 409 && ciOut.response.payload?.code === 'CONFLICT',
      `status ${String(ciOut.response.status)}, code ${String(ciOut.response.payload?.code)}`,
    );
    check(
      'it gave up in seconds rather than when the holder let go',
      ciOut.ms < 8_000,
      `${String(ciOut.ms)}ms, cap 8000ms`,
    );
    check('no database internals reached the client', noLeak(ciOut.response.payload));

    const ciRow = await prisma.reservation.findUnique({
      where: { id: ciStay.id },
      select: { status: true, checkedInAt: true },
    });
    check(
      'the stay was not checked in and opened no folio',
      ciRow.status === 'CONFIRMED' &&
        ciRow.checkedInAt === null &&
        (await prisma.folio.count({ where: { reservationId: ciStay.id } })) === 0,
      `status ${ciRow.status}`,
    );

    /* -------------------------------------------------------------- iii --- */
    console.log('');
    console.log('  iii. A room already held by another stay is refused, not a 500.');

    /**
     * The exclusion constraint, reached on purpose.
     *
     * `reservation_room_no_overlap` is the only thing that actually stops two
     * stays holding one physical room; the `ROOM_OCCUPIED` blocker reads
     * `room.status`, which is a separate mirror updated by the check-in
     * itself. During a real race two clerks both read that mirror before
     * either has written it, pass the blocker, and one of them meets the
     * constraint.
     *
     * Rather than race for it, the mirror is put back to `VACANT_CLEAN` on
     * this step's own fixture room - exactly the state the blocker can observe
     * mid-race - so the second check-in passes the pre-flight check and
     * reaches the constraint every time. The constraint stays the authority;
     * this only proves what the clerk is told when it speaks.
     */
    const heldStay = await tmBook('Holder', 'CANCELTMO3');
    const firstIn = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${heldStay.id}/check-in`,
      cookie,
      {
        roomId: tmRoom('ZZ-TO-A2').id,
        primaryGuestIdType: 'PASSPORT',
        primaryGuestIdNumber: 'CANCELTMO3',
        keyCardsIssued: 1,
        registrationCardSigned: true,
        acknowledgeRoomNotClean: true,
        initialPayment: null,
      },
    );
    check(
      'the first stay checks into the room normally',
      firstIn.status === 201,
      `status ${String(firstIn.status)}`,
    );

    await prisma.room.update({
      where: { id: tmRoom('ZZ-TO-A2').id },
      data: { status: 'VACANT_CLEAN' },
    });

    const clashStay = await tmBook('Clash', 'CANCELTMO4');
    const financeBeforeClash = await financialFingerprint(property.id);

    const clash = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/reservations/${clashStay.id}/check-in`,
      cookie,
      {
        roomId: tmRoom('ZZ-TO-A2').id,
        primaryGuestIdType: 'PASSPORT',
        primaryGuestIdNumber: 'CANCELTMO4',
        keyCardsIssued: 1,
        registrationCardSigned: true,
        acknowledgeRoomNotClean: true,
        initialPayment: null,
      },
    );

    console.log(
      `  NOTE  clashing check-in answered ${String(clash.status)} ` +
        `${JSON.stringify(clash.payload?.code)} ${JSON.stringify(clash.payload?.message)}`,
    );

    check(
      'the clashing check-in is not a 5xx',
      clash.status < 500,
      `status ${String(clash.status)}`,
    );
    check(
      'it is the typed ROOM_UNAVAILABLE refusal',
      clash.status === 409 && clash.payload?.code === 'ROOM_UNAVAILABLE',
      `status ${String(clash.status)}, code ${String(clash.payload?.code)}`,
    );
    check(
      'the message names the room, not the constraint',
      typeof clash.payload?.message === 'string' && noLeak(clash.payload),
      JSON.stringify(clash.payload?.message),
    );

    const clashRow = await prisma.reservation.findUnique({
      where: { id: clashStay.id },
      select: { status: true, checkedInAt: true },
    });
    check(
      'the clashing stay was not checked in and opened no folio',
      clashRow.status === 'CONFIRMED' &&
        clashRow.checkedInAt === null &&
        (await prisma.folio.count({ where: { reservationId: clashStay.id } })) === 0,
      `status ${clashRow.status}`,
    );
    check(
      'the stay that holds the room is unaffected',
      (
        await prisma.reservation.findUnique({
          where: { id: heldStay.id },
          select: { status: true },
        })
      ).status === 'CHECKED_IN',
    );

    const financeAfterClash = await financialFingerprint(property.id);
    check(
      'the refused check-in moved no money',
      financeAfterClash.lines === financeBeforeClash.lines &&
        financeAfterClash.digest === financeBeforeClash.digest,
      `${String(financeBeforeClash.lines)} -> ${String(financeAfterClash.lines)} line(s)`,
    );

    /* ------------------------------- counters, per date and category ----- */
    const tmRows = await prisma.reservationRoom.findMany({
      where: {
        propertyId: property.id,
        roomTypeId: { in: [tmFixture.typeA.id, tmFixture.typeB.id] },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      select: { roomTypeId: true, arrivalDate: true, departureDate: true },
    });

    for (const [label, typeId] of [
      ['A', tmFixture.typeA.id],
      ['B', tmFixture.typeB.id],
    ]) {
      const counters = await soldByDate(property.id, typeId, businessDate, tmDeparture);
      const held = tmRows.filter(
        (r) => r.roomTypeId === typeId && r.arrivalDate <= tmNight && r.departureDate > tmNight,
      ).length;
      const sold = counters.get(businessDate)?.sold ?? null;
      check(
        `category ${label}: sold matches the rooms held on ${businessDate}`,
        sold === held,
        `sold ${String(sold)} vs ${String(held)} held`,
      );
    }

    const tmViolations = await inventoryViolations(property.id);
    check(
      'the property is neither oversold nor negative',
      tmViolations.oversold === 0 && tmViolations.negative === 0,
      `oversold ${String(tmViolations.oversold)}, negative ${String(tmViolations.negative)}`,
    );
  } finally {
    for (const stayId of tmFixture.stays) {
      await prisma.reservation.delete({ where: { id: stayId } }).catch((error) => {
        console.error(`  (fixture stay ${stayId} not deleted: ${error.message})`);
      });
      const at = created.indexOf(stayId);
      if (at !== -1) created.splice(at, 1);
    }
    for (const room of tmFixture.rooms) {
      await prisma.room.delete({ where: { id: room.id } }).catch((error) => {
        console.error(`  (fixture room ${room.number} not deleted: ${error.message})`);
      });
    }
    for (const type of [tmFixture.typeA, tmFixture.typeB]) {
      if (type === null) continue;
      await prisma.roomType.delete({ where: { id: type.id } }).catch((error) => {
        console.error(`  (fixture room type ${type.id} not deleted: ${error.message})`);
      });
    }

    const tmLeftovers = await prisma.roomType.count({
      where: { propertyId: property.id, code: { in: ['ZZTOA', 'ZZTOB'] } },
    });
    check(
      'the lock-timeout fixture is completely gone',
      tmLeftovers === 0,
      `${String(tmLeftovers)} left`,
    );
  }
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
