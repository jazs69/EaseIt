/**
 * The arrivals / departures board (FD-09).
 *
 * ===========================================================================
 * Acceptance: today's arrivals, departures and in-house lists, per property.
 *
 * Every row kind is built from real stays through the API: due in (room ready,
 * room dirty, unassigned), arrived today, an overdue arrival, due out, an
 * overstay, departed today (early), departed early on an earlier day, a future
 * stay and a cancellation. Balances are the folio's signed sum and are
 * withheld from a role without folio:read; housekeeping is refused; another
 * property is not-found.
 *
 * Suite-owned fixtures only (ZZFDH / ZZFDX), torn down by the harness.
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

const SUITE = 'front-desk-board';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZFDH',
  slugPrefix: 'zz-fdh-',
  emailDomain: 'fdh.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZFDX',
  slugPrefix: 'zz-fdx-',
  emailDomain: 'fdx.invalid',
  prisma,
});

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;

async function body() {
  console.log('\n════ front-desk board (FD-09) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', revenue: 'REVENUE_MANAGER', keeper: 'HOUSEKEEPING' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'VACANT_DIRTY' },
      { label: 'A3', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A4', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A5', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A6', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'B1', category: 'B', status: 'VACANT_CLEAN' },
    ],
  });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);
  const theirs = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });

  const today = fixture.today;
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 12 }, (_, i) => shiftDays(today, i - 4)).flatMap((night) => [
      { propertyId: fixture.propertyId, roomTypeId: fixture.categoryA, stayDate: utcMidnight(night), physical: 10 },
      { propertyId: fixture.propertyId, roomTypeId: fixture.categoryB, stayDate: utcMidnight(night), physical: 4 },
    ]),
  });

  const base = `/properties/${fixture.propertyCode}`;
  const clerk = fixture.users.clerk.cookie;
  const admin = fixture.users.admin.cookie;

  async function booking({ arrival, nights = 1, category = fixture.categoryA, roomId = null, last }) {
    const res = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: category,
      roomId,
      arrivalDate: arrival,
      departureDate: shiftDays(arrival, nights),
      adults: 2,
      children: last === 'Arrived' ? 1 : 0,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Board', lastName: last, govtIdType: 'PASSPORT', govtIdNumber: 'P1234567' }],
      isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking ${last} failed: ${show(res)}`);
    return res.payload;
  }
  async function checkIn(stay, roomId) {
    const res = await h.call('POST', `${base}/reservations/${stay.id}/check-in`, clerk, {
      roomId,
      primaryGuestIdType: 'PASSPORT',
      primaryGuestIdNumber: 'P1234567',
      acknowledgeRoomNotClean: true,
    });
    if (!ok(res)) throw new Error(`check-in failed: ${show(res)}`);
  }
  async function balanceOf(stay) {
    const folio = await prisma.folio.findFirst({ where: { reservationId: stay.id }, select: { id: true } });
    if (folio === null) return 0;
    const sum = await prisma.folioLine.aggregate({ where: { folioId: folio.id }, _sum: { amountMinor: true } });
    return sum._sum.amountMinor ?? 0;
  }

  /* -------------------------------------------------------------- setup */
  const R = fixture.rooms;
  const over = await booking({ arrival: shiftDays(today, -2), nights: 1, roomId: R.A1.id, last: 'Overstay' });
  await checkIn(over, R.A1.id);
  const overdue = await booking({ arrival: shiftDays(today, -1), nights: 3, last: 'Overdue' });
  const dueOut = await booking({ arrival: shiftDays(today, -1), nights: 1, roomId: R.A4.id, last: 'DueOut' });
  await checkIn(dueOut, R.A4.id);
  const departed = await booking({ arrival: shiftDays(today, -1), nights: 3, roomId: R.A5.id, last: 'Departed' });
  await checkIn(departed, R.A5.id);
  const owed = await balanceOf(departed);
  const pay = await h.call('POST', `${base}/folios/by-booking/${departed.bookingCode}/payment`, clerk, {
    method: 'CASH',
    amountMinor: owed,
    remark: null,
    idempotencyKey: randomUUID(),
  });
  if (!ok(pay)) throw new Error(`payment failed: ${show(pay)}`);
  const out = await h.call('POST', `${base}/reservations/${departed.id}/check-out`, clerk, { reason: null });
  if (!ok(out)) throw new Error(`check-out failed: ${show(out)}`);
  // Left early yesterday: checked out, departure still ahead, but not today's departure.
  const earlier = await booking({ arrival: shiftDays(today, -3), nights: 6, roomId: R.A6.id, last: 'EarlierLeaver' });
  await checkIn(earlier, R.A6.id);
  const owedEarlier = await balanceOf(earlier);
  await h.call('POST', `${base}/folios/by-booking/${earlier.bookingCode}/payment`, clerk, {
    method: 'CASH',
    amountMinor: owedEarlier,
    remark: null,
    idempotencyKey: randomUUID(),
  });
  const outEarlier = await h.call('POST', `${base}/reservations/${earlier.id}/check-out`, clerk, { reason: null });
  if (!ok(outEarlier)) throw new Error(`check-out failed: ${show(outEarlier)}`);
  await prisma.reservation.update({
    where: { id: earlier.id },
    // 06:00 UTC yesterday = 11:30 in Asia/Kolkata, yesterday: inside the
    // query's one-day bound, so only the local-date test can exclude it.
    data: { checkedOutAt: new Date(`${shiftDays(today, -1)}T06:00:00.000Z`) },
  });

  const dueIn = await booking({ arrival: today, nights: 2, roomId: R.A3.id, last: 'DueIn' });
  const dirty = await booking({ arrival: today, nights: 2, roomId: R.A2.id, last: 'DirtyRoom' });
  const unassigned = await booking({ arrival: today, nights: 2, last: 'Unassigned' });
  const arrived = await booking({ arrival: today, nights: 1, category: fixture.categoryB, roomId: R.B1.id, last: 'Arrived' });
  await checkIn(arrived, R.B1.id);
  const future = await booking({ arrival: shiftDays(today, 1), nights: 1, last: 'Future' });
  const cancelled = await booking({ arrival: today, nights: 1, last: 'Cancelled' });
  await h.call('POST', `${base}/reservations/${cancelled.id}/cancel`, clerk, { reason: 'Suite' });

  /* ------------------------------------------------------------------ 1 */
  console.log('1. The lists.');
  const res = await h.call('GET', `${base}/front-desk/board`, admin);
  h.check('admin: 200', res.status === 200, show(res));
  const board = res.payload;
  h.check('business date is the property business date', board.businessDate === today, board.businessDate);
  const find = (list, stay) => board[list].find((row) => row.reservationId === stay.id);
  const flagOf = (list, stay) => find(list, stay)?.flag ?? null;
  const ids = (list) => board[list].map((row) => row.reservationId);

  h.check('arrivals: overdue, due in (x3), arrived', [
    flagOf('arrivals', overdue) === 'OVERDUE_ARRIVAL',
    flagOf('arrivals', dueIn) === 'DUE_IN',
    flagOf('arrivals', dirty) === 'DUE_IN',
    flagOf('arrivals', unassigned) === 'DUE_IN',
    flagOf('arrivals', arrived) === 'ARRIVED',
  ].every(Boolean), JSON.stringify(board.arrivals.map((r) => [r.guestName, r.flag])));
  h.check('arrivals lists nothing else', board.arrivals.length === 5, String(board.arrivals.length));
  h.check('the overdue arrival is listed first', board.arrivals[0]?.reservationId === overdue.id);
  h.check('room ready: assigned and clean', find('arrivals', dueIn)?.roomReady === true && find('arrivals', dueIn)?.roomNumber === R.A3.number);
  h.check('room not ready: assigned but dirty', find('arrivals', dirty)?.roomReady === false && find('arrivals', dirty)?.roomStatus === 'VACANT_DIRTY');
  h.check('unassigned: no room, not ready', find('arrivals', unassigned)?.roomNumber === null && find('arrivals', unassigned)?.roomReady === false);

  h.check('departures: overstay, due out, departed today', [
    flagOf('departures', over) === 'OVERSTAY',
    flagOf('departures', dueOut) === 'DUE_OUT',
    flagOf('departures', departed) === 'DEPARTED',
  ].every(Boolean), JSON.stringify(board.departures.map((r) => [r.guestName, r.flag])));
  h.check('departures lists nothing else (not the earlier leaver, not a staying guest)', board.departures.length === 3, String(board.departures.length));
  h.check('the overstay is listed first', board.departures[0]?.reservationId === over.id);

  h.check('in house: every checked-in stay and no one else', JSON.stringify(ids('inHouse').sort()) === JSON.stringify([over.id, dueOut.id, arrived.id].sort()), JSON.stringify(ids('inHouse')));
  const everywhere = [...ids('arrivals'), ...ids('departures'), ...ids('inHouse')];
  h.check('a future stay, a cancellation and an earlier leaver appear nowhere', ![future.id, cancelled.id, earlier.id].some((id) => everywhere.includes(id)));

  h.check(
    'counts agree with the lists',
    JSON.stringify(board.counts) === JSON.stringify({ dueIn: 3, arrived: 1, overdueArrivals: 1, dueOut: 1, departed: 1, overstays: 1, inHouse: 3 }),
    JSON.stringify(board.counts),
  );
  const arrivedRow = find('arrivals', arrived);
  h.check('a row carries guest, code, dates, nights and pax', arrivedRow?.guestName === 'Board Arrived' && arrivedRow?.bookingCode === arrived.bookingCode && arrivedRow?.nights === 1 && arrivedRow?.adults === 2 && arrivedRow?.children === 1);

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Balances.');
  h.check('admin sees balances', board.showsBalances === true);
  const dueOutRow = find('departures', dueOut);
  h.check('due out: the posted folio balance', dueOutRow?.balanceMinor === (await balanceOf(dueOut)) && dueOutRow.balanceMinor > 0, String(dueOutRow?.balanceMinor));
  h.check('departed: settled to zero', find('departures', departed)?.balanceMinor === 0);
  h.check('no folio yet: zero', find('arrivals', unassigned)?.balanceMinor === 0);

  const revenue = await h.call('GET', `${base}/front-desk/board`, fixture.users.revenue.cookie);
  h.check('a role without folio:read: 200 with no balances', revenue.status === 200 && revenue.payload?.showsBalances === false && [...revenue.payload.arrivals, ...revenue.payload.departures, ...revenue.payload.inHouse].every((row) => row.balanceMinor === null), show(revenue));
  h.check('but the same lists', JSON.stringify(revenue.payload?.counts) === JSON.stringify(board.counts));

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Access.');
  const keeper = await h.call('GET', `${base}/front-desk/board`, fixture.users.keeper.cookie);
  h.check('housekeeping (no reservations:read): 403', keeper.status === 403, show(keeper));
  const cross = await h.call('GET', `/properties/${fixture.propertyCode}/front-desk/board`, theirs.users.admin.cookie);
  h.check('another property: 404, not 403', cross.status === 404, show(cross));
  const theirBoard = await h.call('GET', `/properties/${theirs.propertyCode}/front-desk/board`, theirs.users.admin.cookie);
  h.check('their own board is empty: none of this property leaks', theirBoard.status === 200 && theirBoard.payload.arrivals.length === 0 && theirBoard.payload.departures.length === 0 && theirBoard.payload.inHouse.length === 0, show(theirBoard));
  const anonymous = await h.call('GET', `${base}/front-desk/board`, null);
  h.check('no session: 401', anonymous.status === 401, show(anonymous));
}

await runSuite({
  harness: h,
  prisma,
  label: 'front-desk board integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
