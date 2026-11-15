/**
 * Night audit (CLAUDE.md section 3.3; NA-01 .. NA-06).
 *
 * ===========================================================================
 * The request side runs through the real API: enqueue, idempotency,
 * permissions, tenancy -- and that a request never executes a run.
 *
 * The execution side is the compiled `NightAuditRunner`, constructed here the
 * way the outbox suites construct their services, so it runs against the test
 * database with no Redis. That is the same code the worker's NIGHT_AUDIT_RUN
 * handler calls.
 *
 * Asserted, mandatory per CLAUDE.md section 5 ("night-audit idempotency and
 * resume tests"): steps 1-8 in order, each recorded; no-shows released per
 * date and per category against live room rows; tonight's charge posted once,
 * never twice; zero-balance folios closed and the rest flagged; one immutable
 * snapshot whose figures match the counters and the ledger; the business date
 * advanced exactly once; re-running a completed run is a no-op; two executors
 * racing one run produce one result; a blocked run fails, records why, and
 * resumes from the failed step once fixed; the schedule is per timezone and
 * one property's failure does not stop another's.
 * ===========================================================================
 */

await import(new URL('../../apps/api/node_modules/reflect-metadata/Reflect.js', import.meta.url));
import { randomUUID } from 'node:crypto';

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'night audit';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const DIST = '../../apps/api/dist/modules';
async function load(relative) {
  const loaded = await import(new URL(`${DIST}/${relative}`, import.meta.url));
  return Object.keys(loaded).some((key) => key !== 'default') ? loaded : (loaded.default ?? loaded);
}
const { NightAuditRunner } = await load('nightaudit/night-audit.runner.js');
const { NightAuditScheduler } = await load('nightaudit/night-audit.scheduler.js');
const { NightAuditService } = await load('nightaudit/night-audit.service.js');
const { auditDue } = await load('nightaudit/night-audit.schedule.js');
const { CancelReservationService } = await load('reservations/cancel-reservation.service.js');
const { OutboxService } = await load('platform/outbox/outbox.service.js');
const { ClockService } = await load('platform/clock.service.js');

const prismaStub = { client: prisma, ping: async () => true };
const clock = new ClockService();
const outbox = new OutboxService(prismaStub);
const runner = new NightAuditRunner(prismaStub, clock, new CancelReservationService(prismaStub), outbox);
const configStub = (values) => ({ get: (key, fallback) => (key in values ? values[key] : fallback) });

const h = createHarness({ suiteName: SUITE, prefix: 'ZZNAU', slugPrefix: 'zz-nau-', emailDomain: 'nau.invalid', prisma });
const other = createHarness({ suiteName: `${SUITE} (second property)`, prefix: 'ZZNAX', slugPrefix: 'zz-nax-', emailDomain: 'nax.invalid', prisma });

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) => `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;
const CONSUMING = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'];
const isoOf = (date) => date.toISOString().slice(0, 10);

async function body() {
  console.log('\n════ night audit (NA-01 .. NA-06) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const fx = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', auditor: 'NIGHT_AUDITOR' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'VACANT_CLEAN' },
    ],
  });
  await h.assertApiSharesDatabase(fx, fx.users.admin.cookie, liveDb);
  const fy = await other.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN' },
    rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }],
  });

  const D = fx.today;
  for (const f of [fx, fy]) {
    await prisma.inventoryDay.createMany({
      data: Array.from({ length: 20 }, (_, i) => shiftDays(D, i - 2)).map((night) => ({
        propertyId: f.propertyId,
        roomTypeId: f.categoryA,
        stayDate: utcMidnight(night),
        physical: 6,
      })),
    });
  }

  const base = (f) => `/properties/${f.propertyCode}`;
  const book = async (f, cookie, { arrival, nights, roomId = null, last }) => {
    const res = await h.call('POST', `${base(f)}/reservations`, cookie, {
      roomTypeId: f.categoryA,
      roomId,
      arrivalDate: arrival,
      departureDate: shiftDays(arrival, nights),
      adults: 1,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Audit', lastName: last, govtIdType: 'PASSPORT', govtIdNumber: 'P1234567' }],
      isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking failed: ${show(res)}`);
    return res.payload;
  };
  const checkIn = (f, cookie, stay, roomId) =>
    h.call('POST', `${base(f)}/reservations/${stay.id}/check-in`, cookie, {
      roomId,
      primaryGuestIdType: 'PASSPORT',
      primaryGuestIdNumber: 'P1234567',
      acknowledgeRoomNotClean: true,
    });
  const pay = (f, cookie, stay, amountMinor) =>
    h.call('POST', `${base(f)}/folios/by-booking/${stay.bookingCode}/payment`, cookie, {
      method: 'CASH',
      amountMinor,
      remark: null,
      idempotencyKey: randomUUID(),
    });
  const status = async (stay) => (await prisma.reservation.findFirst({ where: { id: stay.id }, select: { status: true } })).status;
  const businessDate = async (f) => isoOf((await prisma.property.findFirst({ where: { id: f.propertyId }, select: { businessDate: true } })).businessDate);
  const steps = (runId) => prisma.nightAuditStep.findMany({ where: { runId }, orderBy: { step: 'asc' } });
  const roomCharges = (stay, date) =>
    prisma.folioLine.findMany({
      where: { folio: { reservationId: stay.id }, kind: 'ROOM_CHARGE', chargeDate: utcMidnight(date) },
      select: { id: true, amountMinor: true },
    });
  async function assertCounters(label, f, dates) {
    const days = await prisma.inventoryDay.findMany({
      where: { propertyId: f.propertyId, stayDate: { in: dates.map(utcMidnight) } },
      select: { roomTypeId: true, stayDate: true, sold: true },
    });
    const rooms = await prisma.reservationRoom.findMany({
      where: { propertyId: f.propertyId, status: { in: CONSUMING } },
      select: { roomTypeId: true, arrivalDate: true, departureDate: true },
    });
    const bad = days
      .map((d) => ({ d, held: rooms.filter((r) => r.roomTypeId === d.roomTypeId && r.arrivalDate <= d.stayDate && r.departureDate > d.stayDate).length }))
      .filter(({ d, held }) => d.sold !== held)
      .map(({ d, held }) => `${isoOf(d.stayDate)} sold ${String(d.sold)} held ${String(held)}`);
    h.check(`${label}: sold equals live room rows, per date and per category`, bad.length === 0, bad.join('; '));
  }
  const windowDates = Array.from({ length: 8 }, (_, i) => shiftDays(D, i - 1));

  /* ------------------------------------------------------------------ setup */
  const clerk = fx.users.clerk.cookie;
  const neverArrives = await book(fx, clerk, { arrival: D, nights: 2, last: 'NoShow' });
  const inHouse = await book(fx, clerk, { arrival: D, nights: 3, roomId: fx.rooms.A1.id, last: 'InHouse' });
  h.check('setup: the in-house stay checks in (posting tonight)', ok(await checkIn(fx, clerk, inHouse, fx.rooms.A1.id)));
  const tomorrow = await book(fx, clerk, { arrival: shiftDays(D, 1), nights: 1, last: 'Tomorrow' });
  const settled = await book(fx, clerk, { arrival: shiftDays(D, 2), nights: 1, last: 'Settled' });
  const sp = await pay(fx, clerk, settled, 100000);
  const spLine = await prisma.folioLine.findFirst({ where: { folioId: sp.payload.folioId, kind: 'PAYMENT' }, select: { id: true } });
  await h.call('POST', `${base(fx)}/folios/${sp.payload.folioId}/payments/${spLine.id}/refund`, fx.users.admin.cookie, { amountMinor: 100000, reason: 'Returned', idempotencyKey: randomUUID() });
  await h.call('POST', `${base(fx)}/reservations/${settled.id}/cancel`, clerk, { reason: 'Suite' });
  const credit = await book(fx, clerk, { arrival: shiftDays(D, 3), nights: 1, last: 'Credit' });
  const cp = await pay(fx, clerk, credit, 50000);
  await h.call('POST', `${base(fx)}/reservations/${credit.id}/cancel`, clerk, { reason: 'Suite' });
  await assertCounters('before the audit', fx, windowDates);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n1. A request enqueues; it never runs the audit.');
  const auditor = fx.users.auditor.cookie;
  const denied = await h.call('POST', `${base(fx)}/night-audit/runs`, clerk, {});
  h.check('front desk (no night_audit:execute): 403', denied.status === 403, show(denied));
  const started = await h.call('POST', `${base(fx)}/night-audit/runs`, auditor, {});
  h.check('the night auditor enqueues: CREATED, PENDING', ok(started) && started.payload?.outcome === 'CREATED' && started.payload?.run?.status === 'PENDING', show(started));
  const run1 = started.payload.run;
  h.check('it closes the current business date', run1.businessDate === D, run1.businessDate);
  h.check('no step has run', run1.steps.length === 8 && run1.steps.every((s) => s.status === 'NOT_STARTED'));
  h.check('nothing changed: business date and the unarrived stay', (await businessDate(fx)) === D && (await status(neverArrives)) === 'CONFIRMED');
  const events = await prisma.outboxEvent.findMany({ where: { propertyId: fx.propertyId, eventType: 'NIGHT_AUDIT_RUN' }, select: { payload: true, status: true } });
  h.check('one NIGHT_AUDIT_RUN outbox event names the run', events.length === 1 && events[0].payload?.runId === run1.id, JSON.stringify(events));
  const again = await h.call('POST', `${base(fx)}/night-audit/runs`, auditor, {});
  h.check('asking again returns the same run (EXISTING), no second event', again.payload?.outcome === 'EXISTING' && again.payload?.run?.id === run1.id && (await prisma.outboxEvent.count({ where: { propertyId: fx.propertyId, eventType: 'NIGHT_AUDIT_RUN' } })) === 1, show(again));
  const crossStart = await h.call('POST', `${base(fx)}/night-audit/runs`, fy.users.admin.cookie, {});
  h.check("another property's admin naming this hotel: 404, not 403", crossStart.status === 404, show(crossStart));
  const crossRead = await h.call('GET', `${base(fy)}/night-audit/runs/${run1.id}`, fy.users.admin.cookie);
  h.check('reading this run through another property: 404', crossRead.status === 404, show(crossRead));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. The run executes all eight steps, in order.');
  h.check('execute → COMPLETED', (await runner.execute(run1.id)) === 'COMPLETED');
  const s1 = await steps(run1.id);
  h.check('eight step rows, 1..8, all COMPLETED', s1.length === 8 && s1.every((s, i) => s.step === i + 1 && s.status === 'COMPLETED'), s1.map((s) => `${String(s.step)}:${s.status}`).join(' '));
  h.check('finished in order', s1.every((s, i) => i === 0 || s.finishedAt >= s1[i - 1].finishedAt));
  h.check('step 2: the unarrived stay is a NO_SHOW', (await status(neverArrives)) === 'NO_SHOW' && s1[1].outcome.rolled === 1, JSON.stringify(s1[1].outcome));
  h.check('a stay due tomorrow is untouched', (await status(tomorrow)) === 'CONFIRMED');
  await assertCounters('after the no-show roll', fx, windowDates);
  const tonight = await roomCharges(inHouse, D);
  h.check('step 3: tonight was already posted by check-in, and is not posted again', tonight.length === 1 && s1[2].outcome.posted === 0 && s1[2].outcome.alreadyPosted === 1, JSON.stringify(s1[2].outcome));
  const settledFolio = await prisma.folio.findFirst({ where: { reservationId: settled.id }, select: { status: true } });
  const creditFolio = await prisma.folio.findFirst({ where: { reservationId: credit.id }, select: { status: true } });
  h.check('step 5: the settled cancelled folio is CLOSED', settledFolio.status === 'CLOSED');
  h.check(
    'step 5: the cancelled folio in credit stays OPEN and is flagged',
    creditFolio.status === 'OPEN' && s1[4].outcome.exceptions.some((e) => e.bookingCode === credit.bookingCode && e.balanceMinor === -50000),
    JSON.stringify(s1[4].outcome),
  );
  const snap = await prisma.dailySnapshot.findMany({ where: { propertyId: fx.propertyId } });
  const soldD = (await prisma.inventoryDay.aggregate({ where: { propertyId: fx.propertyId, stayDate: utcMidnight(D) }, _sum: { sold: true, physical: true } }))._sum;
  const revenueD = (await prisma.folioLine.aggregate({ where: { propertyId: fx.propertyId, kind: 'ROOM_CHARGE', chargeDate: utcMidnight(D) }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
  h.check('step 6: one snapshot for the day', snap.length === 1 && isoOf(snap[0].businessDate) === D);
  h.check('its rooms sold and available match the counters', snap[0].roomsSold === soldD.sold && snap[0].roomsAvailable === soldD.physical, `${String(snap[0].roomsSold)}/${String(snap[0].roomsAvailable)} vs ${String(soldD.sold)}/${String(soldD.physical)}`);
  h.check('its room revenue matches the ledger, ADR and RevPAR derive from it', snap[0].roomRevenueMinor === revenueD && snap[0].adrMinor === Math.round(revenueD / soldD.sold) && snap[0].revparMinor === Math.round(revenueD / soldD.physical), `${String(snap[0].roomRevenueMinor)} vs ${String(revenueD)}`);
  h.check('step 7: the business date advanced one day', (await businessDate(fx)) === shiftDays(D, 1));
  h.check('step 8: one NIGHT_AUDIT_COMPLETED event', (await prisma.outboxEvent.count({ where: { propertyId: fx.propertyId, eventType: 'NIGHT_AUDIT_COMPLETED' } })) === 1);
  const advancedAudit = await prisma.auditLog.findMany({ where: { propertyId: fx.propertyId, event: 'BUSINESS_DATE_ADVANCED' }, select: { actorUserId: true } });
  h.check('the advance is audited once, by the system (no actor)', advancedAudit.length === 1 && advancedAudit[0].actorUserId === null);
  const viewed = await h.call('GET', `${base(fx)}/night-audit/runs/${run1.id}`, auditor);
  h.check('the API shows it COMPLETED with eight completed steps', viewed.payload?.status === 'COMPLETED' && viewed.payload?.steps?.every((s) => s.status === 'COMPLETED'), show(viewed));

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Re-running a completed run is a no-op.');
  const linesBefore = await prisma.folioLine.count({ where: { propertyId: fx.propertyId } });
  const finishedBefore = s1.map((s) => s.finishedAt.getTime());
  h.check('execute again → COMPLETED', (await runner.execute(run1.id)) === 'COMPLETED');
  const s1again = await steps(run1.id);
  h.check(
    'nothing moved: business date, ledger, snapshot, step times',
    (await businessDate(fx)) === shiftDays(D, 1) &&
      (await prisma.folioLine.count({ where: { propertyId: fx.propertyId } })) === linesBefore &&
      (await prisma.dailySnapshot.count({ where: { propertyId: fx.propertyId } })) === 1 &&
      s1again.every((s, i) => s.finishedAt.getTime() === finishedBefore[i]),
  );
  let refused = false;
  try {
    await prisma.dailySnapshot.update({ where: { id: snap[0].id }, data: { roomsSold: 99 } });
  } catch {
    refused = true;
  }
  h.check('a snapshot cannot be rewritten (append-only trigger)', refused);

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. The next day: tonight is charged once, even by two racing executors.');
  const next = await h.call('POST', `${base(fx)}/night-audit/runs`, auditor, {});
  h.check('a new run for the new business date', next.payload?.outcome === 'CREATED' && next.payload?.run?.businessDate === shiftDays(D, 1), show(next));
  const [ra, rb] = await Promise.allSettled([runner.execute(next.payload.run.id), runner.execute(next.payload.run.id)]);
  h.check('both executors finish', ra.status === 'fulfilled' && rb.status === 'fulfilled', `${ra.status}/${rb.status} ${String(ra.reason ?? rb.reason ?? '')}`);
  const night2 = await roomCharges(inHouse, shiftDays(D, 1));
  const priced = await prisma.reservationNight.findFirst({ where: { reservationId: inHouse.id, stayDate: utcMidnight(shiftDays(D, 1)) }, select: { rateMinor: true, taxMinor: true } });
  const tax2 = night2.length === 1 ? await prisma.folioLine.findMany({ where: { derivedFromLineId: night2[0].id, kind: 'TAX' }, select: { amountMinor: true } }) : [];
  h.check('night 2 is posted exactly once', night2.length === 1, String(night2.length));
  h.check(
    "at the stay's own stored price, with its tax line",
    priced === null ? night2[0]?.amountMinor > 0 : night2[0]?.amountMinor === priced.rateMinor && tax2.reduce((s, t) => s + t.amountMinor, 0) === priced.taxMinor,
    JSON.stringify({ posted: night2[0]?.amountMinor, priced, tax: tax2 }),
  );
  h.check('the business date advanced exactly once more', (await businessDate(fx)) === shiftDays(D, 2));
  h.check('one snapshot per day', (await prisma.dailySnapshot.count({ where: { propertyId: fx.propertyId } })) === 2);
  h.check('one advance audit row per day', (await prisma.auditLog.count({ where: { propertyId: fx.propertyId, event: 'BUSINESS_DATE_ADVANCED' } })) === 2);
  await assertCounters('after the second day', fx, windowDates);

  /* ------------------------------------------------------------------ 5 */
  console.log('\n5. A blocked run fails, says why, and resumes once fixed.');
  const fyAdmin = fy.users.admin.cookie;
  const guest = await book(fy, fyAdmin, { arrival: fy.today, nights: 2, roomId: fy.rooms.A1.id, last: 'Unassigned' });
  h.check('setup: second property stay checks in', ok(await checkIn(fy, fyAdmin, guest, fy.rooms.A1.id)));
  // Suite-owned data, made inconsistent on purpose to reach the precondition.
  // The exclusion constraint ignores a null room, so nothing else is disturbed.
  const assignment = await prisma.reservationRoom.findFirst({ where: { reservationId: guest.id }, select: { id: true, roomId: true } });
  await prisma.reservationRoom.update({ where: { id: assignment.id }, data: { roomId: null } });
  const blockedStart = await h.call('POST', `${base(fy)}/night-audit/runs`, fyAdmin, {});
  const blockedId = blockedStart.payload?.run?.id;
  let blockedError = null;
  try {
    await runner.execute(blockedId);
  } catch (error) {
    blockedError = error;
  }
  const blockedRun = await prisma.nightAuditRun.findFirst({ where: { id: blockedId }, select: { status: true, lastError: true } });
  const blockedSteps = await steps(blockedId);
  h.check('the run fails with NIGHT_AUDIT_BLOCKED', blockedError?.code === 'NIGHT_AUDIT_BLOCKED', String(blockedError?.message));
  h.check('FAILED, with the reason recorded', blockedRun.status === 'FAILED' && /no room assigned/.test(blockedRun.lastError ?? ''), blockedRun.lastError);
  h.check(
    'step 1 FAILED naming the stay; no later step ran',
    blockedSteps.length === 1 && blockedSteps[0].status === 'FAILED' && blockedSteps[0].outcome.unassignedInHouse?.includes(guest.bookingCode),
    JSON.stringify(blockedSteps.map((s) => [s.step, s.status])),
  );
  h.check('the business date did not move', (await businessDate(fy)) === fy.today);
  h.check('the first property is unaffected', (await businessDate(fx)) === shiftDays(D, 2));
  await prisma.reservationRoom.update({ where: { id: assignment.id }, data: { roomId: assignment.roomId } });
  const resumed = await h.call('POST', `${base(fy)}/night-audit/runs`, fyAdmin, {});
  h.check('asking again RESUMES the same run', resumed.payload?.outcome === 'RESUMED' && resumed.payload?.run?.id === blockedId, show(resumed));
  h.check('and it completes', (await runner.execute(blockedId)) === 'COMPLETED');
  const resumedSteps = await steps(blockedId);
  h.check('all eight steps COMPLETED, the failed one overwritten', resumedSteps.length === 8 && resumedSteps.every((s) => s.status === 'COMPLETED'));
  h.check('the business date advanced', (await businessDate(fy)) === shiftDays(fy.today, 1));

  /* ------------------------------------------------------------------ 6 */
  console.log('\n6. The schedule is per timezone, and one property cannot block another.');
  // 21:40 UTC on 2026-11-15 is 03:10 on 11-16 in Kolkata and 16:40 on 11-15 in New York.
  const at = new Date('2026-11-15T21:40:00Z');
  h.check('Kolkata, day 11-15, audit time 03:00: due', auditDue({ businessDate: '2026-11-15', timeZone: 'Asia/Kolkata', now: at, auditTime: '03:00' }).due === true);
  h.check('New York, same instant: not yet', auditDue({ businessDate: '2026-11-15', timeZone: 'America/New_York', now: at, auditTime: '03:00' }).reason === 'NOT_YET');
  h.check('Kolkata before the audit time: not yet', auditDue({ businessDate: '2026-11-15', timeZone: 'Asia/Kolkata', now: at, auditTime: '04:00' }).reason === 'NOT_YET');
  h.check('a property days behind is STALE, never auto-caught-up', auditDue({ businessDate: '2026-11-10', timeZone: 'Asia/Kolkata', now: at, auditTime: '03:00' }).reason === 'STALE');

  // Both fixture properties are due at this instant in Kolkata time.
  const dueAt = new Date(`${shiftDays(await businessDate(fx), 1)}T00:00:00+05:30`);
  dueAt.setUTCHours(dueAt.getUTCHours() + 4);
  await prisma.property.updateMany({ where: { id: fy.propertyId }, data: { businessDate: utcMidnight(await businessDate(fx)) } });
  const failing = {
    enqueueForProperty: async (propertyId, userId) => {
      if (propertyId === fx.propertyId) throw new Error('simulated failure for the first property');
      return new NightAuditService(prismaStub, outbox).enqueueForProperty(propertyId, userId);
    },
  };
  const scheduler = new NightAuditScheduler(prismaStub, { now: () => dueAt }, failing, configStub({ NIGHT_AUDIT_LOCAL_TIME: '03:00' }));
  const tick = await scheduler.tick([fx.propertyId, fy.propertyId]);
  h.check('the failing property is reported', tick.failed.length === 1 && tick.failed[0].propertyId === fx.propertyId, JSON.stringify(tick));
  h.check('and the other is still enqueued', tick.enqueued.length === 1 && tick.enqueued[0] === fy.propertyId, JSON.stringify(tick));
  const tickAgain = await scheduler.tick([fy.propertyId]);
  h.check('a second tick enqueues nothing new (idempotent)', tickAgain.enqueued.length === 0, JSON.stringify(tickAgain));
  const scheduledRun = await prisma.nightAuditRun.findFirst({ where: { propertyId: fy.propertyId, businessDate: utcMidnight(await businessDate(fy)) }, select: { requestedById: true, status: true } });
  h.check('the scheduled run has no requesting user', scheduledRun?.requestedById === null && scheduledRun?.status === 'PENDING', JSON.stringify(scheduledRun));
}

await runSuite({
  harness: h,
  prisma,
  label: 'night audit integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
