/**
 * Retiring rooms and room types (RM-02, RM-04, P0-4).
 *
 * ===========================================================================
 * WHAT THIS PROVES, against a running API and a real PostgreSQL:
 *
 *   1. Retiring an unused room takes exactly one unit off `physical` from today
 *      on, is audited, and is idempotent.
 *   2. A retired room cannot be booked into, blocked, or have its status set.
 *   3. Retirement is refused (409) with a typed error while the room has a
 *      current or future stay or an active block, or when removing it would
 *      oversell a night -- and a refusal changes nothing.
 *   4. A room type is refused while it has an active room or a live stay, and
 *      once retired is no longer quotable or bookable and takes no new rooms.
 *   5. Retire racing a booking for the last room: exactly one wins.
 *   6. Permissions, and another property's rooms are not-found, never 403.
 *
 * Counters are compared per date and per category with live rows after each
 * section (CLAUDE.md 3.1.1 requirement 6): `physical` against active rooms,
 * `sold` against live stays.
 *
 * ISOLATION: suite-owned fixtures (prefix ZZRET / ZZREX), torn down here.
 * ===========================================================================
 */

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'room retirement';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRET',
  slugPrefix: 'zz-ret-',
  emailDomain: 'ret.invalid',
  prisma,
});

const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZREX',
  slugPrefix: 'zz-rex-',
  emailDomain: 'rex.invalid',
  prisma,
});

const WINDOW_NIGHTS = 7;
const LIVE_STATUSES = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'];

let fixture;

async function book(cookie, roomTypeId, arrival, departure, roomId = null) {
  return h.call('POST', `/properties/${fixture.propertyCode}/reservations`, cookie, {
    roomTypeId,
    roomId,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Retire', lastName: 'Fixture' }],
    isInstantCheckIn: false,
  });
}

async function seedInventory(roomTypeId, physical, allowance = 0) {
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: WINDOW_NIGHTS }, (_, i) => ({
      propertyId: fixture.propertyId,
      roomTypeId,
      stayDate: utcMidnight(shiftDays(fixture.today, i)),
      physical,
      overbookingAllowance: allowance,
    })),
  });
}

async function physicalOn(roomTypeId, night) {
  const row = await prisma.inventoryDay.findFirst({
    where: { propertyId: fixture.propertyId, roomTypeId, stayDate: utcMidnight(night) },
    select: { physical: true, sold: true },
  });
  return row;
}

/**
 * Per date and category: `physical` equals the category's active rooms (the
 * suite seeds it that way and every retirement must keep it so), and `sold`
 * equals the live stays covering the night.
 */
async function assertConsistent(label, roomTypeIds) {
  const mismatches = [];
  for (const roomTypeId of roomTypeIds) {
    const active = await prisma.room.count({
      where: { propertyId: fixture.propertyId, roomTypeId, retiredAt: null },
    });
    const days = await prisma.inventoryDay.findMany({
      where: { propertyId: fixture.propertyId, roomTypeId },
      select: { stayDate: true, physical: true, sold: true },
    });
    const stays = await prisma.reservationRoom.findMany({
      where: { propertyId: fixture.propertyId, roomTypeId, status: { in: LIVE_STATUSES } },
      select: { arrivalDate: true, departureDate: true },
    });
    for (const day of days) {
      const t = day.stayDate.getTime();
      const wantSold = stays.filter(
        (s) => s.arrivalDate.getTime() <= t && t < s.departureDate.getTime(),
      ).length;
      if (day.physical !== active || day.sold !== wantSold) {
        mismatches.push(
          `${day.stayDate.toISOString().slice(0, 10)}/${roomTypeId.slice(0, 8)} ` +
            `physical=${String(day.physical)} want ${String(active)} ` +
            `sold=${String(day.sold)} want ${String(wantSold)}`,
        );
      }
    }
  }
  h.check(
    `${label}: physical matches active rooms and sold matches live stays, per date and category`,
    mismatches.length === 0,
    mismatches.slice(0, 3).join('; '),
  );
}

async function body() {
  console.log('\n════ room and room-type retirement ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded(['/properties/ZZRET-PROBE/rooms']);
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

  await seedInventory(fixture.categoryA, 3);
  await seedInventory(fixture.categoryB, 1);

  const d = (i) => shiftDays(fixture.today, i);
  const base = `/properties/${fixture.propertyCode}`;
  const admin = fixture.users.admin.cookie;
  const clerk = fixture.users.clerk.cookie;
  const revenue = fixture.users.revenue.cookie;

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Retiring an unused room.');
  {
    const res = await h.call('POST', `${base}/rooms/${fixture.rooms.A3.id}/retire`, admin);
    h.check('retire answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    h.check('retiredAt is set', typeof res.payload?.retiredAt === 'string');
    for (const i of [0, 3, WINDOW_NIGHTS - 1]) {
      h.check(
        `A ${d(i)}: physical 3 -> 2`,
        (await physicalOn(fixture.categoryA, d(i)))?.physical === 2,
      );
    }
    h.check('category B untouched', (await physicalOn(fixture.categoryB, d(1)))?.physical === 1);

    const again = await h.call('POST', `${base}/rooms/${fixture.rooms.A3.id}/retire`, admin);
    h.check('a second retire is idempotent: 200', again.status === 200);
    h.check('and takes nothing more', (await physicalOn(fixture.categoryA, d(1)))?.physical === 2);

    const audits = await prisma.auditLog.count({
      where: {
        propertyId: fixture.propertyId,
        event: 'ROOM_RETIRED',
        entityId: fixture.rooms.A3.id,
      },
    });
    h.check('exactly one ROOM_RETIRED audit row', audits === 1);

    const types = await h.call('GET', `${base}/room-types`, clerk);
    const a = types.payload?.items?.find((t) => t.id === fixture.categoryA);
    h.check(
      'room type now counts 2 active rooms',
      a?.roomCount === 2,
      `got ${String(a?.roomCount)}`,
    );
    await assertConsistent('after retire', [fixture.categoryA, fixture.categoryB]);
  }

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. A retired room is out of operations.');
  {
    const booking = await book(clerk, fixture.categoryA, d(1), d(2), fixture.rooms.A3.id);
    h.check('booking into it: 400', booking.status === 400, `HTTP ${String(booking.status)}`);

    const status = await h.call('POST', `${base}/rooms/${fixture.rooms.A3.id}/status`, admin, {
      status: 'VACANT_DIRTY',
    });
    h.check('setting its status: 400', status.status === 400, `HTTP ${String(status.status)}`);

    const block = await h.call('POST', `${base}/room-blocks`, admin, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A3.id,
      fromDate: d(1),
      throughDate: d(1),
      reason: 'MAINTENANCE',
    });
    h.check('blocking it: refused (404, it is no longer stock)', block.status === 404);

    const list = await h.call('GET', `${base}/rooms`, clerk);
    const row = list.payload?.items?.find((r) => r.id === fixture.rooms.A3.id);
    h.check('it is still listed, marked retired', typeof row?.retiredAt === 'string');
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. Refusals change nothing.');
  {
    const stay = await book(clerk, fixture.categoryA, d(2), d(3), fixture.rooms.A1.id);
    h.check('a future stay in A1', stay.status === 201, `HTTP ${String(stay.status)}`);

    const withStay = await h.call('POST', `${base}/rooms/${fixture.rooms.A1.id}/retire`, admin);
    h.check(
      'retiring A1 with a future stay: 409 CONFLICT',
      withStay.status === 409 && withStay.payload?.code === 'CONFLICT',
      `HTTP ${String(withStay.status)}`,
    );
    h.check(
      'it names the stay by confirmation code',
      Array.isArray(withStay.payload?.details?.confirmationCodes) &&
        withStay.payload.details.confirmationCodes.includes(stay.payload?.bookingCode),
    );

    const blocked = await h.call('POST', `${base}/room-blocks`, admin, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A2.id,
      fromDate: d(4),
      throughDate: d(4),
      reason: 'MAINTENANCE',
    });
    h.check('A2 is blocked on d4', blocked.status === 201);
    const withBlock = await h.call('POST', `${base}/rooms/${fixture.rooms.A2.id}/retire`, admin);
    h.check('retiring A2 with an active block: 409', withBlock.status === 409);

    // B has one room and no room-assigned stay; a category booking fills it.
    const categoryStay = await book(clerk, fixture.categoryB, d(5), d(6));
    h.check('category B is fully sold on d5', categoryStay.status === 201);
    const oversell = await h.call('POST', `${base}/rooms/${fixture.rooms.B1.id}/retire`, admin);
    h.check(
      'retiring B1 would oversell d5: 409',
      oversell.status === 409 && oversell.payload?.details?.stayDate === d(5),
      `HTTP ${String(oversell.status)} ${JSON.stringify(oversell.payload?.details ?? {})}`,
    );

    const retired = await prisma.room.count({
      where: { propertyId: fixture.propertyId, retiredAt: { not: null } },
    });
    h.check('only A3 is retired', retired === 1);
    h.check('A physical still 2', (await physicalOn(fixture.categoryA, d(4)))?.physical === 2);
    h.check('B physical still 1', (await physicalOn(fixture.categoryB, d(5)))?.physical === 1);
    await assertConsistent('after refusals', [fixture.categoryA, fixture.categoryB]);
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Retiring room types.');
  {
    const withRooms = await h.call('POST', `${base}/room-types/${fixture.categoryB}/retire`, admin);
    h.check(
      'a type with an active room: 409',
      withRooms.status === 409 && withRooms.payload?.details?.activeRooms === 1,
    );

    // C: one room, no stays -> retire the room, then the type.
    const c = await h.call('POST', `${base}/room-types`, admin, {
      code: 'ZZRETC',
      name: `ZZ Category C ${fixture.runId}`,
      maxGuests: 2,
      baseRate: { amountMinor: 300000, currency: 'INR' },
    });
    h.check(
      'category C created',
      c.status === 201,
      `HTTP ${String(c.status)} ${JSON.stringify(c.payload)}`,
    );
    const cId = c.payload?.id;
    h.owned.roomTypeIds.push(cId);
    const c1 = await h.call('POST', `${base}/rooms`, admin, {
      roomTypeId: cId,
      number: 'ZZRET-C1',
    });
    h.check('room C1 created', c1.status === 201);
    h.owned.roomIds.push(c1.payload?.id);
    await seedInventory(cId, 1);

    h.check(
      'retire C1',
      (await h.call('POST', `${base}/rooms/${c1.payload?.id}/retire`, admin)).status === 200,
    );
    const retireC = await h.call('POST', `${base}/room-types/${cId}/retire`, admin);
    h.check('then retire C: 200', retireC.status === 200, `HTTP ${String(retireC.status)}`);
    h.check('retiredAt is set', typeof retireC.payload?.retiredAt === 'string');
    h.check(
      'idempotent',
      (await h.call('POST', `${base}/room-types/${cId}/retire`, admin)).status === 200,
    );

    const quote = await h.call('POST', `${base}/reservations/quote`, clerk, {
      roomTypeId: cId,
      arrivalDate: d(1),
      departureDate: d(2),
      isTaxExempt: false,
    });
    h.check(
      'a retired type is not quotable: 400',
      quote.status === 400,
      `HTTP ${String(quote.status)}`,
    );
    h.check('nor bookable: 400', (await book(clerk, cId, d(1), d(2))).status === 400);
    const newRoom = await h.call('POST', `${base}/rooms`, admin, {
      roomTypeId: cId,
      number: 'ZZRET-C2',
    });
    h.check('nor takes new rooms: 400', newRoom.status === 400);

    // D: no rooms, an overbooking allowance, and a live unassigned stay.
    const dType = await h.call('POST', `${base}/room-types`, admin, {
      code: 'ZZRETD',
      name: `ZZ Category D ${fixture.runId}`,
      maxGuests: 2,
      baseRate: { amountMinor: 300000, currency: 'INR' },
    });
    const dId = dType.payload?.id;
    h.owned.roomTypeIds.push(dId);
    await seedInventory(dId, 0, 1);
    const dStay = await book(clerk, dId, d(1), d(2));
    h.check(
      'an overbooked stay holds category D',
      dStay.status === 201,
      `HTTP ${String(dStay.status)}`,
    );
    const retireD = await h.call('POST', `${base}/room-types/${dId}/retire`, admin);
    h.check(
      'retiring D with a live stay: 409 naming it',
      retireD.status === 409 &&
        retireD.payload?.details?.confirmationCodes?.includes(dStay.payload?.bookingCode) === true,
      `HTTP ${String(retireD.status)}`,
    );
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Retire racing a booking for the last room.');
  {
    const e = await h.call('POST', `${base}/room-types`, admin, {
      code: 'ZZRETE',
      name: `ZZ Category E ${fixture.runId}`,
      maxGuests: 2,
      baseRate: { amountMinor: 300000, currency: 'INR' },
    });
    const eId = e.payload?.id;
    h.owned.roomTypeIds.push(eId);
    const eRooms = [];
    for (const n of [1, 2, 3]) {
      const r = await h.call('POST', `${base}/rooms`, admin, {
        roomTypeId: eId,
        number: `ZZRET-E${String(n)}`,
      });
      h.owned.roomIds.push(r.payload?.id);
      eRooms.push(r.payload?.id);
    }
    await seedInventory(eId, 3);
    for (let i = 0; i < 2; i += 1) {
      const pre = await book(clerk, eId, d(1), d(2));
      if (pre.status !== 201) throw new Error(`pre-booking failed: ${String(pre.status)}`);
    }

    // sold 2 of 3 on d1. Retiring a room and selling the last one cannot both succeed.
    const [retire, sale] = await Promise.all([
      h.call('POST', `${base}/rooms/${eRooms[2]}/retire`, admin),
      book(clerk, eId, d(1), d(2)),
    ]);
    const wins = [retire.status === 200, sale.status === 201].filter(Boolean).length;
    h.check(
      'exactly one of retire / last booking wins',
      wins === 1,
      `retire HTTP ${String(retire.status)}, booking HTTP ${String(sale.status)}`,
    );
    h.check(
      'the loser is a typed 409, never 500',
      [retire.status, sale.status].every((s) => s !== 500),
    );
    const row = await physicalOn(eId, d(1));
    h.check(
      'never oversold: sold <= physical',
      row !== null && row.sold <= row.physical,
      JSON.stringify(row),
    );
    await assertConsistent('after race', [eId]);
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Permissions and tenancy.');
  {
    const clerkRetire = await h.call('POST', `${base}/rooms/${fixture.rooms.A2.id}/retire`, clerk);
    h.check('FRONT_DESK may NOT retire a room: 403', clerkRetire.status === 403);
    const revenueRetire = await h.call(
      'POST',
      `${base}/room-types/${fixture.categoryB}/retire`,
      revenue,
    );
    h.check('REVENUE_MANAGER may NOT retire a type: 403', revenueRetire.status === 403);

    const foreign = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
    const outsider = foreign.users.admin.cookie;
    const viaOurs = await h.call('POST', `${base}/rooms/${fixture.rooms.A2.id}/retire`, outsider);
    h.check('their admin on our property: 404', viaOurs.status === 404);
    const idor = await h.call(
      'POST',
      `/properties/${foreign.propertyCode}/rooms/${fixture.rooms.A2.id}/retire`,
      outsider,
    );
    h.check('our room id under their property: 404, never 403', idor.status === 404);
    const idorType = await h.call(
      'POST',
      `/properties/${foreign.propertyCode}/room-types/${fixture.categoryB}/retire`,
      outsider,
    );
    h.check('our room type id under their property: 404', idorType.status === 404);
    const bad = await h.call('POST', `${base}/rooms/not-a-uuid/retire`, admin);
    h.check('a malformed id is 404, not 500', bad.status === 404, `HTTP ${String(bad.status)}`);
    h.check(
      'A2 is still in service',
      (
        await prisma.room.findFirst({
          where: { id: fixture.rooms.A2.id },
          select: { retiredAt: true },
        })
      )?.retiredAt === null,
    );
  }
}

await runSuite({
  harness: h,
  prisma,
  label: 'room retirement integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
