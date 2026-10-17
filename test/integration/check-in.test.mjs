/**
 * The check-in suite.
 *
 * ===========================================================================
 * CLAUDE.md section 6.3: reservation, folio and night-audit code ships with
 * tests in the same change. Check-in touches all three — it moves reservation
 * state, opens a folio, posts money onto it, and posts the arrival night that
 * the night audit would otherwise post itself.
 *
 * Like the race suite beside it, this runs against a **real Postgres with the
 * real constraints**, through the real HTTP endpoint. Section 5 says why: an
 * in-memory fake cannot prove constraint behaviour, and the guarantees here
 * live in constraints —
 *
 *   * `folio_line_one_room_charge_per_date` — night one is charged once, even
 *     though both check-in and the night audit want to post it.
 *   * `folio_line_sign_matches_kind` — a payment cannot be stored positive,
 *     so the balance stays a plain sum.
 *   * `folio_line_same_property_as_folio` — a line cannot land on another
 *     hotel's folio.
 *
 * What it asserts, in order: the pre-flight blocker list; that a missing
 * government ID refuses; that a dirty room refuses unless acknowledged; that
 * the folio balance equals the sum of its lines, in the API and in the
 * database; that the room is occupied and the audit row names the actor and
 * the override; that a second check-in is refused and night one is still
 * posted once; that another property's reservation 404s rather than 403s;
 * that a housekeeping grant cannot reach the endpoint at all; and that the
 * create modal's "check in now" leaves exactly the same folio behind.
 *
 * Everything it creates is removed in teardown, including on failure.
 * ===========================================================================
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Same resolution as the race suite: the repo's `.env`, then the root one. */
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

// The repo's factory, not `new PrismaClient()`: Prisma 7 needs a driver
// adapter, and the factory is where the adapter and the tenancy extension are
// configured. Bypassing it would exercise a different client than the API uses.
const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;

const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4000/api/v1';
const PROPERTY_CODE = process.env.EASEIT_PROPERTY ?? '31001';

const prisma = createPrismaClient();
const created = [];
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

function shiftDays(iso, days) {
  return isoDate(new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + days * 86_400_000));
}

const rupees = (minor) => `INR ${(minor / 100).toFixed(2)}`;

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
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The booking under test is **created through the real create endpoint**,
 * never by editing a seeded row.
 *
 * Moving a seeded stay's dates collides with `reservation_room_no_overlap` —
 * which is that constraint doing its job — and would make this suite's setup
 * depend on whichever dates the seeder happened to pick.
 *
 * It arrives on the business date, so `ARRIVAL_IN_FUTURE` is not in the way,
 * and holds a category rather than a room number, so the room is chosen at
 * check-in: the common front-desk case.
 */
async function createProbeBooking(cookie, property, roomType, arrival, departure, overrides = {}) {
  const response = await call('POST', `/properties/${PROPERTY_CODE}/reservations`, cookie, {
    roomTypeId: roomType.id,
    roomId: null,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    // Deliberately no government ID: it is captured at the desk below.
    guests: [{ firstName: 'Checkin', lastName: 'Probe' }],
    isInstantCheckIn: false,
    ...overrides,
  });

  if (response.status !== 201) {
    throw new Error(`fixture booking failed: ${response.status} ${JSON.stringify(response.payload)}`);
  }
  created.push(response.payload.id);
  return response.payload;
}

/** A room type with a sellable unit on every night of the stay. */
async function findSellableRoomType(property, arrival, departure) {
  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId: property.id, rooms: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  for (const roomType of roomTypes) {
    const days = await prisma.inventoryDay.findMany({
      where: {
        propertyId: property.id,
        roomTypeId: roomType.id,
        stayDate: {
          gte: new Date(`${arrival}T00:00:00.000Z`),
          lt: new Date(`${departure}T00:00:00.000Z`),
        },
      },
      select: { physical: true, overbookingAllowance: true, sold: true, blocked: true },
    });

    const nights = Math.round(
      (new Date(`${departure}T00:00:00.000Z`) - new Date(`${arrival}T00:00:00.000Z`)) / 86_400_000,
    );
    if (days.length !== nights) continue;
    if (days.every((day) => day.physical + day.overbookingAllowance - day.sold - day.blocked > 0)) {
      return roomType;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  The suite                                                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  // A user who may actually check guests in. The grant alone is not enough —
  // `reservations:checkin` is what the endpoint requires.
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
  const departure = shiftDays(businessDate, 3);

  console.log(`Property ${property.code} (${property.name})`);
  console.log(`  business date ${businessDate}, acting as ${user.email}\n`);

  const roomType = await findSellableRoomType(property, businessDate, departure);
  if (roomType === null) {
    throw new Error('no room type has inventory free for the probe stay. Run pnpm db:seed.');
  }

  const booking = await createProbeBooking(cookie, property, roomType, businessDate, departure);
  console.log(`Fixture: ${booking.bookingCode}, ${businessDate} -> ${departure}, ${rupees(booking.quote.totalMinor)} incl. ${rupees(booking.quote.taxMinor)} tax`);

  // Start the target room dirty, so the acknowledgement path is exercised
  // rather than assumed.
  const room = await prisma.room.findFirst({
    where: {
      propertyId: property.id,
      roomTypeId: roomType.id,
      status: { notIn: ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY', 'OUT_OF_ORDER'] },
    },
    select: { id: true, number: true, status: true },
    orderBy: { number: 'asc' },
  });
  if (room === null) throw new Error('no vacant room of that category for the probe.');

  const originalRoomStatus = room.status;
  restoreRooms.push({ id: room.id, status: originalRoomStatus });
  await prisma.room.update({ where: { id: room.id }, data: { status: 'VACANT_DIRTY' } });

  /* ------------------------------------------------------- pre-flight --- */
  console.log('\nPre-flight');
  const pre = await call(
    'GET',
    `/properties/${PROPERTY_CODE}/reservations/${booking.id}/check-in`,
    cookie,
  );
  check(
    'returns the stay and its blockers',
    pre.status === 200 && Array.isArray(pre.payload?.blockers),
    pre.status === 200 ? `blockers [${pre.payload.blockers.join(', ')}]` : JSON.stringify(pre.payload),
  );
  check(
    'reports an unassigned room and a missing ID',
    pre.payload?.blockers?.includes('NO_ROOM_ASSIGNED') &&
      pre.payload?.blockers?.includes('MISSING_GOVT_ID'),
  );
  check(
    'never returns the ID number raw',
    pre.payload?.govtIdMasked === null || /^X/.test(pre.payload?.govtIdMasked ?? 'X'),
    `govtIdMasked = ${JSON.stringify(pre.payload?.govtIdMasked)}`,
  );
  check(
    'offers free rooms of the booked category',
    (pre.payload?.availableRooms?.length ?? 0) > 0,
    `${pre.payload?.availableRooms?.length ?? 0} rooms`,
  );

  /* ---------------------------------------------------- the refusals --- */
  console.log('\nRefusals');
  const noId = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${booking.id}/check-in`,
    cookie,
    { roomId: room.id, keyCardsIssued: 2, acknowledgeRoomNotClean: true },
  );
  check(
    'a missing government ID refuses the check-in',
    noId.status === 400 && JSON.stringify(noId.payload).includes('MISSING_GOVT_ID'),
    `${noId.status} ${noId.payload?.code}`,
  );

  const dirty = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${booking.id}/check-in`,
    cookie,
    {
      roomId: room.id,
      primaryGuestIdType: 'AADHAAR',
      primaryGuestIdNumber: '9988 7766 5544',
      keyCardsIssued: 2,
    },
  );
  check(
    'a dirty room refuses without an acknowledgement',
    dirty.status === 400 && JSON.stringify(dirty.payload).includes('ROOM_NOT_CLEAN'),
    `${dirty.status} ${dirty.payload?.code}`,
  );

  /* ------------------------------------------------------ the check-in --- */
  console.log('\nCheck-in');
  const result = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${booking.id}/check-in`,
    cookie,
    {
      roomId: room.id,
      primaryGuestIdType: 'AADHAAR',
      primaryGuestIdNumber: '9988 7766 5544',
      keyCardsIssued: 2,
      registrationCardSigned: true,
      acknowledgeRoomNotClean: true,
      initialPayment: { method: 'UPI', amountMinor: 500000, remark: 'Advance at desk' },
    },
  );
  check(
    'acknowledged, the check-in succeeds',
    result.status === 201 && result.payload?.status === 'CHECKED_IN',
    result.status === 201
      ? `room ${result.payload.roomNumber}, ${result.payload.folio.lines.length} folio lines`
      : JSON.stringify(result.payload),
  );
  check(
    'the acknowledgement is recorded, not swallowed',
    result.payload?.roomNotCleanAcknowledged === true,
  );

  if (result.status === 201) {
    const folio = result.payload.folio;
    const summed = folio.lines.reduce((total, line) => total + line.amountMinor, 0);
    check(
      'the balance is the sum of the lines, not a stored number',
      summed === folio.balanceMinor,
      `${rupees(summed)}`,
    );
    check(
      'tax is posted as its own line beside the room charge',
      folio.lines.some((line) => line.kind === 'ROOM_CHARGE') &&
        folio.lines.some((line) => line.kind === 'TAX'),
      folio.lines.map((line) => line.kind).join(' + '),
    );
    check(
      'the payment is stored negative',
      folio.lines
        .filter((line) => line.kind === 'PAYMENT')
        .every((line) => line.amountMinor < 0),
    );

    // Re-read, because "the response says so" and "the books say so" are
    // different claims and only the second one matters.
    const lines = await prisma.folioLine.findMany({
      where: { folioId: folio.id },
      select: { amountMinor: true },
    });
    check(
      'the database agrees with the response',
      lines.reduce((total, line) => total + line.amountMinor, 0) === folio.balanceMinor,
      `${lines.length} lines summing to ${rupees(folio.balanceMinor)}`,
    );
  }

  const afterRoom = await prisma.room.findUnique({
    where: { id: room.id },
    select: { status: true },
  });
  check(
    'the room is occupied, and remembers it was dirty',
    afterRoom?.status === 'OCCUPIED_DIRTY',
    `status = ${afterRoom?.status}`,
  );

  /* -------------------------------------------------------- audit log --- */
  console.log('\nAudit');
  const auditRow = await prisma.auditLog.findFirst({
    where: { entityId: booking.id, event: 'RESERVATION_CHECKED_IN' },
    orderBy: { createdAt: 'desc' },
    select: { actorUserId: true, before: true, after: true, reason: true },
  });
  check(
    'a row names the actor, the key count and the override',
    auditRow?.actorUserId === user.id &&
      auditRow?.after?.keyCardsIssued === 2 &&
      auditRow?.after?.roomNotCleanAcknowledged === true,
    auditRow === null ? '(no row)' : JSON.stringify(auditRow.after),
  );
  check(
    'no guest ID number reaches the audit log',
    !JSON.stringify(auditRow ?? {}).includes('9988'),
  );

  /* ------------------------------------------------ the double-post --- */
  console.log('\nDouble-posting');
  const again = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/reservations/${booking.id}/check-in`,
    cookie,
    {
      roomId: room.id,
      primaryGuestIdNumber: '9988 7766 5544',
      keyCardsIssued: 2,
      acknowledgeRoomNotClean: true,
    },
  );
  check(
    'an already-checked-in guest cannot be checked in twice',
    again.status === 409 && again.payload?.code === 'INVALID_STATE_TRANSITION',
    `${again.status} ${again.payload?.code}`,
  );
  const roomCharges = await prisma.folioLine.count({
    where: { folio: { reservationId: booking.id }, kind: 'ROOM_CHARGE' },
  });
  check('night one was posted exactly once', roomCharges === 1, `${roomCharges} ROOM_CHARGE line(s)`);

  /* ----------------------------------------------------- the tenancy --- */
  console.log('\nTenant isolation');
  const foreign = await prisma.reservation.findFirst({
    where: { property: { code: { not: PROPERTY_CODE } }, status: 'CONFIRMED' },
    select: { id: true, property: { select: { code: true } } },
  });
  if (foreign === null) {
    console.log('  SKIP  no reservation at another property to probe with');
  } else {
    const leak = await call(
      'GET',
      `/properties/${PROPERTY_CODE}/reservations/${foreign.id}/check-in`,
      cookie,
    );
    check(
      "another property's reservation is 404, never 403",
      leak.status === 404,
      `${leak.status} for a stay at ${foreign.property.code}`,
    );
  }

  const housekeeping = await prisma.userPropertyRole.findFirst({
    where: { propertyId: property.id, role: { key: 'HOUSEKEEPING' } },
    select: { user: { select: { id: true, email: true } } },
  });
  if (housekeeping === null) {
    console.log('  SKIP  no housekeeping grant at this property');
  } else {
    const hkCall = await call(
      'GET',
      `/properties/${PROPERTY_CODE}/reservations/${booking.id}/check-in`,
      `easeit_session=${mintSession(housekeeping.user.id, housekeeping.user.email)}`,
    );
    check(
      'a housekeeping grant cannot reach check-in',
      hkCall.status === 403,
      `${hkCall.status} ${hkCall.payload?.code}`,
    );
  }

  /* ------------------------------------------------- the other path --- */
  // The whole point of sharing `postCheckIn` between the two pathways: an
  // instant check-in from the create modal must leave the same folio behind.
  console.log('\nInstant check-in from the create modal');
  const instantRoom = await prisma.room.findFirst({
    where: {
      propertyId: property.id,
      roomTypeId: roomType.id,
      status: { notIn: ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY', 'OUT_OF_ORDER'] },
      id: { not: room.id },
    },
    select: { id: true, number: true, status: true },
    orderBy: { number: 'asc' },
  });

  if (instantRoom === null) {
    console.log('  SKIP  no second vacant room of that category');
  } else {
    restoreRooms.push({ id: instantRoom.id, status: instantRoom.status });
    const instant = await createProbeBooking(
      cookie,
      property,
      roomType,
      businessDate,
      departure,
      {
        roomId: instantRoom.id,
        adults: 1,
        guests: [
          {
            firstName: 'Instant',
            lastName: 'Probe',
            govtIdType: 'PASSPORT',
            govtIdNumber: 'Z1234567',
          },
        ],
        isInstantCheckIn: true,
        payment: { method: 'CASH', amountMinor: 100000, remark: null },
      },
    );

    check(
      'the booking is created already in-house',
      instant.status === 'CHECKED_IN',
      `${instant.bookingCode}, room ${instant.roomNumber}`,
    );

    const instantLines = await prisma.folioLine.findMany({
      where: { folio: { reservationId: instant.id } },
      select: { kind: true, amountMinor: true },
      orderBy: { createdAt: 'asc' },
    });
    check(
      'it opens a folio with night one, its tax and the payment',
      instantLines.some((line) => line.kind === 'ROOM_CHARGE') &&
        instantLines.some((line) => line.kind === 'TAX') &&
        instantLines.some((line) => line.kind === 'PAYMENT' && line.amountMinor < 0),
      instantLines.map((line) => `${line.kind} ${rupees(line.amountMinor)}`).join(', ') || '(none)',
    );

    const instantRoomAfter = await prisma.room.findUnique({
      where: { id: instantRoom.id },
      select: { status: true },
    });
    check(
      'it occupies the room too',
      instantRoomAfter?.status === 'OCCUPIED_CLEAN' ||
        instantRoomAfter?.status === 'OCCUPIED_DIRTY',
      `status = ${instantRoomAfter?.status}`,
    );

    const instantAudit = await prisma.auditLog.count({
      where: { entityId: instant.id, event: 'RESERVATION_CHECKED_IN' },
    });
    check('it writes the same audit event', instantAudit === 1, `${instantAudit} row(s)`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Teardown                                                                  */
/* -------------------------------------------------------------------------- */

const restoreRooms = [];

async function teardown() {
  // Folios, lines and audit rows cascade from the reservation; the inventory
  // counters do not, so the nights this suite sold are given back.
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

    const roomTypeId = stay?.rooms[0]?.roomTypeId;
    if (stay !== null && roomTypeId !== undefined) {
      await prisma.inventoryDay
        .updateMany({
          where: {
            propertyId: stay.propertyId,
            roomTypeId,
            stayDate: { gte: stay.arrivalDate, lt: stay.departureDate },
            sold: { gt: 0 },
          },
          data: { sold: { decrement: 1 } },
        })
        .catch(() => null);
    }
  }

  for (const room of restoreRooms) {
    await prisma.room
      .update({ where: { id: room.id }, data: { status: room.status } })
      .catch(() => null);
  }

  console.log(
    `\nTeardown: removed ${created.length} reservation(s), released their nights, and restored ${restoreRooms.length} room status(es).`,
  );
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

console.log(failures === 0 ? '\nAll check-in checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
