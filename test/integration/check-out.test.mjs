/**
 * The check-out suite (FD-04).
 *
 * ===========================================================================
 * Three writes have to land together, and the interesting cases are the ones
 * where they must not land at all.
 *
 * Checkout moves the reservation to CHECKED_OUT, closes the folio and hands
 * the room back as VACANT_DIRTY. Every refusal below has to leave all three
 * exactly as they were, and every assertion here therefore reads the
 * **persisted rows**, not the HTTP body: a 409 that still closed the folio
 * would pass a response-only test and lose a hotel its audit trail.
 *
 * What this suite deliberately asserts does NOT happen:
 *
 *   * `inventory_day` is never touched. `reservation.state.ts` lists
 *     CHECKED_OUT in `CONSUMES_INVENTORY`, so a departed stay keeps the nights
 *     it slept in — releasing them would oversell history and corrupt the ADR
 *     and occupancy figures that read `sold`.
 *   * No folio line is created, reversed or amended. Checkout verifies a zero
 *     balance; it never posts money to manufacture one.
 *
 * Runs against the real Postgres with the real constraints, through the real
 * HTTP endpoint, like the suites beside it. Everything it creates is removed
 * in teardown, including on failure.
 * ===========================================================================
 */

import { createHmac, randomUUID } from 'node:crypto';
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

const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4000/api/v1';
const PROPERTY_CODE = process.env.EASEIT_PROPERTY ?? '31001';

const prisma = createPrismaClient();

/**
 * The isolation guard, shared with every other destructive suite. Imported
 * here rather than relied upon from the release gate, because this file is
 * reachable through its own npm script and run that way the gate's preflight
 * never executes.
 */
const { assertIsolatedDatabase, assertApiSharesDatabase } =
  await import('../support/isolation-guard.mjs');

/** Reservations this suite created, for teardown. */
const created = [];
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
    exp: now + 3600,
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
/*  Reads — the persisted truth each assertion is made against                */
/* -------------------------------------------------------------------------- */

/** Everything checkout is allowed to change, in one snapshot. */
async function snapshot(propertyId, reservationId) {
  const stay = await prisma.reservation.findFirst({
    where: { id: reservationId, propertyId },
    select: { status: true, checkedOutAt: true },
  });
  const folio = await prisma.folio.findUnique({
    where: { reservationId },
    select: { id: true, status: true, closedAt: true },
  });
  const lines =
    folio === null
      ? { count: 0, sum: 0 }
      : await prisma.folioLine
          .aggregate({
            where: { folioId: folio.id },
            _count: { _all: true },
            _sum: { amountMinor: true },
          })
          .then((r) => ({ count: r._count._all, sum: r._sum.amountMinor ?? 0 }));
  const assignment = await prisma.reservationRoom.findFirst({
    where: { reservationId, propertyId },
    select: { roomId: true, status: true, room: { select: { number: true, status: true } } },
  });
  const assignmentCount = await prisma.reservationRoom.count({
    where: { reservationId, propertyId },
  });
  const audits = await prisma.auditLog.count({
    where: { propertyId, entityId: reservationId, event: 'RESERVATION_CHECKED_OUT' },
  });

  return {
    status: stay?.status ?? null,
    checkedOutAt: stay?.checkedOutAt ?? null,
    folioId: folio?.id ?? null,
    folioStatus: folio?.status ?? null,
    folioClosedAt: folio?.closedAt ?? null,
    lineCount: lines.count,
    balanceMinor: lines.sum,
    roomId: assignment?.roomId ?? null,
    roomStatus: assignment?.room?.status ?? null,
    /**
     * `reservation_room.status`, which is its own `ReservationStatus` column
     * and not a view of the reservation's. Every writer mirrors the stay onto
     * it, so a checkout that left CHECKED_IN here would make the assignment
     * disagree with the reservation -- read as "the guest is in the room" by
     * the timeline and by anything built on it.
     */
    assignmentStatus: assignment?.status ?? null,
    assignmentCount,
    checkoutAudits: audits,
  };
}

/** `sold` per night for a category — checkout must never move these. */
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
    select: { stayDate: true, sold: true },
  });
  return rows
    .map((r) => `${isoDate(r.stayDate)}=${String(r.sold)}`)
    .sort()
    .join(',');
}

function unchanged(before, after, fields) {
  return fields.every((f) => String(before[f]) === String(after[f]));
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

async function book(cookie, roomType, arrival, departure, overrides = {}) {
  const response = await call('POST', `/properties/${PROPERTY_CODE}/reservations`, cookie, {
    roomTypeId: roomType.id,
    roomId: null,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Checkout', lastName: 'Probe' }],
    isInstantCheckIn: false,
    ...overrides,
  });
  if (response.status !== 201) {
    throw new Error(
      `fixture booking failed: ${String(response.status)} ${JSON.stringify(response.payload)}`,
    );
  }
  created.push(response.payload.id);
  return response.payload;
}

/** A category with headroom on every night, and a free clean room in it. */
async function findRoomAndType(propertyId, arrival, departure) {
  const nights = Math.round(
    (new Date(`${departure}T00:00:00.000Z`) - new Date(`${arrival}T00:00:00.000Z`)) / 86_400_000,
  );
  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId, rooms: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  for (const roomType of roomTypes) {
    const days = await prisma.inventoryDay.findMany({
      where: {
        propertyId,
        roomTypeId: roomType.id,
        stayDate: {
          gte: new Date(`${arrival}T00:00:00.000Z`),
          lt: new Date(`${departure}T00:00:00.000Z`),
        },
      },
      select: { physical: true, sold: true, blocked: true, overbookingAllowance: true },
    });
    if (days.length !== nights) continue;
    if (!days.every((d) => d.physical + d.overbookingAllowance - d.sold - d.blocked >= 1)) continue;

    // A room free for these dates and not already occupied, mirroring the
    // predicate `reservation_room_no_overlap` itself uses.
    const free = await prisma.$queryRaw`
      SELECT rm."id"::text AS id, rm."number" AS number, rm."status"::text AS status
      FROM room rm
      WHERE rm."propertyId" = ${propertyId}::uuid
        AND rm."roomTypeId" = ${roomType.id}::uuid
        AND rm."status" IN ('VACANT_CLEAN', 'INSPECTED')
        AND NOT EXISTS (
          SELECT 1 FROM reservation_room rr
          JOIN reservation r ON r."id" = rr."reservationId"
          WHERE rr."roomId" = rm."id"
            AND r."status" NOT IN ('CANCELLED', 'NO_SHOW')
            AND daterange(rr."arrivalDate", rr."departureDate", '[)')
                && daterange(${arrival}::date, ${departure}::date, '[)')
        )
      ORDER BY rm."number" ASC
      LIMIT 1`;
    if (free[0] !== undefined) return { roomType, room: free[0] };
  }
  return null;
}

/** A checked-in stay in a real room, with its folio balance left as posted. */
async function inHouseStay(cookie, propertyId, offset, label) {
  const arrival = shiftDays(isoDate(new Date()), offset);
  const departure = shiftDays(arrival, 2);
  const found = await findRoomAndType(propertyId, arrival, departure);
  if (found === null) throw new Error(`no free clean room for ${label}`);

  restoreRooms.push({ id: found.room.id, status: found.room.status });

  const stay = await book(cookie, found.roomType, arrival, departure, {
    roomId: found.room.id,
    isInstantCheckIn: true,
    guests: [
      {
        firstName: 'Checkout',
        lastName: label,
        govtIdType: 'PASSPORT',
        govtIdNumber: `CHKOUT${offset}`,
      },
    ],
  });

  return { stay, roomType: found.roomType, room: found.room, arrival, departure };
}

/** Settle a folio to exactly zero through the real payment endpoint. */
async function settle(cookie, folioId, amountMinor) {
  const response = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/folios/${folioId}/payment`,
    cookie,
    {
      method: 'CASH',
      amountMinor,
      remark: 'checkout suite: settle',
      // Required since FO-04: one reference per intent, and each settle here
      // is its own intent.
      idempotencyKey: randomUUID(),
    },
  );
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(
      `settle failed: ${String(response.status)} ${JSON.stringify(response.payload)}`,
    );
  }
  return response;
}

const checkOut = (cookie, reservationId, reason = 'checkout suite') =>
  call('POST', `/properties/${PROPERTY_CODE}/reservations/${reservationId}/check-out`, cookie, {
    reason,
  });

/* -------------------------------------------------------------------------- */
/*  The suite                                                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  // Before any fixture is created, mutated or deleted.
  await assertIsolatedDatabase({ prisma, suite: 'the check-out suite' });

  const grant = await prisma.userPropertyRole.findFirst({
    where: {
      property: { code: PROPERTY_CODE },
      role: { key: { in: ['PROPERTY_ADMIN', 'FRONT_DESK'] } },
    },
    select: {
      user: { select: { id: true, email: true } },
      property: { select: { id: true, code: true, name: true } },
    },
  });
  if (grant === null) {
    throw new Error(`no front-desk grant at property ${PROPERTY_CODE}. Run pnpm db:seed first.`);
  }

  const { user, property } = grant;
  const cookie = `easeit_session=${mintSession(user.id, user.email)}`;

  console.log(`Property ${property.code} (${property.name})`);
  console.log(`  acting as ${user.email}\n`);

  {
    const probe = await prisma.reservation.findFirst({
      where: { propertyId: property.id },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    await assertApiSharesDatabase({
      suite: 'the check-out suite',
      api: API,
      probe: async () => {
        if (probe === null) return { ok: false, detail: 'no seeded reservation to probe with' };
        const got = await call(
          'GET',
          `/properties/${PROPERTY_CODE}/reservations/${probe.id}`,
          cookie,
        );
        return got.status === 200
          ? { ok: true, detail: 'probe reservation visible' }
          : { ok: false, detail: `probe reservation returned HTTP ${String(got.status)}` };
      },
    });
  }

  /* ===================================================================== 1 */
  console.log('1. CHECKED_IN with a zero balance checks out.');
  {
    const f = await inHouseStay(cookie, property.id, 1, 'Zero');
    const before = await snapshot(property.id, f.stay.id);
    const soldBefore = await soldByDate(property.id, f.roomType.id, f.arrival, f.departure);

    check(
      'the fixture is in house with a positive balance and an open folio',
      before.status === 'CHECKED_IN' && before.balanceMinor > 0 && before.folioStatus === 'OPEN',
      `status=${before.status} balance=${String(before.balanceMinor)} folio=${before.folioStatus}`,
    );
    check(
      'and its assignment row is mirrored CHECKED_IN by check-in',
      before.assignmentStatus === 'CHECKED_IN',
      String(before.assignmentStatus),
    );

    await settle(cookie, before.folioId, before.balanceMinor);
    const settled = await snapshot(property.id, f.stay.id);
    check(
      'settling brings the balance to exactly zero',
      settled.balanceMinor === 0,
      `balance=${String(settled.balanceMinor)}`,
    );

    const response = await checkOut(cookie, f.stay.id);
    const after = await snapshot(property.id, f.stay.id);
    const soldAfter = await soldByDate(property.id, f.roomType.id, f.arrival, f.departure);

    check('the endpoint answers 200', response.status === 200, `HTTP ${String(response.status)}`);
    check(
      'the body reports CHECKED_OUT, not already',
      response.payload?.status === 'CHECKED_OUT' && response.payload?.alreadyCheckedOut === false,
    );
    check('the body reports financials unchanged', response.payload?.financialsUnchanged === true);
    check('the reservation is persisted CHECKED_OUT', after.status === 'CHECKED_OUT', after.status);
    check('checkedOutAt is set', after.checkedOutAt !== null);
    check(
      'the assignment row is mirrored CHECKED_OUT, not left CHECKED_IN',
      after.assignmentStatus === 'CHECKED_OUT',
      String(after.assignmentStatus),
    );
    check(
      'and the reservation and its assignment agree',
      after.assignmentStatus === after.status,
      `reservation=${String(after.status)} assignment=${String(after.assignmentStatus)}`,
    );
    check(
      'no assignment row was added or removed',
      after.assignmentCount === settled.assignmentCount && after.assignmentCount === 1,
      `${String(settled.assignmentCount)} → ${String(after.assignmentCount)}`,
    );
    check(
      'the folio is persisted CLOSED with closedAt',
      after.folioStatus === 'CLOSED' && after.folioClosedAt !== null,
      `${after.folioStatus}`,
    );
    check(
      'the room went back VACANT_DIRTY',
      after.roomStatus === 'VACANT_DIRTY',
      `room ${after.roomId === null ? '(none)' : 'set'} status=${after.roomStatus}`,
    );
    check(
      'exactly one checkout audit row',
      after.checkoutAudits === 1,
      `${String(after.checkoutAudits)} row(s)`,
    );
    check(
      'no folio line was created or removed',
      after.lineCount === settled.lineCount,
      `${String(settled.lineCount)} → ${String(after.lineCount)}`,
    );
    check('the balance is still exactly zero', after.balanceMinor === 0);
    check(
      'inventory is untouched — a departed stay keeps its nights',
      soldAfter === soldBefore,
      soldBefore === soldAfter ? soldBefore : `${soldBefore} → ${soldAfter}`,
    );

    /* =================================================================== 7 */
    console.log('\n7. A second checkout is idempotent.');
    const replay = await checkOut(cookie, f.stay.id);
    const afterReplay = await snapshot(property.id, f.stay.id);
    check('the replay answers 200', replay.status === 200, `HTTP ${String(replay.status)}`);
    check('and reports alreadyCheckedOut', replay.payload?.alreadyCheckedOut === true);
    check(
      'still exactly one audit row',
      afterReplay.checkoutAudits === 1,
      `${String(afterReplay.checkoutAudits)} row(s)`,
    );
    check(
      'nothing else moved on the replay',
      unchanged(after, afterReplay, [
        'status',
        'assignmentStatus',
        'assignmentCount',
        'folioStatus',
        'lineCount',
        'balanceMinor',
        'roomStatus',
      ]),
    );
    check(
      'closedAt was not rewritten by the replay',
      String(after.folioClosedAt) === String(afterReplay.folioClosedAt),
    );
  }

  /* ===================================================================== 2 */
  console.log('\n2. CHECKED_IN with an amount due is refused, and changes nothing.');
  {
    const f = await inHouseStay(cookie, property.id, 4, 'Owing');
    const before = await snapshot(property.id, f.stay.id);
    check(
      'the fixture owes money',
      before.balanceMinor > 0,
      `balance=${String(before.balanceMinor)}`,
    );

    const response = await checkOut(cookie, f.stay.id);
    const after = await snapshot(property.id, f.stay.id);

    check('the endpoint answers 409', response.status === 409, `HTTP ${String(response.status)}`);
    check(
      'with the typed OUTSTANDING_BALANCE code',
      response.payload?.code === 'OUTSTANDING_BALANCE',
      String(response.payload?.code),
    );
    check(
      'the refusal reports the balance',
      Number(response.payload?.details?.balanceMinor) === before.balanceMinor,
    );
    check(
      'no database internals leaked',
      !/SELECT|FOR UPDATE|prisma|SQLSTATE|55P03/i.test(JSON.stringify(response.payload ?? {})),
    );
    check('the reservation is still CHECKED_IN', after.status === 'CHECKED_IN', after.status);
    check(
      'the assignment is still CHECKED_IN',
      after.assignmentStatus === 'CHECKED_IN',
      String(after.assignmentStatus),
    );
    check('the folio is still OPEN', after.folioStatus === 'OPEN', String(after.folioStatus));
    check(
      'the room is still occupied',
      /^OCCUPIED_/.test(String(after.roomStatus)),
      String(after.roomStatus),
    );
    check(
      'no audit row was written',
      after.checkoutAudits === 0,
      `${String(after.checkoutAudits)} row(s)`,
    );
    check('no folio line was created', after.lineCount === before.lineCount);
  }

  /* ===================================================================== 3 */
  console.log('\n3. CHECKED_IN in credit is refused too — a credit is not a zero.');
  {
    const f = await inHouseStay(cookie, property.id, 7, 'Credit');
    const before = await snapshot(property.id, f.stay.id);
    // Overpay by one minor unit, so the balance is negative rather than zero.
    await settle(cookie, before.folioId, before.balanceMinor + 1);
    const credited = await snapshot(property.id, f.stay.id);
    check(
      'the fixture is in credit',
      credited.balanceMinor === -1,
      `balance=${String(credited.balanceMinor)}`,
    );

    const response = await checkOut(cookie, f.stay.id);
    const after = await snapshot(property.id, f.stay.id);

    check('the endpoint answers 409', response.status === 409, `HTTP ${String(response.status)}`);
    check(
      'with OUTSTANDING_BALANCE, not a silent success',
      response.payload?.code === 'OUTSTANDING_BALANCE',
      String(response.payload?.code),
    );
    check(
      'the message names the credit rather than an amount due',
      /credit/i.test(String(response.payload?.message)),
      String(response.payload?.message).slice(0, 58),
    );
    check('the reservation is still CHECKED_IN', after.status === 'CHECKED_IN', after.status);
    check('the folio is still OPEN', after.folioStatus === 'OPEN', String(after.folioStatus));
    check('no audit row was written', after.checkoutAudits === 0);
  }

  /* ================================================================ 4,5,6 */
  console.log('\n4/5/6. States with nobody in the room are refused.');
  for (const [label, status, offset] of [
    ['TENTATIVE (the enum has no PENDING)', 'TENTATIVE', 10],
    ['CONFIRMED', 'CONFIRMED', 13],
    ['CANCELLED', 'CANCELLED', 16],
  ]) {
    const arrival = shiftDays(isoDate(new Date()), offset);
    const departure = shiftDays(arrival, 2);
    const found = await findRoomAndType(property.id, arrival, departure);
    if (found === null) throw new Error(`no category for the ${label} fixture`);
    const stay = await book(cookie, found.roomType, arrival, departure);

    /**
     * Set directly, for the same reason the cancellation suite does: no
     * endpoint moves a booking to TENTATIVE or CANCELLED-with-this-shape, so
     * this is the only way to reach the status, and it is this suite's own
     * row. `cancelledAt` is set alongside CANCELLED because
     * `reservation_cancelled_at_matches_status` requires the pair to agree.
     */
    await prisma.reservation.update({
      where: { id: stay.id },
      data: status === 'CANCELLED' ? { status, cancelledAt: new Date() } : { status },
    });

    const before = await snapshot(property.id, stay.id);
    const response = await checkOut(cookie, stay.id);
    const after = await snapshot(property.id, stay.id);

    check(`${label}: answers 409`, response.status === 409, `HTTP ${String(response.status)}`);
    check(
      `${label}: with INVALID_STATE_TRANSITION`,
      response.payload?.code === 'INVALID_STATE_TRANSITION',
      String(response.payload?.code),
    );
    check(
      `${label}: reports the actual source state`,
      String(response.payload?.details?.from) === status,
      String(response.payload?.details?.from),
    );
    check(`${label}: status unchanged`, after.status === status, String(after.status));
    check(
      `${label}: assignment status unchanged`,
      String(after.assignmentStatus) === String(before.assignmentStatus),
      `${String(before.assignmentStatus)} → ${String(after.assignmentStatus)}`,
    );
    check(`${label}: no audit row`, after.checkoutAudits === 0);
    check(
      `${label}: folio and room untouched`,
      unchanged(before, after, ['folioStatus', 'lineCount', 'balanceMinor', 'roomStatus']),
    );
  }

  /* ===================================================================== 8 */
  console.log('\n8. A missing reservation is not found, not a 500.');
  {
    const response = await checkOut(cookie, '00000000-0000-4000-8000-000000000000');
    check('answers 404', response.status === 404, `HTTP ${String(response.status)}`);
    check(
      'with the typed NOT_FOUND code',
      response.payload?.code === 'NOT_FOUND',
      String(response.payload?.code),
    );
    check('no internals leaked', !/prisma|SELECT|uuid/i.test(String(response.payload?.message)));
  }

  /* ===================================================================== 9 */
  console.log("\n9. Another property's reservation is not found, not forbidden.");
  {
    /**
     * A foreign stay that actually has an **open folio with lines on it**.
     *
     * Any foreign reservation proves the 404, but only one with a folio proves
     * anything about the property-scoped folio lookups: against a stay with no
     * folio the "their folio was not closed" assertion compares null to null
     * and would pass however the service were written.
     */
    const foreign =
      (await prisma.reservation.findFirst({
        where: {
          property: { code: { not: PROPERTY_CODE } },
          folio: { is: { status: 'OPEN', lines: { some: {} } } },
        },
        select: { id: true, propertyId: true, status: true },
      })) ??
      (await prisma.reservation.findFirst({
        where: { property: { code: { not: PROPERTY_CODE } } },
        select: { id: true, propertyId: true, status: true },
      }));
    if (foreign === null) {
      console.log('  SKIP  no reservation at another property to probe with.');
    } else {
      const before = await snapshot(foreign.propertyId, foreign.id);
      check(
        'the probe is a foreign stay with an open folio carrying lines',
        before.folioStatus === 'OPEN' && before.lineCount > 0,
        `folio=${String(before.folioStatus)} lines=${String(before.lineCount)}`,
      );
      const response = await checkOut(cookie, foreign.id);
      const after = await snapshot(foreign.propertyId, foreign.id);
      check(
        'answers 404 rather than 403',
        response.status === 404,
        `HTTP ${String(response.status)}`,
      );
      check(
        "no detail of the other property's stay leaked",
        !JSON.stringify(response.payload ?? {}).includes(foreign.id),
      );
      check(
        "the other property's rows are untouched",
        unchanged(before, after, [
          'status',
          'assignmentStatus',
          'folioStatus',
          'roomStatus',
          'checkoutAudits',
        ]),
      );
      /**
       * Named separately from the `unchanged` sweep above because this is the
       * assertion the property-scoped folio lookup exists for: every folio
       * read in the service now carries `propertyId`, so a request authorised
       * at one property cannot reach -- let alone close -- a folio belonging
       * to another, even though `folio.reservationId` is unique and would have
       * found the row on its own.
       */
      check(
        "the other property's folio was not closed",
        String(before.folioStatus) === String(after.folioStatus) &&
          String(before.folioClosedAt) === String(after.folioClosedAt),
        `${String(before.folioStatus)} → ${String(after.folioStatus)}`,
      );
      check(
        'and no folio line of theirs moved',
        before.lineCount === after.lineCount && before.balanceMinor === after.balanceMinor,
        `${String(before.lineCount)}/${String(before.balanceMinor)} → ${String(after.lineCount)}/${String(after.balanceMinor)}`,
      );
    }
  }

  /* ==================================================================== 10 */
  console.log('\n10. A grant without reservations:checkout is refused 403.');
  {
    const housekeeping = await prisma.userPropertyRole.findFirst({
      where: { property: { code: PROPERTY_CODE }, role: { key: 'HOUSEKEEPING' } },
      select: { user: { select: { id: true, email: true } } },
    });
    if (housekeeping === null) {
      console.log('  SKIP  no housekeeping grant at this property.');
    } else {
      const f = await inHouseStay(cookie, property.id, 19, 'Perm');
      const before = await snapshot(property.id, f.stay.id);
      await settle(cookie, before.folioId, before.balanceMinor);

      const hkCookie = `easeit_session=${mintSession(housekeeping.user.id, housekeeping.user.email)}`;
      const response = await checkOut(hkCookie, f.stay.id);
      const after = await snapshot(property.id, f.stay.id);

      check('answers 403', response.status === 403, `HTTP ${String(response.status)}`);
      check(
        'with the typed FORBIDDEN code',
        response.payload?.code === 'FORBIDDEN',
        String(response.payload?.code),
      );
      check('the reservation is still CHECKED_IN', after.status === 'CHECKED_IN', after.status);
      check('the folio is still OPEN', after.folioStatus === 'OPEN', String(after.folioStatus));
      check('no audit row was written', after.checkoutAudits === 0);

      // Leave it checked out so teardown has a coherent row to remove.
      await checkOut(cookie, f.stay.id);
    }
  }

  /* ==================================================================== 11 */
  console.log('\n11. Concurrent checkouts: one transition, one release, one audit row.');
  {
    const f = await inHouseStay(cookie, property.id, 22, 'Race');
    const before = await snapshot(property.id, f.stay.id);
    await settle(cookie, before.folioId, before.balanceMinor);

    const [a, b] = await Promise.all([checkOut(cookie, f.stay.id), checkOut(cookie, f.stay.id)]);
    const after = await snapshot(property.id, f.stay.id);

    const statuses = [a.status, b.status].sort().join('/');
    console.log(`  both requests answered ${statuses}`);

    check('neither request was a 500', a.status < 500 && b.status < 500, statuses);
    check(
      'both answered typed',
      [a.status, b.status].every((s) => [200, 409].includes(s)),
      statuses,
    );
    check(
      'the reservation is CHECKED_OUT exactly once',
      after.status === 'CHECKED_OUT',
      after.status,
    );
    check(
      'exactly one audit row, not two',
      after.checkoutAudits === 1,
      `${String(after.checkoutAudits)} row(s)`,
    );
    check('the folio is CLOSED', after.folioStatus === 'CLOSED', String(after.folioStatus));
    check(
      'the room was released once, to VACANT_DIRTY',
      after.roomStatus === 'VACANT_DIRTY',
      String(after.roomStatus),
    );
    check(
      'no folio line was duplicated',
      after.lineCount === before.lineCount + 1,
      `${String(before.lineCount)}+1 → ${String(after.lineCount)}`,
    );

    const winners = [a, b].filter(
      (r) => r.status === 200 && r.payload?.alreadyCheckedOut === false,
    );
    check(
      'at most one request claims to have performed the checkout',
      winners.length <= 1,
      `${String(winners.length)} claimed it`,
    );
  }

  /* ==================================================================== 12 */
  console.log('\n12. Checkout racing a room move: serialized, never a 500.');
  {
    const f = await inHouseStay(cookie, property.id, 25, 'Move');
    const before = await snapshot(property.id, f.stay.id);
    await settle(cookie, before.folioId, before.balanceMinor);

    const target = await prisma.$queryRaw`
      SELECT rm."id"::text AS id
      FROM room rm
      WHERE rm."propertyId" = ${property.id}::uuid
        AND rm."roomTypeId" = ${f.roomType.id}::uuid
        AND rm."id" <> ${f.room.id}::uuid
        AND rm."status" IN ('VACANT_CLEAN', 'INSPECTED')
        AND NOT EXISTS (
          SELECT 1 FROM reservation_room rr
          JOIN reservation r ON r."id" = rr."reservationId"
          WHERE rr."roomId" = rm."id"
            AND r."status" NOT IN ('CANCELLED', 'NO_SHOW')
            AND daterange(rr."arrivalDate", rr."departureDate", '[)')
                && daterange(${f.arrival}::date, ${f.departure}::date, '[)')
        )
      LIMIT 1`;

    if (target[0] === undefined) {
      console.log('  SKIP  no second free room in the category to move into.');
    } else {
      restoreRooms.push({ id: target[0].id, status: 'VACANT_CLEAN' });
      const [out, moved] = await Promise.all([
        checkOut(cookie, f.stay.id),
        call('POST', `/properties/${PROPERTY_CODE}/reservations/${f.stay.id}/room`, cookie, {
          roomId: target[0].id,
          acknowledgeCategoryChange: false,
          reason: 'checkout suite: race',
        }),
      ]);
      const after = await snapshot(property.id, f.stay.id);
      console.log(`  checkout ${String(out.status)}, move ${String(moved.status)}`);

      check(
        'neither request was a 500',
        out.status < 500 && moved.status < 500,
        `${String(out.status)}/${String(moved.status)}`,
      );
      check(
        'both answered typed',
        [200, 201, 400, 409].includes(out.status) && [200, 201, 400, 409].includes(moved.status),
      );
      check(
        'the stay ended in a coherent state',
        after.status === 'CHECKED_OUT' || after.status === 'CHECKED_IN',
        String(after.status),
      );
      check(
        'at most one checkout audit row',
        after.checkoutAudits <= 1,
        `${String(after.checkoutAudits)} row(s)`,
      );
      if (after.status === 'CHECKED_OUT') {
        check(
          'a completed checkout closed the folio',
          after.folioStatus === 'CLOSED',
          String(after.folioStatus),
        );
        check(
          'and left the room dirty',
          after.roomStatus === 'VACANT_DIRTY',
          String(after.roomStatus),
        );
      } else {
        check(
          'a refused checkout left the folio open',
          after.folioStatus === 'OPEN',
          String(after.folioStatus),
        );
        check(
          'and the guest still in a room',
          /^OCCUPIED_/.test(String(after.roomStatus)),
          String(after.roomStatus),
        );
      }
    }
  }

  /* ==================================================================== 13 */
  console.log('\n13. A failure after an earlier write rolls the whole transaction back.');
  {
    const f = await inHouseStay(cookie, property.id, 28, 'Rollback');
    const before = await snapshot(property.id, f.stay.id);
    await settle(cookie, before.folioId, before.balanceMinor);
    const settled = await snapshot(property.id, f.stay.id);

    /**
     * The fault is injected without a production hook.
     *
     * This suite holds the `room` row that checkout must update. Checkout
     * takes the reservation row, passes every guard, writes the reservation
     * update, and then blocks on the room — so when its transaction-local
     * `lock_timeout` fires, it fails *after* an earlier write. If the
     * transaction were not atomic the reservation would be left CHECKED_OUT
     * with an open folio and an occupied room, which is precisely the
     * corruption this asserts against.
     */
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    let ready;
    const holding = new Promise((resolve) => {
      ready = resolve;
    });

    const holder = prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM room WHERE "id" = ${f.room.id}::uuid FOR UPDATE`;
          ready();
          await released;
        },
        { timeout: 60_000, maxWait: 15_000 },
      )
      .catch(() => null);

    await holding;
    const startedAt = Date.now();
    const response = await checkOut(cookie, f.stay.id);
    const elapsed = Date.now() - startedAt;
    release();
    await holder;

    const after = await snapshot(property.id, f.stay.id);

    console.log(
      `  the blocked request took ${String(elapsed)}ms and answered ${String(response.status)}`,
    );
    check(
      'the contended request was refused, not a 500',
      response.status === 409,
      `HTTP ${String(response.status)}`,
    );
    check(
      'with the typed CONFLICT code',
      response.payload?.code === 'CONFLICT',
      String(response.payload?.code),
    );
    check(
      'it gave up on its own lock budget, not the holder',
      elapsed < 8_000,
      `${String(elapsed)}ms, cap 8000ms`,
    );
    check(
      'no database internals leaked',
      !/55P03|SQLSTATE|FOR UPDATE|prisma/i.test(JSON.stringify(response.payload ?? {})),
    );

    check(
      'the reservation rolled back to CHECKED_IN',
      after.status === 'CHECKED_IN',
      String(after.status),
    );
    check(
      'and so did its assignment row',
      after.assignmentStatus === 'CHECKED_IN',
      String(after.assignmentStatus),
    );
    check('checkedOutAt was not persisted', after.checkedOutAt === null);
    check('the folio rolled back to OPEN', after.folioStatus === 'OPEN', String(after.folioStatus));
    check('closedAt was not persisted', after.folioClosedAt === null);
    check(
      'the room is still occupied',
      /^OCCUPIED_/.test(String(after.roomStatus)),
      String(after.roomStatus),
    );
    check(
      'NO audit row survived the rollback',
      after.checkoutAudits === 0,
      `${String(after.checkoutAudits)} row(s)`,
    );
    check('no folio line was created', after.lineCount === settled.lineCount);

    // Now that the lock is gone, the same request must succeed — proving the
    // refusal was transient and left the stay checkable-out.
    const retry = await checkOut(cookie, f.stay.id);
    const afterRetry = await snapshot(property.id, f.stay.id);
    check(
      'the same request succeeds once the lock is released',
      retry.status === 200,
      `HTTP ${String(retry.status)}`,
    );
    check(
      'and then there is exactly one audit row',
      afterRetry.checkoutAudits === 1,
      `${String(afterRetry.checkoutAudits)} row(s)`,
    );
    check(
      'the folio is CLOSED on the retry',
      afterRetry.folioStatus === 'CLOSED',
      String(afterRetry.folioStatus),
    );
    check(
      'and the assignment is CHECKED_OUT on the retry',
      afterRetry.assignmentStatus === 'CHECKED_OUT',
      String(afterRetry.assignmentStatus),
    );

    /* ================================================================== 14 */
    console.log('\n14. A departed stay still blocks an overlapping assignment.');
    {
      /**
       * The reason the mirror is safe to write.
       *
       * `reservation_room_no_overlap` is partial -- it covers every row whose
       * status is NOT IN ('CANCELLED', 'NO_SHOW') -- so moving the row from
       * CHECKED_IN to CHECKED_OUT must leave it inside the constraint. If
       * CHECKED_OUT had dropped out, the room would silently become bookable
       * for nights the departed guest still holds in `inventory_day`, which is
       * a double booking by a different route.
       *
       * Probed by attempting the overlapping INSERT and requiring Postgres to
       * reject it with `23P01`. The probe runs in a transaction that is always
       * rolled back, so no row is created either way -- it is the constraint
       * being interrogated, not the fixture being extended.
       */
      const probe = await prisma
        .$transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO reservation_room
              ("id", "propertyId", "reservationId", "roomTypeId", "roomId",
               "arrivalDate", "departureDate", "status", "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${property.id}::uuid, ${f.stay.id}::uuid,
                    ${f.roomType.id}::uuid, ${f.room.id}::uuid,
                    ${f.arrival}::date, ${f.departure}::date,
                    'CONFIRMED', now(), now())`;
          throw new Error('OVERLAP_ACCEPTED');
        })
        .then(() => 'committed')
        .catch((error) => {
          const text = JSON.stringify(error?.meta ?? {}) + String(error?.message ?? '');
          if (/OVERLAP_ACCEPTED/.test(text)) return 'accepted';
          if (/23P01|reservation_room_no_overlap|exclusion/i.test(text)) return 'rejected';
          return `unexpected: ${String(error?.message ?? error)}`;
        });

      check(
        'the stay under probe really is departed',
        afterRetry.assignmentStatus === 'CHECKED_OUT',
        String(afterRetry.assignmentStatus),
      );
      check(
        'an overlapping assignment on that room is still rejected by the exclusion constraint',
        probe === 'rejected',
        probe,
      );
      const stillThere = await snapshot(property.id, f.stay.id);
      check(
        'the rolled-back probe created nothing',
        stillThere.assignmentCount === afterRetry.assignmentCount,
        `${String(afterRetry.assignmentCount)} → ${String(stillThere.assignmentCount)}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Teardown                                                                  */
/* -------------------------------------------------------------------------- */

async function teardown() {
  let removedLines = 0;
  let removedFolios = 0;

  for (const reservationId of created) {
    try {
      const folio = await prisma.folio.findUnique({
        where: { reservationId },
        select: { id: true },
      });
      if (folio !== null) {
        removedLines += (await prisma.folioLine.deleteMany({ where: { folioId: folio.id } })).count;
        removedFolios += (await prisma.folio.deleteMany({ where: { id: folio.id } })).count;
      }
      await prisma.auditLog.deleteMany({ where: { entityId: reservationId } });
      await prisma.reservationRoom.deleteMany({ where: { reservationId } });
      await prisma.reservation.deleteMany({ where: { id: reservationId } });
    } catch (error) {
      console.error(`  CLEANUP FAILED for ${reservationId} — ${String(error.message ?? error)}`);
      failures += 1;
    }
  }

  /**
   * Nights are NOT released here.
   *
   * Deleting the reservation rows above removes what `inventory_day.sold`
   * counts, and the seeds' own counters are derived from the stays that remain.
   * Decrementing as well would double-release and leave the shared fixtures
   * short — the same trap the cancellation suite documents.
   */
  for (const room of restoreRooms) {
    try {
      await prisma.room.update({ where: { id: room.id }, data: { status: room.status } });
    } catch {
      // The room may already be gone with its property in a disposable DB.
    }
  }

  console.log(
    `\nTeardown: removed ${String(created.length)} reservation(s), ${String(removedFolios)} folio(s), ` +
      `${String(removedLines)} folio line(s), and restored ${String(restoreRooms.length)} room status(es).`,
  );
}

/* -------------------------------------------------------------------------- */

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\nFATAL  ${String(error.message ?? error)}`);
  if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  await teardown().catch((error) => {
    failures += 1;
    console.error(`Teardown failed: ${String(error.message ?? error)}`);
  });
  await prisma.$disconnect();
}

console.log(
  failures === 0 ? '\nAll check-out checks passed.' : `\n${String(failures)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
