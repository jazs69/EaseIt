/**
 * Maintenance work orders (MA-01): a work order takes a room out of order and
 * restores it, and inventory follows.
 *
 * ===========================================================================
 * Through the running API, on suite-owned fixtures. `inventory_day.blocked`
 * is asserted PER DATE against a baseline, never as a total (CLAUDE.md 3.1.1).
 *
 * - Reporting needs housekeeping:read; out of order also room_blocks:manage.
 * - Out of order raises `blocked` on exactly the chosen nights, through a
 *   MAINTENANCE room block linked to the order, in one transaction.
 * - A room holding a stay on those nights is refused, with nothing written.
 * - Resolving gives the room back from the business date: a block that began
 *   earlier keeps its past nights blocked and is shortened, not released.
 * - 8 concurrent resolves move the counter once; 8 concurrent out-of-order
 *   reports on one room and range: exactly one succeeds.
 * - Lifecycle, assignment to someone with a grant only, 403 and 404, and the
 *   database's same-property trigger.
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import { WHOLLY_DISPOSABLE } from '../support/isolation-guard.mjs';
import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'work orders';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZWOA',
  slugPrefix: 'zz-woa-',
  emailDomain: 'woa.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (B)`,
  prefix: 'ZZWOB',
  slugPrefix: 'zz-wob-',
  emailDomain: 'wob.invalid',
  prisma,
});

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;
const iso = (date) => date.toISOString().slice(0, 10);

async function body() {
  console.log('\n════ work orders (MA-01) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
  if (serverDb !== 'easeit_test' && !WHOLLY_DISPOSABLE.includes(serverDb)) {
    throw new Error(
      `REFUSING TO RUN: the server reports current_database() = "${String(serverDb)}". Nothing was created.`,
    );
  }
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const A = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', housekeeper: 'HOUSEKEEPING' },
    rooms: [
      { label: 'R1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'R2', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'R3', category: 'A', status: 'VACANT_CLEAN' },
    ],
  });
  const B = await other.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN' },
    rooms: [{ label: 'X1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);

  const admin = A.users.admin.cookie;
  const clerk = A.users.clerk.cookie;
  const hk = A.users.housekeeper.cookie;
  const base = `/properties/${A.propertyCode}`;
  const D = A.today;
  const nights = Array.from({ length: 12 }, (_, i) => shiftDays(D, i - 3));
  await prisma.inventoryDay.createMany({
    data: nights.map((night) => ({
      propertyId: A.propertyId,
      roomTypeId: A.categoryA,
      stayDate: utcMidnight(night),
      physical: 3,
    })),
  });

  const blockedByDate = async () => {
    const rows = await prisma.inventoryDay.findMany({
      where: { propertyId: A.propertyId, roomTypeId: A.categoryA },
      select: { stayDate: true, blocked: true },
    });
    return new Map(rows.map((row) => [iso(row.stayDate), row.blocked]));
  };
  /** Per-date difference from a baseline, for the dates that moved. */
  const moved = (before, after) => {
    const out = {};
    for (const [date, value] of after)
      if (value !== before.get(date)) out[date] = value - (before.get(date) ?? 0);
    return out;
  };
  const report = (cookie, room, extra = {}) =>
    h.call('POST', `${base}/work-orders`, cookie, {
      roomId: room.id,
      title: `Fault in ${room.number}`,
      priority: 'HIGH',
      ...extra,
    });
  const action = (cookie, id, verb, payload = {}) =>
    h.call('POST', `${base}/work-orders/${id}/${verb}`, cookie, payload);
  const R = A.rooms;

  /* -------------------------------------------------------------- 1 */
  console.log('1. Who may report, and who may take a room out of order.');
  const plain = await report(hk, R.R1);
  h.check(
    'housekeeping reports a fault (no out of order)',
    ok(plain) && plain.payload.status === 'OPEN' && plain.payload.outOfOrder === null,
    show(plain),
  );
  const hkBlock = await report(hk, R.R1, { outOfOrder: { fromDate: D, throughDate: D } });
  h.check(
    'housekeeping cannot take the room out of order: 403',
    hkBlock.status === 403,
    show(hkBlock),
  );
  const clerkBlock = await report(clerk, R.R1, { outOfOrder: { fromDate: D, throughDate: D } });
  h.check('front desk cannot either: 403', clerkBlock.status === 403, show(clerkBlock));

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Out of order raises blocked on exactly the chosen nights.');
  let before = await blockedByDate();
  const ooo = await report(admin, R.R2, {
    outOfOrder: { fromDate: D, throughDate: shiftDays(D, 2) },
  });
  h.check(
    'an administrator reports a fault and takes the room out of order',
    ok(ooo) && ooo.payload.outOfOrder?.active === true,
    show(ooo),
  );
  const delta = moved(before, await blockedByDate());
  h.check(
    'blocked +1 on D, D+1, D+2 and nowhere else',
    JSON.stringify(delta) ===
      JSON.stringify({ [D]: 1, [shiftDays(D, 1)]: 1, [shiftDays(D, 2)]: 1 }),
    JSON.stringify(delta),
  );
  const block = await prisma.roomBlock.findFirst({
    where: { id: ooo.payload.outOfOrder.blockId },
    select: { roomId: true, reason: true, status: true },
  });
  h.check(
    'through a MAINTENANCE block on that room',
    block?.roomId === R.R2.id && block?.reason === 'MAINTENANCE' && block?.status === 'ACTIVE',
    JSON.stringify(block),
  );

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. A room holding a stay is refused, with nothing written.');
  const stay = await h.call('POST', `${base}/reservations`, admin, {
    roomTypeId: A.categoryA,
    roomId: R.R3.id,
    arrivalDate: D,
    departureDate: shiftDays(D, 2),
    adults: 1,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [
      { firstName: 'Work', lastName: 'Order', govtIdType: 'PASSPORT', govtIdNumber: 'P1234567' },
    ],
    isInstantCheckIn: false,
  });
  if (stay.status !== 201) throw new Error(`booking failed: ${show(stay)}`);
  before = await blockedByDate();
  const countBefore = await prisma.workOrder.count({ where: { propertyId: A.propertyId } });
  const occupied = await report(admin, R.R3, {
    outOfOrder: { fromDate: shiftDays(D, 1), throughDate: shiftDays(D, 1) },
  });
  h.check(
    '409 naming the stay',
    occupied.status === 409 && JSON.stringify(occupied.payload).includes(stay.payload.bookingCode),
    show(occupied),
  );
  h.check(
    'no work order and no counter change',
    (await prisma.workOrder.count({ where: { propertyId: A.propertyId } })) === countBefore &&
      Object.keys(moved(before, await blockedByDate())).length === 0,
  );

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Resolving gives the room back; 8 concurrent resolves move the counter once.');
  before = await blockedByDate();
  const resolves = await Promise.all(
    Array.from({ length: 8 }, () => action(admin, ooo.payload.id, 'resolve', { note: 'Fixed' })),
  );
  h.check(
    'all 8 answer 200 (one resolves, the rest are idempotent)',
    resolves.every((res) => res.status === 200),
    resolves.map((r) => r.status).join(','),
  );
  const back = moved(before, await blockedByDate());
  h.check(
    'blocked −1 on D, D+1, D+2, exactly once',
    JSON.stringify(back) ===
      JSON.stringify({ [D]: -1, [shiftDays(D, 1)]: -1, [shiftDays(D, 2)]: -1 }),
    JSON.stringify(back),
  );
  const resolved = resolves[0].payload;
  h.check(
    'the order is RESOLVED with its note, and the block released',
    resolved.status === 'RESOLVED' &&
      resolved.resolutionNote === 'Fixed' &&
      resolved.outOfOrder?.active === false,
    JSON.stringify(resolved),
  );
  const cancelResolved = await action(admin, ooo.payload.id, 'cancel', {});
  h.check(
    'a resolved order cannot be cancelled: 409',
    cancelResolved.status === 409,
    show(cancelResolved),
  );

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. A block that began before the business date keeps its past nights.');
  before = await blockedByDate();
  const past = await report(admin, R.R1, {
    outOfOrder: { fromDate: shiftDays(D, -2), throughDate: shiftDays(D, 1) },
  });
  h.check('out of order from D-2 through D+1', ok(past), show(past));
  const afterResolve = await action(admin, past.payload.id, 'resolve', { note: null });
  const net = moved(before, await blockedByDate());
  h.check(
    'after resolving on D: D-2 and D-1 stay blocked, D and D+1 are given back',
    JSON.stringify(net) === JSON.stringify({ [shiftDays(D, -2)]: 1, [shiftDays(D, -1)]: 1 }),
    JSON.stringify(net),
  );
  const shortened = await prisma.roomBlock.findFirst({
    where: { id: past.payload.outOfOrder.blockId },
    select: { status: true, throughDate: true },
  });
  h.check(
    'the block is shortened to end on D (exclusive), not released',
    ok(afterResolve) &&
      shortened?.status === 'ACTIVE' &&
      iso(shortened.throughDate) === D &&
      afterResolve.payload.outOfOrder?.throughDate === shiftDays(D, -1),
    JSON.stringify(shortened),
  );

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Lifecycle, assignment and taking out of order later.');
  const assignForeign = await action(admin, plain.payload.id, 'assign', {
    assignedToId: B.users.admin.id,
  });
  h.check(
    'cannot assign someone with no grant here: 400',
    assignForeign.status === 400,
    show(assignForeign),
  );
  const assigned = await action(admin, plain.payload.id, 'assign', {
    assignedToId: A.users.housekeeper.id,
  });
  h.check(
    'assigned to the housekeeper',
    ok(assigned) && assigned.payload.assignedTo?.id === A.users.housekeeper.id,
    show(assigned),
  );
  const hkStart = await action(hk, plain.payload.id, 'start');
  h.check('the housekeeper cannot manage orders: 403', hkStart.status === 403, show(hkStart));
  const started = await action(admin, plain.payload.id, 'start');
  const startedAgain = await action(admin, plain.payload.id, 'start');
  h.check(
    'started, and starting again is idempotent',
    started.payload?.status === 'IN_PROGRESS' && startedAgain.status === 200,
    show(startedAgain),
  );
  before = await blockedByDate();
  const later = await action(admin, plain.payload.id, 'out-of-order', {
    fromDate: shiftDays(D, 4),
    throughDate: shiftDays(D, 5),
  });
  h.check(
    'an existing order takes its room out of order later',
    ok(later) &&
      later.payload.outOfOrder?.active === true &&
      JSON.stringify(moved(before, await blockedByDate())) ===
        JSON.stringify({ [shiftDays(D, 4)]: 1, [shiftDays(D, 5)]: 1 }),
    show(later),
  );
  const cancelled = await action(admin, plain.payload.id, 'cancel', { note: 'Duplicate report' });
  h.check(
    'cancelling gives those nights back',
    cancelled.payload?.status === 'CANCELLED' &&
      Object.keys(moved(before, await blockedByDate())).length === 0,
    show(cancelled),
  );

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. 8 concurrent out-of-order reports on one room and range: exactly one.');
  before = await blockedByDate();
  const race = await Promise.all(
    Array.from({ length: 8 }, () =>
      report(admin, R.R2, {
        outOfOrder: { fromDate: shiftDays(D, 6), throughDate: shiftDays(D, 7) },
      }),
    ),
  );
  h.check(
    'exactly one succeeds',
    race.filter(ok).length === 1,
    race.map((r) => r.status).join(','),
  );
  h.check(
    'the losers are 409s, never 500',
    race.filter((r) => !ok(r)).every((r) => r.status === 409),
    race.map((r) => r.status).join(','),
  );
  h.check(
    'blocked +1 exactly, per date',
    JSON.stringify(moved(before, await blockedByDate())) ===
      JSON.stringify({ [shiftDays(D, 6)]: 1, [shiftDays(D, 7)]: 1 }),
  );

  /* -------------------------------------------------------------- 8 */
  console.log('\n8. Tenancy, audit and the database backstop.');
  const foreignList = await h.call('GET', `${base}/work-orders`, B.users.admin.cookie);
  h.check(
    'another property cannot list these orders: 404',
    foreignList.status === 404,
    show(foreignList),
  );
  const foreignResolve = await h.call(
    'POST',
    `/properties/${B.propertyCode}/work-orders/${race.find(ok).payload.id}/resolve`,
    B.users.admin.cookie,
    {},
  );
  h.check(
    'nor resolve one through its own property: 404',
    foreignResolve.status === 404,
    show(foreignResolve),
  );
  const audits = await prisma.auditLog.count({
    where: { propertyId: A.propertyId, entityType: 'work_order' },
  });
  h.check('every change is audited', audits >= 10, String(audits));
  let refused = '';
  try {
    await prisma.$executeRaw`
      INSERT INTO "work_order" ("id","propertyId","roomId","title","reportedById","updatedAt")
      VALUES (${randomUUID()}::uuid, ${A.propertyId}::uuid, ${B.rooms.X1.id}::uuid, 'cross', ${A.users.admin.id}::uuid, now())`;
  } catch (error) {
    refused = String(error?.message ?? error);
  }
  h.check(
    'the database refuses an order on another property’s room',
    refused.includes('room is not of this property'),
    refused.slice(0, 120),
  );
}

await runSuite({
  harness: h,
  prisma,
  label: SUITE,
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
