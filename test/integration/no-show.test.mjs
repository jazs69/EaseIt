/**
 * No-show handling (RS-13).
 *
 * ===========================================================================
 * Acceptance: a no-show sets the status and keeps inventory consistent.
 *
 * "Consistent" is asserted the way section 3.1.1 requires: `inventory_day.sold`
 * per date AND per category against the live `reservation_room` rows of the
 * statuses that consume inventory, not merely as a total. Plus the
 * concurrency test (parallel no-shows release exactly once; no-show racing a
 * cancellation in both queue orders) and the tenant-isolation test (another
 * property's stay is not-found, never 403).
 *
 * Suite-owned fixtures only (ZZNSH / ZZNSX), torn down by the harness.
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'no-show';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZNSH',
  slugPrefix: 'zz-nsh-',
  emailDomain: 'nsh.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZNSX',
  slugPrefix: 'zz-nsx-',
  emailDomain: 'nsx.invalid',
  prisma,
});

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;
const CONSUMING = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'];

let fixture;

async function lockWaiters() {
  const rows = await prisma.$queryRaw`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`;
  return rows[0].waiting;
}

/** Hold the reservation row; fire operations one at a time, each confirmed parked. */
async function underReservationLock(reservationId, operations, { holdUntilSettled = false } = {}) {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let holding;
  const held = new Promise((resolve) => {
    holding = resolve;
  });
  const hold = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "reservation" WHERE "id" = ${reservationId}::uuid FOR UPDATE`;
      holding();
      await released;
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
  await held;
  const baseline = await lockWaiters();
  const started = Date.now();
  const results = [];
  let parked = true;
  if (holdUntilSettled) {
    for (const operation of operations) results.push(operation());
    const settled = await Promise.all(results);
    release();
    await hold;
    return { settled, parked, elapsed: Date.now() - started };
  }
  for (let i = 0; i < operations.length; i += 1) {
    results.push(operations[i]());
    const deadline = Date.now() + 10_000;
    let reached = false;
    while (Date.now() < deadline) {
      if ((await lockWaiters()) - baseline >= i + 1) {
        reached = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!reached) parked = false;
  }
  release();
  await hold;
  return { settled: await Promise.all(results), parked, elapsed: Date.now() - started };
}

async function body() {
  console.log('\n════ no-show (RS-13) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', revenue: 'REVENUE_MANAGER' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'B1', category: 'B', status: 'VACANT_CLEAN' },
    ],
  });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);
  const theirs = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });

  const today = fixture.today;
  const NIGHTS = 40;
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: NIGHTS }, (_, i) => shiftDays(today, i - 5)).flatMap((night) => [
      { propertyId: fixture.propertyId, roomTypeId: fixture.categoryA, stayDate: utcMidnight(night), physical: 8 },
      { propertyId: fixture.propertyId, roomTypeId: fixture.categoryB, stayDate: utcMidnight(night), physical: 3 },
    ]),
  });

  const base = `/properties/${fixture.propertyCode}`;
  const clerk = fixture.users.clerk.cookie;

  async function booking({ arrival, nights = 2, category = fixture.categoryA, roomId = null, last = 'Guest' }) {
    const res = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: category,
      roomId,
      arrivalDate: arrival,
      departureDate: shiftDays(arrival, nights),
      adults: 1,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'NoShow', lastName: last, govtIdType: 'PASSPORT', govtIdNumber: 'P1234567' }],
      isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking failed: ${show(res)}`);
    return res.payload;
  }
  const noShow = (cookie, stay, reason = 'Did not arrive') =>
    h.call('POST', `${base}/reservations/${stay.id}/no-show`, cookie, { reason });
  const cancel = (stay) =>
    h.call('POST', `${base}/reservations/${stay.id}/cancel`, clerk, { reason: 'Suite cancel' });

  /** Per date AND per category: sold vs live consuming room rows. */
  async function assertCounters(label, dates) {
    const days = await prisma.inventoryDay.findMany({
      where: { propertyId: fixture.propertyId, stayDate: { in: dates.map(utcMidnight) } },
      select: { roomTypeId: true, stayDate: true, sold: true },
    });
    const rooms = await prisma.reservationRoom.findMany({
      where: { propertyId: fixture.propertyId, status: { in: CONSUMING } },
      select: { roomTypeId: true, arrivalDate: true, departureDate: true },
    });
    const problems = [];
    for (const day of days) {
      const held = rooms.filter(
        (r) => r.roomTypeId === day.roomTypeId && r.arrivalDate <= day.stayDate && r.departureDate > day.stayDate,
      ).length;
      if (held !== day.sold) {
        problems.push(`${day.stayDate.toISOString().slice(0, 10)} ${day.roomTypeId === fixture.categoryA ? 'A' : 'B'}: sold ${String(day.sold)} held ${String(held)}`);
      }
    }
    h.check(`${label}: sold equals live room rows, per date and per category`, problems.length === 0, problems.join('; '));
  }
  const datesOf = (arrival, nights) => Array.from({ length: nights }, (_, i) => shiftDays(arrival, i));
  const audits = (stay) =>
    prisma.auditLog.count({ where: { propertyId: fixture.propertyId, entityId: stay.id, event: 'RESERVATION_NO_SHOW' } });

  /* ------------------------------------------------------------------ 1 */
  console.log('1. A no-show releases every held night and frees the room.');
  const s1 = await booking({ arrival: today, nights: 2, roomId: fixture.rooms.A1.id, last: 'One' });
  const window1 = datesOf(today, 2);
  await assertCounters('before', window1);
  const soldBefore = await prisma.inventoryDay.findMany({
    where: { propertyId: fixture.propertyId, roomTypeId: fixture.categoryA, stayDate: { in: window1.map(utcMidnight) } },
    select: { stayDate: true, sold: true },
    orderBy: { stayDate: 'asc' },
  });
  const r1 = await noShow(clerk, s1);
  h.check('front desk marks it: 200', r1.status === 200, show(r1));
  h.check(
    'NO_SHOW, 2 nights released, financials unchanged',
    r1.payload?.status === 'NO_SHOW' && r1.payload?.nightsReleased === 2 && r1.payload?.alreadyNoShow === false && r1.payload?.financialsUnchanged === true,
    JSON.stringify(r1.payload),
  );
  const row1 = await prisma.reservation.findFirst({ where: { id: s1.id }, select: { status: true, cancelledAt: true } });
  const rr1 = await prisma.reservationRoom.findMany({ where: { reservationId: s1.id }, select: { status: true } });
  h.check('stored NO_SHOW with the time it was marked', row1.status === 'NO_SHOW' && row1.cancelledAt !== null);
  h.check('every room row is NO_SHOW', rr1.length > 0 && rr1.every((r) => r.status === 'NO_SHOW'));
  const soldAfter = await prisma.inventoryDay.findMany({
    where: { propertyId: fixture.propertyId, roomTypeId: fixture.categoryA, stayDate: { in: window1.map(utcMidnight) } },
    select: { stayDate: true, sold: true },
    orderBy: { stayDate: 'asc' },
  });
  h.check(
    'each night of the category gave back exactly one room',
    soldAfter.every((d, i) => d.sold === soldBefore[i].sold - 1),
    soldAfter.map((d, i) => `${String(soldBefore[i].sold)}->${String(d.sold)}`).join(', '),
  );
  await assertCounters('after', window1);
  h.check('one RESERVATION_NO_SHOW audit row', (await audits(s1)) === 1);
  const rebook = await h.call('POST', `${base}/reservations`, clerk, {
    roomTypeId: fixture.categoryA,
    roomId: fixture.rooms.A1.id,
    arrivalDate: today,
    departureDate: shiftDays(today, 2),
    adults: 1,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Next', lastName: 'Guest' }],
    isInstantCheckIn: false,
  });
  h.check('the same room number can be sold again for those nights', rebook.status === 201, show(rebook));
  await assertCounters('after rebooking', window1);

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Idempotent, and parallel calls release exactly once.');
  const again = await noShow(clerk, s1);
  h.check('repeat: 200, alreadyNoShow, nothing released', again.status === 200 && again.payload?.alreadyNoShow === true && again.payload?.nightsReleased === 0, show(again));
  h.check('still one audit row', (await audits(s1)) === 1);

  const s2 = await booking({ arrival: shiftDays(today, -1), nights: 3, category: fixture.categoryB, last: 'Two' });
  const window2 = datesOf(shiftDays(today, -1), 3);
  const parallel = await Promise.all(Array.from({ length: 8 }, () => noShow(clerk, s2)));
  const fresh = parallel.filter((r) => r.status === 200 && r.payload?.alreadyNoShow === false);
  h.check('eight parallel no-shows all answer 200', parallel.every((r) => r.status === 200), parallel.map((r) => r.status).join(','));
  h.check('exactly one made the transition, releasing 3 nights', fresh.length === 1 && fresh[0].payload.nightsReleased === 3, String(fresh.length));
  h.check('exactly one audit row', (await audits(s2)) === 1);
  await assertCounters('after the parallel no-shows (a past arrival)', window2);

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Refusals.');
  const future = await booking({ arrival: shiftDays(today, 3), last: 'Future' });
  const early = await noShow(clerk, future);
  h.check('before the arrival business date: 400', early.status === 400 && early.payload?.code === 'VALIDATION_FAILED', show(early));
  h.check('and it is still CONFIRMED', (await prisma.reservation.findFirst({ where: { id: future.id }, select: { status: true } })).status === 'CONFIRMED');
  await assertCounters('after the early refusal', datesOf(shiftDays(today, 3), 2));

  const inHouse = await booking({ arrival: today, nights: 1, roomId: fixture.rooms.A2.id, last: 'InHouse' });
  const checkIn = await h.call('POST', `${base}/reservations/${inHouse.id}/check-in`, clerk, {
    roomId: fixture.rooms.A2.id,
    primaryGuestIdType: 'PASSPORT',
    primaryGuestIdNumber: 'P1234567',
    acknowledgeRoomNotClean: true,
  });
  h.check('setup: a stay checks in', ok(checkIn), show(checkIn));
  const arrived = await noShow(clerk, inHouse);
  h.check('a checked-in guest is not a no-show: 409 INVALID_STATE_TRANSITION', arrived.status === 409 && arrived.payload?.code === 'INVALID_STATE_TRANSITION', show(arrived));

  const cancelled = await booking({ arrival: today, nights: 1, last: 'Cancelled' });
  await cancel(cancelled);
  const ofCancelled = await noShow(clerk, cancelled);
  h.check('a cancelled stay is not a no-show: 409', ofCancelled.status === 409, show(ofCancelled));
  const cancelNoShow = await cancel(s1);
  h.check('and a no-show cannot be cancelled: 409', cancelNoShow.status === 409, show(cancelNoShow));
  const checkInNoShow = await h.call('POST', `${base}/reservations/${s1.id}/check-in`, clerk, {
    roomId: fixture.rooms.A1.id,
    primaryGuestIdType: 'PASSPORT',
    primaryGuestIdNumber: 'P1234567',
    acknowledgeRoomNotClean: true,
  });
  h.check('nor checked in (4xx)', checkInNoShow.status >= 400 && checkInNoShow.status < 500, show(checkInNoShow));

  const target = await booking({ arrival: today, nights: 1, last: 'Perm' });
  const denied = await noShow(fixture.users.revenue.cookie, target);
  h.check('a role without reservations:edit: 403', denied.status === 403, show(denied));
  const cross = await h.call('POST', `/properties/${theirs.propertyCode}/reservations/${target.id}/no-show`, theirs.users.admin.cookie, { reason: 'x' });
  h.check('another property: 404, not 403', cross.status === 404, show(cross));
  const unknown = await h.call('POST', `${base}/reservations/${randomUUID()}/no-show`, clerk, { reason: 'x' });
  h.check('an unknown reservation: 404', unknown.status === 404, show(unknown));
  h.check('the target is untouched', (await prisma.reservation.findFirst({ where: { id: target.id }, select: { status: true } })).status === 'CONFIRMED');

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. A no-show racing a cancellation, in both queue orders.');
  for (const order of ['no-show first', 'cancel first']) {
    const stay = await booking({ arrival: today, nights: 2, last: order === 'no-show first' ? 'RaceA' : 'RaceB' });
    const ops = order === 'no-show first' ? [() => noShow(clerk, stay), () => cancel(stay)] : [() => cancel(stay), () => noShow(clerk, stay)];
    const { settled, parked } = await underReservationLock(stay.id, ops);
    const [first, second] = settled;
    const status = (await prisma.reservation.findFirst({ where: { id: stay.id }, select: { status: true } })).status;
    h.check(`${order}: both parked on the lock in that order`, parked);
    h.check(`${order}: the first wins`, first.status === 200 && status === (order === 'no-show first' ? 'NO_SHOW' : 'CANCELLED'), `${show(first)} -> ${status}`);
    h.check(`${order}: the second is refused 409`, second.status === 409, show(second));
    await assertCounters(`${order}: released exactly once`, datesOf(today, 2));
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n5. Bounded lock wait; money untouched; the folio can then be settled.');
  const parkedStay = await booking({ arrival: today, nights: 1, last: 'Parked' });
  const { settled: [parkedRes], elapsed } = await underReservationLock(parkedStay.id, [() => noShow(clerk, parkedStay)], { holdUntilSettled: true });
  h.check('a no-show parked behind a held lock: 409 CONFLICT', parkedRes.status === 409 && parkedRes.payload?.code === 'CONFLICT', show(parkedRes));
  h.check('after the 3 s lock timeout (~3-8 s)', elapsed >= 2_500 && elapsed < 8_000, `${String(elapsed)} ms`);
  h.check('and it is still CONFIRMED', (await prisma.reservation.findFirst({ where: { id: parkedStay.id }, select: { status: true } })).status === 'CONFIRMED');

  const paid = await booking({ arrival: today, nights: 1, last: 'Deposit' });
  const deposit = await h.call('POST', `${base}/folios/by-booking/${paid.bookingCode}/payment`, clerk, {
    method: 'CASH',
    amountMinor: 200000,
    remark: null,
    idempotencyKey: randomUUID(),
  });
  const folioId = deposit.payload?.folioId;
  const linesBefore = await prisma.folioLine.count({ where: { folioId } });
  const marked = await noShow(clerk, paid);
  h.check('a stay with a deposit is marked: 200', marked.status === 200, show(marked));
  h.check('no folio line was written', (await prisma.folioLine.count({ where: { folioId } })) === linesBefore);
  const payment = await prisma.folioLine.findFirst({ where: { folioId, kind: 'PAYMENT' }, select: { id: true } });
  const refunded = await h.call('POST', `${base}/folios/${folioId}/payments/${payment.id}/refund`, fixture.users.admin.cookie, {
    amountMinor: 200000,
    reason: 'No-show deposit returned',
    idempotencyKey: randomUUID(),
  });
  const closed = await h.call('POST', `${base}/folios/${folioId}/close`, clerk, { reason: 'No-show settled' });
  h.check('its deposit can be refunded and the folio closed (FO-12/13)', ok(refunded) && ok(closed) && closed.payload?.folioStatus === 'CLOSED', `${show(refunded)} | ${show(closed)}`);

  await assertCounters('final', datesOf(shiftDays(today, -1), 8));
}

await runSuite({
  harness: h,
  prisma,
  label: 'no-show integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
