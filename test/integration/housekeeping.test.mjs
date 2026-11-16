/**
 * Housekeeping (HK-01 .. HK-05).
 *
 * ===========================================================================
 * Acceptance:
 *   HK-02  the board shows live status per room and updates it
 *   HK-03  tasks assignable to staff, with completion tracking
 *   HK-04  inspection pass/fail gates a room back to sellable
 *   HK-05  the housekeeping role cannot read or write folios
 * plus: one active task per room and type (a race of two creators makes one),
 * room status changed only through the conditional audited write, and
 * another property's tasks and rooms are not found, never forbidden.
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import { createHarness, requireEnvironment, runSuite, shiftDays, utcMidnight } from '../support/room-fixture.mjs';

const SUITE = 'housekeeping';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({ suiteName: SUITE, prefix: 'ZZHKP', slugPrefix: 'zz-hkp-', emailDomain: 'hkp.invalid', prisma });
const other = createHarness({ suiteName: `${SUITE} (B)`, prefix: 'ZZHKB', slugPrefix: 'zz-hkb-', emailDomain: 'hkb.invalid', prisma });

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) => `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;

async function body() {
  console.log('\n════ housekeeping (HK-01 .. HK-05) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const A = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', hk: 'HOUSEKEEPING', hk2: 'HOUSEKEEPING', clerk: 'FRONT_DESK' },
    rooms: [
      { label: 'R1', category: 'A', status: 'VACANT_DIRTY' },
      { label: 'R2', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'R3', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'R4', category: 'A', status: 'VACANT_CLEAN' },
    ],
  });
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [{ label: 'X1', category: 'A', status: 'VACANT_DIRTY' }] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 4 }, (_, i) => ({ propertyId: A.propertyId, roomTypeId: A.categoryA, stayDate: utcMidnight(shiftDays(A.today, i)), physical: 4 })),
  });

  const base = `/properties/${A.propertyCode}/housekeeping`;
  const admin = A.users.admin.cookie;
  const hk = A.users.hk.cookie;
  const hk2 = A.users.hk2.cookie;
  const clerk = A.users.clerk.cookie;
  const status = async (room) => (await prisma.room.findFirst({ where: { id: room.id }, select: { status: true } })).status;
  const create = (cookie, roomId, type, extra = {}) => h.call('POST', `${base}/tasks`, cookie, { roomId, type, ...extra });
  const act = (cookie, taskId, verb, payload = {}) => h.call('POST', `${base}/tasks/${taskId}/${verb}`, cookie, payload);
  const audits = (event) => prisma.auditLog.count({ where: { propertyId: A.propertyId, event } });

  // A guest in R3 (checked in) and one due into R4 today.
  const book = async (roomId, last) => {
    const res = await h.call('POST', `/properties/${A.propertyCode}/reservations`, clerk, {
      roomTypeId: A.categoryA, roomId, arrivalDate: A.today, departureDate: shiftDays(A.today, 1), adults: 1, mealPlan: 'EP',
      source: 'WALK_IN', guests: [{ firstName: 'Room', lastName: last, govtIdType: 'PASSPORT', govtIdNumber: 'P1234567' }], isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking failed: ${show(res)}`);
    return res.payload;
  };
  const inHouse = await book(A.rooms.R3.id, 'InHouse');
  const ci = await h.call('POST', `/properties/${A.propertyCode}/reservations/${inHouse.id}/check-in`, clerk, {
    roomId: A.rooms.R3.id, primaryGuestIdType: 'PASSPORT', primaryGuestIdNumber: 'P1234567', acknowledgeRoomNotClean: true,
  });
  h.check('setup: a guest checks in to R3', ok(ci), show(ci));
  await book(A.rooms.R4.id, 'Arriving');

  /* ------------------------------------------------------------------ 1 */
  console.log('1. The board (HK-02).');
  const denied = await h.call('GET', `${base}/board`, B.users.admin.cookie);
  h.check("another property's admin naming this hotel: 404", denied.status === 404, show(denied));
  const board = await h.call('GET', `${base}/board`, hk);
  h.check('housekeeping reads the board', board.status === 200 && board.payload?.rooms?.length === 4, show(board));
  const row = (id) => board.payload.rooms.find((r) => r.roomId === id);
  h.check('status per room, live', row(A.rooms.R1.id)?.status === 'VACANT_DIRTY' && row(A.rooms.R3.id)?.status.startsWith('OCCUPIED'));
  h.check('occupancy, and not departing today (it leaves tomorrow)', row(A.rooms.R3.id)?.occupied === true && row(A.rooms.R3.id)?.departingToday === false && row(A.rooms.R1.id)?.occupied === false);
  h.check('arrivals today', row(A.rooms.R4.id)?.arrivingToday === true && row(A.rooms.R2.id)?.arrivingToday === false);
  // The next business date (suite-owned property): the in-house stay now leaves today.
  await prisma.property.update({ where: { id: A.propertyId }, data: { businessDate: utcMidnight(shiftDays(A.today, 1)) } });
  const tomorrow = await h.call('GET', `${base}/board`, hk);
  const later = tomorrow.payload.rooms.find((r) => r.roomId === A.rooms.R3.id);
  h.check('on its last day the in-house room shows as departing', later?.occupied === true && later?.departingToday === true, JSON.stringify(later));
  await prisma.property.update({ where: { id: A.propertyId }, data: { businessDate: utcMidnight(A.today) } });
  h.check('no guest names or money on the board (HK-05)', !/Arriving|InHouse|amount|Minor/.test(JSON.stringify(board.payload.rooms)));
  const names = board.payload.assignable.map((p) => p.id);
  h.check('assignable people: the housekeepers (and the admin), not front desk', names.includes(A.users.hk.id) && names.includes(A.users.hk2.id) && !names.includes(A.users.clerk.id), JSON.stringify(board.payload.assignable));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Tasks (HK-03).');
  const byHk = await create(hk, A.rooms.R1.id, 'CLEAN');
  h.check('a housekeeper cannot create tasks (needs housekeeping:manage): 403', byHk.status === 403, show(byHk));
  const toClerk = await create(admin, A.rooms.R1.id, 'CLEAN', { assignedToId: A.users.clerk.id });
  h.check('assigning to someone who cannot do housekeeping work: 400', toClerk.status === 400, show(toClerk));
  const race = await Promise.all([create(admin, A.rooms.R1.id, 'CLEAN', { assignedToId: A.users.hk.id }), create(admin, A.rooms.R1.id, 'CLEAN', { assignedToId: A.users.hk.id })]);
  h.check('two supervisors queue the same cleaning at once: exactly one task', race.filter(ok).length === 1 && race.filter((r) => r.status === 400).length === 1, race.map((r) => r.status).join(','));
  const clean = race.find(ok).payload;
  h.check('assigned to the housekeeper, OPEN, on the business date', clean.assignedTo?.id === A.users.hk.id && clean.status === 'OPEN' && clean.businessDate === A.today);
  const notMine = await act(hk2, clean.id, 'start');
  h.check("another housekeeper cannot start someone else's task: 403", notMine.status === 403, show(notMine));
  const started = await act(hk, clean.id, 'start');
  h.check('the assignee starts it', started.status === 200 && started.payload?.status === 'IN_PROGRESS' && started.payload?.startedAt !== null, show(started));
  const done = await act(hk, clean.id, 'complete', { notes: 'Linen changed' });
  h.check('and completes it: DONE, with who and when', done.status === 200 && done.payload?.status === 'DONE' && done.payload?.completedBy?.id === A.users.hk.id && done.payload?.completedAt !== null, show(done));
  h.check('the finished cleaning made the dirty room clean', (await status(A.rooms.R1)) === 'VACANT_CLEAN');
  h.check('audited: task completed and room status changed', (await audits('HOUSEKEEPING_TASK_COMPLETED')) === 1 && (await audits('ROOM_STATUS_CHANGED')) >= 1);
  const twice = await act(hk, clean.id, 'complete', {});
  h.check('completing it again: 400, nothing changes', twice.status === 400, show(twice));

  // Occupied dirty -> occupied clean through a task; an unassigned task is claimed.
  await prisma.room.update({ where: { id: A.rooms.R3.id }, data: { status: 'OCCUPIED_DIRTY' } });
  const service = await create(admin, A.rooms.R3.id, 'CLEAN');
  const claimed = await act(hk2, service.payload.id, 'start');
  h.check('an unassigned task is claimed by whoever starts it', claimed.payload?.assignedTo?.id === A.users.hk2.id, show(claimed));
  await act(hk2, service.payload.id, 'complete', {});
  h.check('occupied-dirty becomes occupied-clean; the guest stays', (await status(A.rooms.R3)) === 'OCCUPIED_CLEAN');

  const turndown = await create(admin, A.rooms.R3.id, 'TURNDOWN', { assignedToId: A.users.hk.id });
  const reassigned = await act(admin, turndown.payload.id, 'assign', { assignedToId: A.users.hk2.id });
  h.check('a supervisor reassigns', reassigned.payload?.assignedTo?.id === A.users.hk2.id, show(reassigned));
  const cancelled = await act(admin, turndown.payload.id, 'cancel');
  h.check('and cancels', cancelled.payload?.status === 'CANCELLED', show(cancelled));
  const again = await create(admin, A.rooms.R3.id, 'TURNDOWN');
  h.check('a cancelled task frees the slot for a new one', ok(again), show(again));

  await prisma.room.update({ where: { id: A.rooms.R2.id }, data: { status: 'VACANT_DIRTY' } });
  const queued = await h.call('POST', `${base}/tasks/queue-cleaning`, admin, {});
  h.check('queue cleaning: one task per dirty room without one', queued.status === 200 && queued.payload?.created === 1, show(queued));
  const queuedAgain = await h.call('POST', `${base}/tasks/queue-cleaning`, admin, {});
  h.check('queueing again creates nothing', queuedAgain.payload?.created === 0, show(queuedAgain));
  const mine = await h.call('GET', `${base}/tasks?mine=true`, hk2);
  h.check("'my tasks' lists only the caller's", mine.status === 200 && mine.payload.every((t) => t.assignedTo?.id === A.users.hk2.id), show(mine));

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Inspection gates a room back (HK-04).');
  const inspectDirty = await create(admin, A.rooms.R2.id, 'INSPECTION');
  const tooEarly = await act(admin, inspectDirty.payload.id, 'inspect', { result: 'PASSED' });
  h.check('a dirty room cannot pass inspection: 400', tooEarly.status === 400 && (await status(A.rooms.R2)) === 'VACANT_DIRTY', show(tooEarly));
  const r2clean = (await h.call('GET', `${base}/tasks`, admin)).payload.find((t) => t.roomId === A.rooms.R2.id && t.type === 'CLEAN');
  await act(hk, r2clean.id, 'start');
  await act(hk, r2clean.id, 'complete', {});
  const byHkInspect = await act(hk, inspectDirty.payload.id, 'inspect', { result: 'PASSED' });
  h.check('a housekeeper cannot record an inspection: 403', byHkInspect.status === 403, show(byHkInspect));
  const passed = await act(admin, inspectDirty.payload.id, 'inspect', { result: 'PASSED', notes: 'Ready' });
  h.check('PASSED: the clean room becomes INSPECTED', passed.payload?.inspectionResult === 'PASSED' && (await status(A.rooms.R2)) === 'INSPECTED', show(passed));
  const second = await create(admin, A.rooms.R2.id, 'INSPECTION');
  const completeInspection = await act(admin, second.payload.id, 'complete', {});
  h.check(
    'an open inspection cannot be "completed", only recorded with a result: 400',
    completeInspection.status === 400 && /recorded with a result/.test(JSON.stringify(completeInspection.payload?.details ?? {})),
    show(completeInspection),
  );
  const failed = await act(admin, second.payload.id, 'inspect', { result: 'FAILED', notes: 'Hair in the shower' });
  h.check('FAILED: the room goes back to VACANT_DIRTY', failed.payload?.inspectionResult === 'FAILED' && (await status(A.rooms.R2)) === 'VACANT_DIRTY', show(failed));
  const reclean = await prisma.housekeepingTask.findFirst({ where: { roomId: A.rooms.R2.id, type: 'CLEAN', status: 'OPEN' }, select: { notes: true } });
  h.check('and a re-clean task is queued', reclean !== null && /Hair in the shower/.test(reclean.notes ?? ''), JSON.stringify(reclean));
  const direct = await h.call('POST', `/properties/${A.propertyCode}/rooms/${A.rooms.R2.id}/status`, hk, { status: 'INSPECTED' });
  h.check('a housekeeper cannot shortcut it by setting INSPECTED directly: 403', direct.status === 403 && (await status(A.rooms.R2)) === 'VACANT_DIRTY', show(direct));

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. Housekeeping is blind to financials (HK-05); tenancy.');
  const folio = await h.call('GET', `/properties/${A.propertyCode}/folios/by-booking/${inHouse.bookingCode}`, hk);
  h.check('the housekeeping role cannot read a folio: 403', folio.status === 403, show(folio));
  const pay = await h.call('POST', `/properties/${A.propertyCode}/folios/by-booking/${inHouse.bookingCode}/payment`, hk, { method: 'CASH', amountMinor: 100, remark: null, idempotencyKey: randomUUID() });
  h.check('nor post to one: 403', pay.status === 403, show(pay));
  const report = await h.call('GET', `/properties/${A.propertyCode}/reports/master-report?startDate=${A.today}&endDate=${A.today}&dateDimension=CHECKOUT&limit=10`, hk);
  h.check('nor read the financial report: 403', report.status === 403, show(report));
  const theirs = await create(B.users.admin.cookie, B.rooms.X1.id, 'CLEAN');
  const crossAct = await act(admin, theirs.payload.id, 'cancel');
  h.check("another property's task: 404, not 403", crossAct.status === 404, show(crossAct));
  const crossRoom = await create(admin, B.rooms.X1.id, 'CLEAN');
  h.check("a task on another property's room: 404", crossRoom.status === 404, show(crossRoom));
}

await runSuite({
  harness: h,
  prisma,
  label: 'housekeeping integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
