/**
 * Changing a stay's dates: amend, extend, shorten (RS-11, RS-12).
 *
 * ===========================================================================
 * Acceptance: amending dates re-checks inventory for added nights and releases
 * removed ones, tested per date (P1-11).
 *
 * Every change is followed by the section 3.1.1 assertion: `inventory_day.sold`
 * per date AND per category against the live `reservation_room` rows of the
 * statuses that consume inventory. Plus money (the total stays the sum of its
 * night rows; kept nights keep their price), the concurrency tests (the last
 * room raced by two extensions; parallel identical changes; a change racing a
 * cancellation in both queue orders; a bounded lock wait) and tenancy.
 *
 * Suite-owned fixtures only (ZZSDH / ZZSDX), torn down by the harness.
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

const SUITE = 'stay-dates';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZSDH',
  slugPrefix: 'zz-sdh-',
  emailDomain: 'sdh.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZSDX',
  slugPrefix: 'zz-sdx-',
  emailDomain: 'sdx.invalid',
  prisma,
});

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;
const CONSUMING = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'];
const iso = (date) => date.toISOString().slice(0, 10);

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
  console.log('\n════ stay dates (RS-11, RS-12) ════\n');
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
  const NIGHTS = 40; // today-5 .. today+34
  const horizon = shiftDays(today, 34);
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: NIGHTS }, (_, i) => shiftDays(today, i - 5)).flatMap((night) => [
      { propertyId: fixture.propertyId, roomTypeId: fixture.categoryA, stayDate: utcMidnight(night), physical: 8 },
      { propertyId: fixture.propertyId, roomTypeId: fixture.categoryB, stayDate: utcMidnight(night), physical: 2 },
    ]),
  });
  const everyDate = Array.from({ length: NIGHTS }, (_, i) => shiftDays(today, i - 5));

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
      guests: [{ firstName: 'Dates', lastName: last, govtIdType: 'PASSPORT', govtIdNumber: 'P1234567' }],
      isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking failed: ${show(res)}`);
    return res.payload;
  }
  const change = (stay, arrivalDate, departureDate, extra = {}, cookie = clerk) =>
    h.call('POST', `${base}/reservations/${stay.id}/dates`, cookie, { arrivalDate, departureDate, reason: 'Suite', ...extra });
  const preview = (stay, arrivalDate, departureDate, extra = {}) =>
    h.call('POST', `${base}/reservations/${stay.id}/dates/preview`, clerk, { arrivalDate, departureDate, ...extra });
  const cancel = (stay) =>
    h.call('POST', `${base}/reservations/${stay.id}/cancel`, clerk, { reason: 'Suite cancel' });

  /** Per date AND per category: sold vs live consuming room rows. */
  async function assertCounters(label) {
    const days = await prisma.inventoryDay.findMany({
      where: { propertyId: fixture.propertyId, stayDate: { in: everyDate.map(utcMidnight) } },
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
        problems.push(`${iso(day.stayDate)} ${day.roomTypeId === fixture.categoryA ? 'A' : 'B'}: sold ${String(day.sold)} held ${String(held)}`);
      }
    }
    h.check(`${label}: sold equals live room rows, per date and per category`, problems.length === 0, problems.join('; '));
  }

  /** The stay as stored: dates on both rows, nights, total == sum of nights. */
  async function stored(stay) {
    const row = await prisma.reservation.findFirst({
      where: { id: stay.id },
      select: { arrivalDate: true, departureDate: true, totalAmountMinor: true, taxAmountMinor: true, status: true },
    });
    const room = await prisma.reservationRoom.findFirst({
      where: { reservationId: stay.id },
      select: { arrivalDate: true, departureDate: true },
    });
    const nights = await prisma.reservationNight.findMany({
      where: { reservationId: stay.id },
      select: { id: true, stayDate: true, rateMinor: true, taxMinor: true, rateSource: true },
      orderBy: { stayDate: 'asc' },
    });
    return {
      arrival: iso(row.arrivalDate),
      departure: iso(row.departureDate),
      roomArrival: iso(room.arrivalDate),
      roomDeparture: iso(room.departureDate),
      total: row.totalAmountMinor,
      tax: row.taxAmountMinor,
      status: row.status,
      nights,
      nightDates: nights.map((n) => iso(n.stayDate)),
      nightsGross: nights.reduce((sum, n) => sum + n.rateMinor + n.taxMinor, 0),
      nightsTax: nights.reduce((sum, n) => sum + n.taxMinor, 0),
    };
  }
  const datesOf = (arrival, nights) => Array.from({ length: nights }, (_, i) => shiftDays(arrival, i));
  function assertConsistent(label, s, arrival, departure) {
    const expected = datesOf(arrival, Math.round((utcMidnight(departure) - utcMidnight(arrival)) / 86_400_000));
    h.check(
      `${label}: reservation and room row both ${arrival} -> ${departure}`,
      s.arrival === arrival && s.departure === departure && s.roomArrival === arrival && s.roomDeparture === departure,
      JSON.stringify([s.arrival, s.departure, s.roomArrival, s.roomDeparture]),
    );
    h.check(`${label}: one night row per night`, JSON.stringify(s.nightDates) === JSON.stringify(expected), s.nightDates.join(','));
    h.check(`${label}: total and tax are the sum of the night rows`, s.total === s.nightsGross && s.tax === s.nightsTax, `${String(s.total)} vs ${String(s.nightsGross)}; ${String(s.tax)} vs ${String(s.nightsTax)}`);
  }
  const audits = (stay) =>
    prisma.auditLog.count({ where: { propertyId: fixture.propertyId, entityId: stay.id, event: 'RESERVATION_DATES_CHANGED' } });

  /* ------------------------------------------------------------------ 1 */
  console.log('1. Extend: the added nights are sold and priced; kept nights untouched.');
  const a1 = shiftDays(today, 3);
  const s1 = await booking({ arrival: a1, nights: 2, roomId: fixture.rooms.A1.id, last: 'Extend' });
  const before1 = await stored(s1);
  const p1 = await preview(s1, a1, shiftDays(a1, 4));
  h.check('preview: 200, +2 nights, -0', p1.status === 200 && p1.payload?.addedNights?.length === 2 && p1.payload?.removedNights?.length === 0, show(p1));
  h.check('preview commits nothing', (await stored(s1)).departure === before1.departure && (await audits(s1)) === 0);
  const r1 = await change(s1, a1, shiftDays(a1, 4), { expectedTotalMinor: p1.payload.proposed.totalMinor });
  h.check('extend: 200', r1.status === 200, show(r1));
  const after1 = await stored(s1);
  assertConsistent('extended', after1, a1, shiftDays(a1, 4));
  h.check('committed total equals the previewed total', after1.total === p1.payload.proposed.totalMinor, `${String(after1.total)} vs ${String(p1.payload.proposed.totalMinor)}`);
  h.check(
    'kept nights are the same rows at the same price',
    before1.nights.every((n) => after1.nights.some((m) => m.id === n.id && m.rateMinor === n.rateMinor && m.taxMinor === n.taxMinor)),
  );
  h.check('added nights are rack-priced at the room type rate', after1.nights.slice(2).every((n) => n.rateSource === 'RACK'));
  h.check('one RESERVATION_DATES_CHANGED audit row', (await audits(s1)) === 1);
  await assertCounters('after extending');

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Shorten, and move both ends.');
  const r2 = await change(s1, a1, shiftDays(a1, 1));
  h.check('shorten 4 -> 1 night: 200', r2.status === 200 && r2.payload?.removedNights?.length === 3, show(r2));
  const after2 = await stored(s1);
  assertConsistent('shortened', after2, a1, shiftDays(a1, 1));
  h.check('the kept arrival night still has its original price', after2.nights[0].id === before1.nights[0].id);
  h.check('the delta is the negative of the removed nights', r2.payload.deltaMinor === -r2.payload.removedNights.reduce((s, n) => s + n.rateMinor + n.taxMinor, 0));
  await assertCounters('after shortening');

  const r3 = await change(s1, shiftDays(a1, 2), shiftDays(a1, 5));
  h.check('move to later dates (no overlap): 200, +3 -1', r3.status === 200 && r3.payload?.addedNights?.length === 3 && r3.payload?.removedNights?.length === 1, show(r3));
  assertConsistent('moved', await stored(s1), shiftDays(a1, 2), shiftDays(a1, 5));
  await assertCounters('after moving');

  const r4 = await change(s1, shiftDays(a1, 1), shiftDays(a1, 6), { overrideNightlyRateMinor: 123400 });
  h.check('both ends with a manual price: 200', r4.status === 200, show(r4));
  const after4 = await stored(s1);
  assertConsistent('both ends', after4, shiftDays(a1, 1), shiftDays(a1, 6));
  const manual = after4.nights.filter((n) => [shiftDays(a1, 1), shiftDays(a1, 5)].includes(iso(n.stayDate)));
  h.check('the two added nights are MANUAL at the given price', manual.length === 2 && manual.every((n) => n.rateSource === 'MANUAL' && n.rateMinor === 123400), JSON.stringify(manual));
  h.check('the kept nights did not reprice', after4.nights.filter((n) => n.rateSource === 'RACK').length === 3);
  await assertCounters('after both ends');

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. A moved price is refused rather than charged.');
  const stale = await change(s1, shiftDays(a1, 1), shiftDays(a1, 7), { expectedTotalMinor: 1 });
  h.check('expectedTotalMinor mismatch: 400', stale.status === 400 && stale.payload?.details?.issues?.expectedTotalMinor !== undefined, show(stale));
  h.check('and nothing changed', (await stored(s1)).departure === shiftDays(a1, 6));

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. Availability: sold-out category, a taken room, the end of the calendar.');
  const full = shiftDays(today, 12);
  const sB = await booking({ arrival: shiftDays(full, -2), nights: 2, category: fixture.categoryB, last: 'B-Extend' });
  await booking({ arrival: full, nights: 1, category: fixture.categoryB, last: 'B-Fill1' });
  await booking({ arrival: full, nights: 1, category: fixture.categoryB, last: 'B-Fill2' });
  const beforeSold = await stored(sB);
  const soldOut = await change(sB, shiftDays(full, -2), shiftDays(full, 1));
  h.check('extending into a sold-out night: 409 ROOM_UNAVAILABLE', soldOut.status === 409 && soldOut.payload?.code === 'ROOM_UNAVAILABLE', show(soldOut));
  h.check('and the stay is unchanged', (await stored(sB)).departure === beforeSold.departure);
  await assertCounters('after the sold-out refusal');

  const roomed = await booking({ arrival: shiftDays(today, 20), nights: 2, roomId: fixture.rooms.A2.id, last: 'Roomed' });
  await booking({ arrival: shiftDays(today, 22), nights: 1, roomId: fixture.rooms.A2.id, last: 'Next' });
  const clash = await change(roomed, shiftDays(today, 20), shiftDays(today, 23));
  h.check('extending into a night the room is booked: 409 ROOM_UNAVAILABLE', clash.status === 409 && clash.payload?.code === 'ROOM_UNAVAILABLE', show(clash));
  h.check('and the stay is unchanged', (await stored(roomed)).departure === shiftDays(today, 22));
  await assertCounters('after the room-clash refusal');

  const edge = await booking({ arrival: shiftDays(horizon, -1), nights: 2, last: 'Edge' });
  const beyond = await change(edge, shiftDays(horizon, -1), shiftDays(horizon, 2));
  h.check('beyond the calendar: 409 INVENTORY_NOT_CONFIGURED', beyond.status === 409 && beyond.payload?.code === 'INVENTORY_NOT_CONFIGURED', show(beyond));
  await assertCounters('after the calendar refusal');

  /* ------------------------------------------------------------------ 5 */
  console.log('\n5. Checked-in: departure only, never before a charged night.');
  const inHouse = await booking({ arrival: today, nights: 2, roomId: fixture.rooms.B1.id, category: fixture.categoryB, last: 'InHouse' });
  const checkIn = await h.call('POST', `${base}/reservations/${inHouse.id}/check-in`, clerk, {
    roomId: fixture.rooms.B1.id,
    primaryGuestIdType: 'PASSPORT',
    primaryGuestIdNumber: 'P1234567',
    acknowledgeRoomNotClean: true,
  });
  h.check('setup: the stay checks in (arrival night charged)', ok(checkIn), show(checkIn));
  const moveArrival = await change(inHouse, shiftDays(today, 1), shiftDays(today, 3));
  h.check('moving the arrival of an in-house stay: 400', moveArrival.status === 400 && moveArrival.payload?.details?.issues?.arrivalDate !== undefined, show(moveArrival));
  const extendIn = await change(inHouse, today, shiftDays(today, 4));
  h.check('extending an in-house stay: 200', extendIn.status === 200, show(extendIn));
  assertConsistent('in-house extended', await stored(inHouse), today, shiftDays(today, 4));
  await assertCounters('after the in-house extension');

  // A night the audit has already charged: night today+1, posted on this
  // suite's own folio the way the night audit posts it.
  const folio = await prisma.folio.findFirst({ where: { reservationId: inHouse.id }, select: { id: true } });
  await prisma.folioLine.create({
    data: {
      propertyId: fixture.propertyId,
      folioId: folio.id,
      kind: 'ROOM_CHARGE',
      description: 'Suite: night already charged',
      amountMinor: 100000,
      currency: 'INR',
      chargeDate: utcMidnight(shiftDays(today, 1)),
    },
  });
  const overCharged = await change(inHouse, today, shiftDays(today, 1));
  h.check(
    'shortening past a charged night: 400 on departureDate',
    overCharged.status === 400 && overCharged.payload?.details?.issues?.departureDate !== undefined,
    show(overCharged),
  );
  h.check('and the stay is unchanged', (await stored(inHouse)).departure === shiftDays(today, 4));
  const shortenIn = await change(inHouse, today, shiftDays(today, 2));
  h.check('shortening to just after the charged night: 200', shortenIn.status === 200, show(shortenIn));
  assertConsistent('in-house shortened', await stored(inHouse), today, shiftDays(today, 2));
  await assertCounters('after the in-house changes');

  /* ------------------------------------------------------------------ 6 */
  console.log('\n6. Refusals and tenancy.');
  const plain = await booking({ arrival: shiftDays(today, 25), nights: 2, last: 'Plain' });
  const same = await change(plain, shiftDays(today, 25), shiftDays(today, 27));
  h.check('the same dates: 400', same.status === 400, show(same));
  const past = await change(plain, shiftDays(today, -1), shiftDays(today, 27));
  h.check('arrival before the business date: 400', past.status === 400 && past.payload?.details?.issues?.arrivalDate !== undefined, show(past));
  const backwards = await change(plain, shiftDays(today, 27), shiftDays(today, 25));
  h.check('departure before arrival: 400', backwards.status === 400, show(backwards));
  const denied = await change(plain, shiftDays(today, 25), shiftDays(today, 28), {}, fixture.users.revenue.cookie);
  h.check('a role without reservations:edit: 403', denied.status === 403, show(denied));
  const cross = await h.call('POST', `/properties/${theirs.propertyCode}/reservations/${plain.id}/dates`, theirs.users.admin.cookie, {
    arrivalDate: shiftDays(today, 25),
    departureDate: shiftDays(today, 28),
  });
  h.check('another property: 404, not 403', cross.status === 404, show(cross));
  const crossPreview = await h.call('POST', `/properties/${theirs.propertyCode}/reservations/${plain.id}/dates/preview`, theirs.users.admin.cookie, {
    arrivalDate: shiftDays(today, 25),
    departureDate: shiftDays(today, 28),
  });
  h.check('and its preview: 404', crossPreview.status === 404, show(crossPreview));
  const unknown = await change({ id: randomUUID() }, shiftDays(today, 25), shiftDays(today, 28));
  h.check('an unknown reservation: 404', unknown.status === 404, show(unknown));
  await cancel(plain);
  const ofCancelled = await change(plain, shiftDays(today, 25), shiftDays(today, 28));
  h.check('a cancelled stay: 400', ofCancelled.status === 400 && ofCancelled.payload?.details?.issues?.status !== undefined, show(ofCancelled));
  h.check('the untouched stays carry no date-change audit', (await audits(plain)) === 0);
  await assertCounters('after the refusals');

  /* ------------------------------------------------------------------ 7 */
  console.log('\n7. A stay booked before per-night pricing.');
  const legacy = await booking({ arrival: shiftDays(today, 28), nights: 3, last: 'Legacy' });
  const legacyTotal = (await stored(legacy)).total;
  await prisma.reservationNight.deleteMany({ where: { reservationId: legacy.id } });
  const rl = await change(legacy, shiftDays(today, 28), shiftDays(today, 30));
  h.check('shortening it: 200', rl.status === 200, show(rl));
  const afterLegacy = await stored(legacy);
  assertConsistent('legacy shortened', afterLegacy, shiftDays(today, 28), shiftDays(today, 30));
  h.check('the removed night took its even share of the old total', afterLegacy.total === legacyTotal - Math.floor(legacyTotal / 3), `${String(legacyTotal)} -> ${String(afterLegacy.total)}`);
  await assertCounters('after the legacy change');

  /* ------------------------------------------------------------------ 8 */
  console.log('\n8. Concurrency.');
  // Category B has 2 rooms. One is left on `lastNight`; two stays race for it.
  const lastNight = shiftDays(today, 17);
  const racerA = await booking({ arrival: shiftDays(lastNight, -1), nights: 1, category: fixture.categoryB, last: 'RacerA' });
  const racerB = await booking({ arrival: shiftDays(lastNight, -1), nights: 1, category: fixture.categoryB, last: 'RacerB' });
  await booking({ arrival: lastNight, nights: 1, category: fixture.categoryB, last: 'Holder' });
  const race = await Promise.all([
    change(racerA, shiftDays(lastNight, -1), shiftDays(lastNight, 1)),
    change(racerB, shiftDays(lastNight, -1), shiftDays(lastNight, 1)),
  ]);
  h.check(
    'two extensions into the last room: exactly one wins, the other 409',
    race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 1,
    race.map(show).join(' | '),
  );
  await assertCounters('after the last-room race');

  const repeat = await booking({ arrival: shiftDays(today, 6), nights: 2, last: 'Parallel' });
  const parallel = await Promise.all(
    Array.from({ length: 8 }, () => change(repeat, shiftDays(today, 6), shiftDays(today, 9))),
  );
  h.check('eight identical parallel extensions: exactly one 200, the rest 4xx', parallel.filter((r) => r.status === 200).length === 1 && parallel.every((r) => r.status === 200 || (r.status >= 400 && r.status < 500)), parallel.map((r) => r.status).join(','));
  h.check('exactly one audit row', (await audits(repeat)) === 1);
  assertConsistent('after the parallel extensions', await stored(repeat), shiftDays(today, 6), shiftDays(today, 9));
  await assertCounters('after the parallel extensions');

  for (const order of ['change first', 'cancel first']) {
    const stay = await booking({ arrival: shiftDays(today, 8), nights: 2, last: order === 'change first' ? 'RaceC' : 'RaceD' });
    const ops =
      order === 'change first'
        ? [() => change(stay, shiftDays(today, 8), shiftDays(today, 11)), () => cancel(stay)]
        : [() => cancel(stay), () => change(stay, shiftDays(today, 8), shiftDays(today, 11))];
    const { settled, parked } = await underReservationLock(stay.id, ops);
    const [first, second] = settled;
    const s = await stored(stay);
    h.check(`${order}: both parked on the lock in that order`, parked);
    if (order === 'change first') {
      h.check('change first: both succeed and the cancellation releases the NEW nights', first.status === 200 && second.status === 200 && s.status === 'CANCELLED' && s.departure === shiftDays(today, 11), `${show(first)} | ${show(second)}`);
    } else {
      h.check('cancel first: the change is refused 400 under the lock', first.status === 200 && second.status === 400 && s.status === 'CANCELLED' && s.departure === shiftDays(today, 10), `${show(first)} | ${show(second)}`);
    }
    await assertCounters(`${order}: counters exact`);
  }

  const parkedStay = await booking({ arrival: shiftDays(today, 14), nights: 1, last: 'Parked' });
  const { settled: [parkedRes], elapsed } = await underReservationLock(
    parkedStay.id,
    [() => change(parkedStay, shiftDays(today, 14), shiftDays(today, 16))],
    { holdUntilSettled: true },
  );
  h.check('a change parked behind a held lock: 409 CONFLICT', parkedRes.status === 409 && parkedRes.payload?.code === 'CONFLICT', show(parkedRes));
  h.check('after the 3 s lock timeout (~3-8 s)', elapsed >= 2_500 && elapsed < 8_000, `${String(elapsed)} ms`);
  h.check('and it is unchanged', (await stored(parkedStay)).departure === shiftDays(today, 15));

  await assertCounters('final');
}

await runSuite({
  harness: h,
  prisma,
  label: 'stay-dates integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
