/**
 * Room blocks and the overbooking allowance, end to end (AV-04, RM-06, P0-2).
 *
 * ===========================================================================
 * WHAT THIS PROVES, against a running API and a real PostgreSQL:
 *
 *   1. A category block raises `inventory_day.blocked` on exactly its nights.
 *   2. A blocked unit cannot be sold: the real booking endpoint is refused once
 *      the unblocked rooms are gone (the oversell CHECK still holds).
 *   3. A block never spends overbooking headroom, while a booking may.
 *   4. The overbooking allowance is set per date range, idempotently, and
 *      cannot be lowered below what is already sold and blocked.
 *   5. Specific-room blocks refuse a room that is already blocked or has a
 *      stay, and a room of another category.
 *   6. Release gives every night back exactly once, and is idempotent.
 *   7. Under N parallel blocks on a night with K unsold rooms, exactly K
 *      succeed; N parallel releases of one block decrement once.
 *   8. Permissions, and another property's blocks are not-found, never 403.
 *
 * After every section the counters are compared PER DATE AND PER CATEGORY
 * with the live `room_block` and `reservation_room` rows (CLAUDE.md 3.1.1
 * requirement 6) -- aggregate totals can match while a category is corrupt.
 *
 * ISOLATION: suite-owned fixtures only (prefix ZZRBK, and ZZRBX for the second
 * property), created and torn down here. Inventory rows are inserted for the
 * fixture's own categories; no shared counter is touched.
 * ===========================================================================
 */

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'room blocks';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRBK',
  slugPrefix: 'zz-rbk-',
  emailDomain: 'rbk.invalid',
  prisma,
});

/** The second property, for tenancy only. Its own prefix, its own teardown. */
const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZRBX',
  slugPrefix: 'zz-rbx-',
  emailDomain: 'rbx.invalid',
  prisma,
});

const WINDOW_NIGHTS = 14;
const LIVE_STATUSES = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'];

let fixture;
const createdReservationIds = [];

async function book(cookie, roomTypeId, arrival, departure, roomId = null) {
  return h.call('POST', `/properties/${fixture.propertyCode}/reservations`, cookie, {
    roomTypeId,
    roomId,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Block', lastName: 'Fixture' }],
    isInstantCheckIn: false,
  });
}

async function counters(roomTypeId, night) {
  const row = await prisma.inventoryDay.findFirst({
    where: { propertyId: fixture.propertyId, roomTypeId, stayDate: utcMidnight(night) },
    select: { physical: true, sold: true, blocked: true, overbookingAllowance: true },
  });
  if (row === null) throw new Error(`no inventory row for ${night}`);
  return row;
}

/**
 * Every night of the window, for both categories: `blocked` equals the sum of
 * ACTIVE blocks covering it, and `sold` equals the live stays covering it.
 * Returns the number of mismatches so a section can assert zero.
 */
async function countersMatchRows() {
  const [days, blocks, stays] = await Promise.all([
    prisma.inventoryDay.findMany({
      where: { propertyId: fixture.propertyId },
      select: { roomTypeId: true, stayDate: true, sold: true, blocked: true },
    }),
    prisma.roomBlock.findMany({
      where: { propertyId: fixture.propertyId, status: 'ACTIVE' },
      select: { roomTypeId: true, rooms: true, fromDate: true, throughDate: true },
    }),
    prisma.reservationRoom.findMany({
      where: { propertyId: fixture.propertyId, status: { in: LIVE_STATUSES } },
      select: { roomTypeId: true, arrivalDate: true, departureDate: true },
    }),
  ]);

  const mismatches = [];
  for (const day of days) {
    const t = day.stayDate.getTime();
    const wantBlocked = blocks
      .filter(
        (b) =>
          b.roomTypeId === day.roomTypeId &&
          b.fromDate.getTime() <= t &&
          t < b.throughDate.getTime(),
      )
      .reduce((sum, b) => sum + b.rooms, 0);
    const wantSold = stays.filter(
      (s) =>
        s.roomTypeId === day.roomTypeId &&
        s.arrivalDate.getTime() <= t &&
        t < s.departureDate.getTime(),
    ).length;
    if (day.blocked !== wantBlocked || day.sold !== wantSold) {
      mismatches.push(
        `${day.stayDate.toISOString().slice(0, 10)}/${day.roomTypeId.slice(0, 8)} ` +
          `blocked=${String(day.blocked)} want ${String(wantBlocked)}, ` +
          `sold=${String(day.sold)} want ${String(wantSold)}`,
      );
    }
  }
  return mismatches;
}

async function assertConsistent(label) {
  const mismatches = await countersMatchRows();
  h.check(
    `${label}: counters match live blocks and stays per date and per category`,
    mismatches.length === 0,
    mismatches.slice(0, 3).join('; '),
  );
}

async function body() {
  console.log('\n════ room blocks and overbooking ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded([
    '/properties/ZZRBK-PROBE/room-blocks',
    '/properties/ZZRBK-PROBE/inventory/days',
  ]);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', revenue: 'REVENUE_MANAGER' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A3', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'B1', category: 'B', status: 'VACANT_CLEAN' },
    ],
  });
  await h.assertOwnership(fixture, { types: 2, rooms: 4, grants: 3, stays: 0 });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);

  // The fixture's own calendar: A has 3 rooms, B has 1.
  const nights = Array.from({ length: WINDOW_NIGHTS }, (_, i) => shiftDays(fixture.today, i));
  await prisma.inventoryDay.createMany({
    data: nights.flatMap((night) => [
      {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryA,
        stayDate: utcMidnight(night),
        physical: 3,
      },
      {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryB,
        stayDate: utcMidnight(night),
        physical: 1,
      },
    ]),
  });
  h.note(`inventory: ${String(WINDOW_NIGHTS)} nights from ${fixture.today}, A=3 B=1`);

  const d = (i) => shiftDays(fixture.today, i);
  const blocksPath = `/properties/${fixture.propertyCode}/room-blocks`;
  const overbookingPath = `/properties/${fixture.propertyCode}/inventory/overbooking`;
  const { admin, clerk, revenue } = {
    admin: fixture.users.admin.cookie,
    clerk: fixture.users.clerk.cookie,
    revenue: fixture.users.revenue.cookie,
  };

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. A category block raises `blocked` on exactly its nights.');
  let categoryBlockId;
  {
    const res = await h.call('POST', blocksPath, revenue, {
      roomTypeId: fixture.categoryA,
      rooms: 2,
      fromDate: d(1),
      throughDate: d(3),
      reason: 'MAINTENANCE',
      note: 'AC service',
    });
    h.check('REVENUE_MANAGER may block: 201', res.status === 201, `HTTP ${String(res.status)}`);
    categoryBlockId = res.payload?.id;
    h.check('three nights, inclusive', res.payload?.nightCount === 3);
    h.check('throughDate round-trips inclusive', res.payload?.throughDate === d(3));
    h.check('no propertyId leaks', res.payload !== null && !('propertyId' in res.payload));

    const stored = await prisma.roomBlock.findFirst({
      where: { id: categoryBlockId, propertyId: fixture.propertyId },
      select: { throughDate: true },
    });
    h.check(
      'stored throughDate is exclusive',
      stored?.throughDate.toISOString().slice(0, 10) === d(4),
    );

    for (const [night, want] of [
      [d(0), 0],
      [d(1), 2],
      [d(2), 2],
      [d(3), 2],
      [d(4), 0],
    ]) {
      const c = await counters(fixture.categoryA, night);
      h.check(
        `A ${night}: blocked=${String(want)}`,
        c.blocked === want,
        `got ${String(c.blocked)}`,
      );
    }
    const b = await counters(fixture.categoryB, d(2));
    h.check('category B is untouched', b.blocked === 0);

    const days = await h.call(
      'GET',
      `/properties/${fixture.propertyCode}/inventory/days?roomTypeId=${fixture.categoryA}&fromDate=${d(1)}&toDate=${d(1)}`,
      clerk,
    );
    h.check('inventory/days answers 200', days.status === 200, `HTTP ${String(days.status)}`);
    h.check('sellable reflects the block: 3 - 2 = 1', days.payload?.days?.[0]?.sellable === 1);

    const audit = await prisma.auditLog.count({
      where: {
        propertyId: fixture.propertyId,
        event: 'ROOM_BLOCK_CREATED',
        entityId: categoryBlockId,
      },
    });
    h.check('one ROOM_BLOCK_CREATED audit row', audit === 1);

    const list = await h.call('GET', `${blocksPath}?status=ACTIVE`, clerk);
    h.check('FRONT_DESK may list blocks', list.status === 200);
    h.check(
      'the block is listed',
      list.payload?.items?.some((item) => item.id === categoryBlockId) === true,
    );
    await assertConsistent('after block');
  }

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. A blocked unit cannot be sold.');
  {
    const first = await book(clerk, fixture.categoryA, d(1), d(2));
    h.check(
      'the one unblocked room books: 201',
      first.status === 201,
      `HTTP ${String(first.status)}`,
    );
    if (first.payload?.id) createdReservationIds.push(first.payload.id);

    const second = await book(clerk, fixture.categoryA, d(1), d(2));
    h.check(
      'the next booking is refused 409 ROOM_UNAVAILABLE',
      second.status === 409 && second.payload?.code === 'ROOM_UNAVAILABLE',
      `HTTP ${String(second.status)} ${String(second.payload?.code)}`,
    );

    const c = await counters(fixture.categoryA, d(1));
    h.check('sold 1 + blocked 2 = physical 3', c.sold === 1 && c.blocked === 2);
    await assertConsistent('after bookings');
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. No capacity left: a further block is refused, and changes nothing.');
  {
    const res = await h.call('POST', blocksPath, revenue, {
      roomTypeId: fixture.categoryA,
      rooms: 1,
      fromDate: d(1),
      throughDate: d(1),
      reason: 'OWNER_USE',
    });
    h.check(
      'refused 409 ROOM_UNAVAILABLE',
      res.status === 409 && res.payload?.code === 'ROOM_UNAVAILABLE',
      `HTTP ${String(res.status)}`,
    );
    h.check('it names the night', res.payload?.details?.stayDate === d(1));
    const c = await counters(fixture.categoryA, d(1));
    h.check('counters unchanged', c.blocked === 2 && c.sold === 1);
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Overbooking allowance: set per range; blocks never spend it.');
  {
    const set = await h.call('PUT', overbookingPath, revenue, {
      roomTypeId: fixture.categoryA,
      fromDate: d(1),
      throughDate: d(2),
      allowance: 1,
      reason: 'Historic no-show rate',
    });
    h.check(
      'REVENUE_MANAGER sets allowance: 200',
      set.status === 200,
      `HTTP ${String(set.status)}`,
    );
    h.check('two nights updated', set.payload?.nightsUpdated === 2);
    const c1 = await counters(fixture.categoryA, d(1));
    const c3 = await counters(fixture.categoryA, d(3));
    h.check('d1 allowance = 1', c1.overbookingAllowance === 1);
    h.check('d3 allowance untouched', c3.overbookingAllowance === 0);

    const repeat = await h.call('PUT', overbookingPath, revenue, {
      roomTypeId: fixture.categoryA,
      fromDate: d(1),
      throughDate: d(2),
      allowance: 1,
      reason: 'Repeat',
    });
    h.check('repeat is idempotent: 200', repeat.status === 200);

    const block = await h.call('POST', blocksPath, revenue, {
      roomTypeId: fixture.categoryA,
      rooms: 1,
      fromDate: d(1),
      throughDate: d(1),
      reason: 'OWNER_USE',
    });
    h.check('a block still may NOT use the headroom: 409', block.status === 409);

    const overbook = await book(clerk, fixture.categoryA, d(1), d(2));
    h.check('a booking may: 201', overbook.status === 201, `HTTP ${String(overbook.status)}`);
    if (overbook.payload?.id) createdReservationIds.push(overbook.payload.id);

    const lower = await h.call('PUT', overbookingPath, revenue, {
      roomTypeId: fixture.categoryA,
      fromDate: d(1),
      throughDate: d(1),
      allowance: 0,
      reason: 'Undo',
    });
    h.check(
      'lowering below sold + blocked is refused 400',
      lower.status === 400 && lower.payload?.code === 'VALIDATION_FAILED',
      `HTTP ${String(lower.status)}`,
    );
    h.check(
      'allowance unchanged',
      (await counters(fixture.categoryA, d(1))).overbookingAllowance === 1,
    );

    const clerkSet = await h.call('PUT', overbookingPath, clerk, {
      roomTypeId: fixture.categoryA,
      fromDate: d(5),
      throughDate: d(5),
      allowance: 3,
      reason: 'x',
    });
    h.check('FRONT_DESK may NOT set allowance: 403', clerkSet.status === 403);

    const gap = await h.call('PUT', overbookingPath, revenue, {
      roomTypeId: fixture.categoryA,
      fromDate: d(WINDOW_NIGHTS - 1),
      throughDate: d(WINDOW_NIGHTS + 2),
      allowance: 1,
      reason: 'Past the calendar',
    });
    h.check(
      'a range past the calendar is refused 409 INVENTORY_NOT_CONFIGURED',
      gap.status === 409 && gap.payload?.code === 'INVENTORY_NOT_CONFIGURED',
      `HTTP ${String(gap.status)} ${String(gap.payload?.code)}`,
    );
    h.check(
      'and nothing was written',
      (await counters(fixture.categoryA, d(WINDOW_NIGHTS - 1))).overbookingAllowance === 0,
    );

    const audit = await prisma.auditLog.count({
      where: { propertyId: fixture.propertyId, event: 'INVENTORY_OVERBOOKING_SET' },
    });
    h.check('each accepted allowance write is audited', audit === 2, `${String(audit)} rows`);
    await assertConsistent('after overbooking');
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Specific-room blocks.');
  let roomBlockId;
  {
    const res = await h.call('POST', blocksPath, admin, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A3.id,
      fromDate: d(5),
      throughDate: d(6),
      reason: 'RENOVATION',
    });
    h.check('PROPERTY_ADMIN blocks room A3: 201', res.status === 201, `HTTP ${String(res.status)}`);
    roomBlockId = res.payload?.id;
    h.check(
      'named room, one unit',
      res.payload?.roomNumber === fixture.rooms.A3.number && res.payload?.rooms === 1,
    );
    h.check('A d5 blocked = 1', (await counters(fixture.categoryA, d(5))).blocked === 1);

    const again = await h.call('POST', blocksPath, admin, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A3.id,
      fromDate: d(6),
      throughDate: d(7),
      reason: 'RENOVATION',
    });
    h.check('an overlapping block on the same room: 409', again.status === 409);

    const stay = await book(clerk, fixture.categoryA, d(8), d(9), fixture.rooms.A1.id);
    h.check('a stay is booked into A1', stay.status === 201, `HTTP ${String(stay.status)}`);
    if (stay.payload?.id) createdReservationIds.push(stay.payload.id);
    const onStay = await h.call('POST', blocksPath, admin, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A1.id,
      fromDate: d(8),
      throughDate: d(8),
      reason: 'MAINTENANCE',
    });
    h.check('blocking a room with a stay: 409', onStay.status === 409);
    h.check('it names the stay', typeof onStay.payload?.details?.conflictsWith === 'string');

    const wrongType = await h.call('POST', blocksPath, admin, {
      roomTypeId: fixture.categoryB,
      roomId: fixture.rooms.A2.id,
      fromDate: d(5),
      throughDate: d(5),
      reason: 'MAINTENANCE',
    });
    h.check('a room of another category: 400', wrongType.status === 400);

    const both = await h.call('POST', blocksPath, admin, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A2.id,
      rooms: 2,
      fromDate: d(5),
      throughDate: d(5),
      reason: 'MAINTENANCE',
    });
    h.check('roomId and rooms together: 400', both.status === 400);
    await assertConsistent('after room blocks');
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Release gives every night back exactly once.');
  {
    const res = await h.call('POST', `${blocksPath}/${categoryBlockId}/release`, revenue);
    h.check('release: 200', res.status === 200, `HTTP ${String(res.status)}`);
    h.check(
      'status RELEASED, attributed',
      res.payload?.status === 'RELEASED' &&
        res.payload?.releasedByUserId === fixture.users.revenue.id,
    );
    for (const night of [d(1), d(2), d(3)]) {
      h.check(
        `A ${night}: blocked back to 0`,
        (await counters(fixture.categoryA, night)).blocked === 0,
      );
    }

    const again = await h.call('POST', `${blocksPath}/${categoryBlockId}/release`, revenue);
    h.check(
      'a second release is idempotent: 200',
      again.status === 200 && again.payload?.status === 'RELEASED',
    );
    h.check('and decrements nothing', (await counters(fixture.categoryA, d(2))).blocked === 0);

    const released = await prisma.auditLog.count({
      where: {
        propertyId: fixture.propertyId,
        event: 'ROOM_BLOCK_RELEASED',
        entityId: categoryBlockId,
      },
    });
    h.check('exactly one ROOM_BLOCK_RELEASED audit row', released === 1);

    const missing = await h.call('POST', `${blocksPath}/not-a-uuid/release`, revenue);
    h.check(
      'a malformed id is 404, not 500',
      missing.status === 404,
      `HTTP ${String(missing.status)}`,
    );
    await assertConsistent('after release');
  }

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. Concurrency: parallel blocks and parallel releases.');
  {
    const night = d(10);
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        h.call('POST', blocksPath, revenue, {
          roomTypeId: fixture.categoryA,
          rooms: 1,
          fromDate: night,
          throughDate: night,
          reason: 'OWNER_USE',
        }),
      ),
    );
    const won = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    h.check(
      `${String(N)} parallel blocks on 3 unsold rooms: exactly 3 succeed`,
      won.length === 3,
      `statuses ${results.map((r) => r.status).join(',')}`,
    );
    h.check('the rest are typed 409s, never 500', refused.length === N - 3);
    h.check('blocked = 3, never more', (await counters(fixture.categoryA, night)).blocked === 3);
    await assertConsistent('after parallel blocks');

    const target = won[0]?.payload?.id;
    const releases = await Promise.all(
      Array.from({ length: N }, () => h.call('POST', `${blocksPath}/${target}/release`, revenue)),
    );
    h.check(
      `${String(N)} parallel releases of one block all answer 200`,
      releases.every((r) => r.status === 200),
      `statuses ${releases.map((r) => r.status).join(',')}`,
    );
    h.check(
      'blocked decremented exactly once: 2',
      (await counters(fixture.categoryA, night)).blocked === 2,
    );
    const audits = await prisma.auditLog.count({
      where: { propertyId: fixture.propertyId, event: 'ROOM_BLOCK_RELEASED', entityId: target },
    });
    h.check('one release audited', audits === 1);
    await assertConsistent('after parallel releases');
  }

  /* -------------------------------------------------------------- 8 */
  console.log('\n8. Permissions and tenancy.');
  {
    const clerkBlock = await h.call('POST', blocksPath, clerk, {
      roomTypeId: fixture.categoryA,
      rooms: 1,
      fromDate: d(12),
      throughDate: d(12),
      reason: 'OTHER',
    });
    h.check('FRONT_DESK may NOT create a block: 403', clerkBlock.status === 403);
    const clerkRelease = await h.call('POST', `${blocksPath}/${roomBlockId}/release`, clerk);
    h.check('nor release one: 403', clerkRelease.status === 403);

    const foreign = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
    const outsider = foreign.users.admin.cookie;

    const viaTheirCode = await h.call(
      'GET',
      `/properties/${fixture.propertyCode}/room-blocks`,
      outsider,
    );
    h.check('our property via our code, their session: 404', viaTheirCode.status === 404);

    const idor = await h.call(
      'GET',
      `/properties/${foreign.propertyCode}/room-blocks/${roomBlockId}`,
      outsider,
    );
    h.check('our block id under their property: 404, never 403', idor.status === 404);

    const idorRelease = await h.call(
      'POST',
      `/properties/${foreign.propertyCode}/room-blocks/${roomBlockId}/release`,
      outsider,
    );
    h.check('releasing our block from their property: 404', idorRelease.status === 404);

    const theirList = await h.call(
      'GET',
      `/properties/${foreign.propertyCode}/room-blocks`,
      outsider,
    );
    h.check(
      'their list does not contain our blocks',
      theirList.status === 200 && theirList.payload?.items?.length === 0,
    );

    const crossType = await h.call(
      'POST',
      `/properties/${foreign.propertyCode}/room-blocks`,
      outsider,
      {
        roomTypeId: fixture.categoryA,
        rooms: 1,
        fromDate: d(12),
        throughDate: d(12),
        reason: 'OTHER',
      },
    );
    h.check('blocking our room type from their property: 404', crossType.status === 404);

    const crossAllowance = await h.call(
      'PUT',
      `/properties/${foreign.propertyCode}/inventory/overbooking`,
      outsider,
      {
        roomTypeId: fixture.categoryA,
        fromDate: d(12),
        throughDate: d(12),
        allowance: 5,
        reason: 'x',
      },
    );
    h.check('setting our allowance from their property: 404', crossAllowance.status === 404);
    h.check(
      'our room block is still ACTIVE',
      (await prisma.roomBlock.findFirst({ where: { id: roomBlockId }, select: { status: true } }))
        ?.status === 'ACTIVE',
    );
    h.check(
      'our d12 allowance is untouched',
      (await counters(fixture.categoryA, d(12))).overbookingAllowance === 0,
    );
    await assertConsistent('final');
  }
}

await runSuite({
  harness: h,
  prisma,
  label: 'room block integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
