/**
 * Refunds and settlement (FO-12, FO-13).
 *
 * ===========================================================================
 * FO-12 acceptance: a refund is a reversing line, permission-gated, audited
 * and idempotent. FO-13 acceptance: a zero-balance folio closes; a non-zero
 * one is refused with a typed error. Plus what makes "closed at zero" true:
 * every folio write takes the reservation row then the folio row FOR UPDATE,
 * so a posting cannot land between a close's balance read and its update.
 *
 * Every race here is made deterministic the way `create-race` does it: the
 * suite holds the reservation row itself, fires the real endpoints, waits
 * until Postgres reports them parked on a lock, then releases.
 *
 * Suite-owned fixtures only (ZZFRS / ZZFRX), torn down by the harness.
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

const SUITE = 'folio settlement';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZFRS',
  slugPrefix: 'zz-frs-',
  emailDomain: 'frs.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZFRX',
  slugPrefix: 'zz-frx-',
  emailDomain: 'frx.invalid',
  prisma,
});

const key = () => randomUUID();
const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;

let fixture;

async function lockWaiters() {
  const rows = await prisma.$queryRaw`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`;
  return rows[0].waiting;
}

/**
 * Hold the reservation row, fire `operations` one at a time (each confirmed
 * parked before the next), release, and return their responses in order.
 * `holdMs` keeps the lock longer than the operations will wait, instead.
 */
async function underReservationLock(reservationId, operations, { holdMs = 0 } = {}) {
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
  if (holdMs > 0) {
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
  const settled = await Promise.all(results);
  return { settled, parked, elapsed: Date.now() - started };
}

async function body() {
  console.log('\n════ folio refunds and settlement (FO-12, FO-13) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK' },
    rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);
  const theirs = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });

  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({
      propertyId: fixture.propertyId,
      roomTypeId: fixture.categoryA,
      stayDate: utcMidnight(shiftDays(fixture.today, i)),
      physical: 10,
    })),
  });

  const base = `/properties/${fixture.propertyCode}`;
  const admin = fixture.users.admin.cookie;
  const clerk = fixture.users.clerk.cookie;
  let cursor = 5;

  async function booking(lastName) {
    const arrival = shiftDays(fixture.today, cursor);
    cursor += 3;
    const res = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      roomId: null,
      arrivalDate: arrival,
      departureDate: shiftDays(arrival, 1),
      adults: 1,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Settle', lastName }],
      isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking failed: ${show(res)}`);
    return res.payload;
  }
  const pay = (stay, amountMinor, method, k = key()) =>
    h.call('POST', `${base}/folios/by-booking/${stay.bookingCode}/payment`, clerk, {
      method,
      amountMinor,
      remark: null,
      idempotencyKey: k,
    });
  const refund = (cookie, folioId, paymentId, amountMinor, k = key(), reason = 'Guest request') =>
    h.call('POST', `${base}/folios/${folioId}/payments/${paymentId}/refund`, cookie, {
      amountMinor,
      reason,
      idempotencyKey: k,
    });
  const close = (cookie, folioId) =>
    h.call('POST', `${base}/folios/${folioId}/close`, cookie, { reason: 'Settled' });
  const cancel = (stay) =>
    h.call('POST', `${base}/reservations/${stay.id}/cancel`, clerk, { reason: 'Suite cancel' });
  const lines = (folioId) =>
    prisma.folioLine.findMany({
      where: { propertyId: fixture.propertyId, folioId },
      select: {
        id: true,
        kind: true,
        amountMinor: true,
        paymentMethod: true,
        reversesLineId: true,
        derivedFromLineId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  const balance = async (folioId) => (await lines(folioId)).reduce((s, l) => s + l.amountMinor, 0);
  const paid = async (stay) =>
    (await prisma.reservation.findFirst({ where: { id: stay.id }, select: { paidAmountMinor: true } }))
      .paidAmountMinor;
  const audits = (stay, event) =>
    prisma.auditLog.count({ where: { propertyId: fixture.propertyId, entityId: stay.id, event } });
  const folioRow = (folioId) =>
    prisma.folio.findFirst({ where: { id: folioId }, select: { status: true, closedAt: true } });

  /* ------------------------------------------------------------------ 1 */
  console.log('1. A refund is a reversing line by the same method.');
  const s1 = await booking('One');
  const cash = await pay(s1, 500000, 'CASH');
  const card = await pay(s1, 300000, 'CARD');
  h.check('two payments posted', ok(cash) && ok(card), `${show(cash)} / ${show(card)}`);
  const folioId = card.payload?.folioId;
  let ledger = await lines(folioId);
  const cashLine = ledger.find((l) => l.kind === 'PAYMENT' && l.paymentMethod === 'CASH');
  const cardLine = ledger.find((l) => l.kind === 'PAYMENT' && l.paymentMethod === 'CARD');

  const denied = await refund(clerk, folioId, cashLine.id, 100000);
  h.check('front desk (no folio:refund) is refused 403', denied.status === 403, show(denied));
  h.check('and nothing was written', (await lines(folioId)).length === ledger.length);

  const paidBefore = await paid(s1);
  const r1Key = key();
  const r1 = await refund(admin, folioId, cashLine.id, 200000, r1Key);
  h.check('admin refunds 2,000 of the cash payment', ok(r1), show(r1));
  ledger = await lines(folioId);
  const refunds = ledger.filter((l) => l.kind === 'REFUND');
  h.check(
    'one REFUND line, +200000, reversing the cash payment, by CASH',
    refunds.length === 1 &&
      refunds[0].amountMinor === 200000 &&
      refunds[0].reversesLineId === cashLine.id &&
      refunds[0].paymentMethod === 'CASH',
    JSON.stringify(refunds),
  );
  h.check(
    'the payment line itself is untouched',
    ledger.find((l) => l.id === cashLine.id)?.amountMinor === -500000,
  );
  h.check('paidAmountMinor fell by exactly 2,000', (await paid(s1)) === paidBefore - 200000, `${String(paidBefore)} -> ${String(await paid(s1))}`);
  h.check('one FOLIO_REFUND_POSTED audit row', (await audits(s1, 'FOLIO_REFUND_POSTED')) === 1);
  const rows = r1.payload?.transactions ?? [];
  const cashRow = rows.find((t) => t.id === cashLine.id);
  const refundRow = rows.find((t) => t.kind === 'REFUND');
  h.check('the page reports 3,000 still refundable on the cash payment', cashRow?.refundableMinor === 300000, JSON.stringify(cashRow?.refundableMinor));
  h.check('a refund row is not correctable, and has no refundable figure', refundRow?.isCorrectable === false && refundRow?.refundableMinor === null);
  h.check('the page counts it as a refund issued', r1.payload?.breakdown?.refundsIssuedMinor === 200000, JSON.stringify(r1.payload?.breakdown?.refundsIssuedMinor));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Idempotent per key.');
  for (let i = 0; i < 3; i += 1) {
    const again = await refund(admin, folioId, cashLine.id, 200000, r1Key);
    h.check(`replay ${String(i + 1)} answers success`, ok(again), show(again));
  }
  h.check('still exactly one refund line', (await lines(folioId)).filter((l) => l.kind === 'REFUND').length === 1);
  h.check('still one audit row, paid moved once', (await audits(s1, 'FOLIO_REFUND_POSTED')) === 1 && (await paid(s1)) === paidBefore - 200000);
  const reused = await refund(admin, folioId, cashLine.id, 250000, r1Key);
  h.check('same key, different amount: 409 IDEMPOTENCY_KEY_REUSED', reused.status === 409 && reused.payload?.code === 'IDEMPOTENCY_KEY_REUSED', show(reused));
  const reusedPay = await refund(admin, folioId, cardLine.id, 200000, r1Key);
  h.check('same key, different payment: 409', reusedPay.status === 409, show(reusedPay));
  const parallelKey = key();
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () => refund(admin, folioId, cardLine.id, 50000, parallelKey)),
  );
  h.check('five simultaneous same-key refunds all answer success', parallel.every(ok), parallel.map((r) => r.status).join(','));
  h.check('and post one line', (await lines(folioId)).filter((l) => l.kind === 'REFUND' && l.reversesLineId === cardLine.id).length === 1);

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Never more than was received.');
  const countBefore = (await lines(folioId)).length;
  const over = await refund(admin, folioId, cashLine.id, 300001);
  h.check('3,000.01 against 3,000 left: 400', over.status === 400, show(over));
  h.check('nothing written', (await lines(folioId)).length === countBefore);

  // 250,000 left on the card payment; eight concurrent 50,000 refunds.
  const race = await Promise.all(
    Array.from({ length: 8 }, () => refund(admin, folioId, cardLine.id, 50000)),
  );
  const won = race.filter(ok).length;
  const refundedCard = (await lines(folioId))
    .filter((l) => l.kind === 'REFUND' && l.reversesLineId === cardLine.id)
    .reduce((s, l) => s + l.amountMinor, 0);
  h.check('eight racing refunds: exactly five succeed', won === 5, race.map((r) => r.status).join(','));
  h.check('the rest are typed (400/409), never 500', race.every((r) => ok(r) || r.status === 400 || r.status === 409), race.map((r) => r.status).join(','));
  h.check('the card payment is refunded exactly 3,000, never more', refundedCard === 300000, String(refundedCard));

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. Only payments are refundable; tenancy is not-found.');
  const refundLine = (await lines(folioId)).find((l) => l.kind === 'REFUND');
  const ofRefund = await refund(admin, folioId, refundLine.id, 100);
  h.check('refunding a refund line: 400', ofRefund.status === 400, show(ofRefund));
  const unknown = await refund(admin, folioId, randomUUID(), 100);
  h.check('an unknown payment: 404', unknown.status === 404, show(unknown));
  const correctRefund = await h.call('POST', `${base}/folios/${folioId}/lines/${refundLine.id}/correct`, admin, {
    netAmountMinor: 100,
    reason: 'try',
  });
  h.check('a refund cannot be corrected: 400', correctRefund.status === 400, show(correctRefund));
  const theirBase = `/properties/${theirs.propertyCode}`;
  const crossRefund = await h.call('POST', `${theirBase}/folios/${folioId}/payments/${cashLine.id}/refund`, theirs.users.admin.cookie, {
    amountMinor: 100,
    reason: 'x',
    idempotencyKey: key(),
  });
  h.check('another property refunding this folio: 404, not 403', crossRefund.status === 404, show(crossRefund));
  const crossClose = await h.call('POST', `${theirBase}/folios/${folioId}/close`, theirs.users.admin.cookie, {});
  h.check('another property closing this folio: 404, not 403', crossClose.status === 404, show(crossClose));

  /* ------------------------------------------------------------------ 5 */
  console.log('\n5. Close only at exactly zero, and only once charges have stopped.');
  const early = await close(clerk, folioId);
  h.check('an upcoming stay cannot be closed here: 400', early.status === 400, show(early));
  h.check('the cancellation answers 200', ok(await cancel(s1)));
  const credit = await close(clerk, folioId);
  h.check(
    'in credit (-3,000): 409 OUTSTANDING_BALANCE',
    credit.status === 409 && credit.payload?.code === 'OUTSTANDING_BALANCE' && credit.payload?.details?.balanceMinor === -300000,
    show(credit),
  );
  const last = await refund(admin, folioId, cashLine.id, 300000);
  h.check('refunding the last 3,000 is allowed', ok(last), show(last));
  h.check('the ledger now sums to zero', (await balance(folioId)) === 0);
  const closed = await close(clerk, folioId);
  const afterClose = await folioRow(folioId);
  h.check('a zero-balance folio closes', ok(closed) && closed.payload?.folioStatus === 'CLOSED', show(closed));
  h.check('CLOSED with closedAt set, one FOLIO_CLOSED audit row', afterClose.status === 'CLOSED' && afterClose.closedAt !== null && (await audits(s1, 'FOLIO_CLOSED')) === 1);
  const twice = await close(clerk, folioId);
  const afterTwice = await folioRow(folioId);
  h.check('closing again is a no-op success', ok(twice) && afterTwice.closedAt.getTime() === afterClose.closedAt.getTime() && (await audits(s1, 'FOLIO_CLOSED')) === 1, show(twice));
  const late = await refund(admin, folioId, cashLine.id, 1);
  const latePay = await h.call('POST', `${base}/folios/${folioId}/payment`, clerk, { method: 'CASH', amountMinor: 100, remark: null, idempotencyKey: key() });
  const lateCharge = await h.call('POST', `${base}/folios/${folioId}/charge`, clerk, { description: 'Late', netAmountMinor: 100 });
  h.check(
    'nothing posts to a closed folio: 409 FOLIO_ALREADY_CLOSED',
    [late, latePay, lateCharge].every((r) => r.status === 409 && r.payload?.code === 'FOLIO_ALREADY_CLOSED'),
    [late, latePay, lateCharge].map(show).join(' | '),
  );

  const s2 = await booking('Two');
  const p2 = await pay(s2, 100000, 'UPI');
  const f2 = p2.payload?.folioId;
  const charge = await h.call('POST', `${base}/folios/${f2}/charge`, clerk, { description: 'Minibar', netAmountMinor: 150000 });
  h.check('a charge above the payment posts', ok(charge), show(charge));
  await cancel(s2);
  const owing = await close(clerk, f2);
  h.check(
    'owing (+500): 409 OUTSTANDING_BALANCE, folio stays open',
    owing.status === 409 && owing.payload?.code === 'OUTSTANDING_BALANCE' && owing.payload?.details?.balanceMinor === 50000 && (await folioRow(f2)).status === 'OPEN',
    show(owing),
  );
  const leak = JSON.stringify(owing.payload ?? {});
  h.check('no SQL or SQLSTATE in a refusal', !/SELECT|FOR UPDATE|55P03|23514/.test(leak));

  /* ------------------------------------------------------------------ 6 */
  console.log('\n6. A close and a posting cannot interleave (both queue orders).');
  for (const order of ['close first', 'payment first']) {
    const s = await booking(order === 'close first' ? 'RaceA' : 'RaceB');
    const p = await pay(s, 100000, 'CASH');
    const f = p.payload?.folioId;
    const pl = (await lines(f)).find((l) => l.kind === 'PAYMENT');
    h.check(`${order}: refunded to zero`, ok(await refund(admin, f, pl.id, 100000)));
    await cancel(s);
    const doClose = () => close(clerk, f);
    const doPay = () =>
      h.call('POST', `${base}/folios/${f}/payment`, clerk, { method: 'CASH', amountMinor: 50000, remark: null, idempotencyKey: key() });
    const { settled, parked } = await underReservationLock(s.id, order === 'close first' ? [doClose, doPay] : [doPay, doClose]);
    const [first, second] = settled;
    const row = await folioRow(f);
    const sum = await balance(f);
    h.check(`${order}: both were parked on the lock in that order`, parked);
    if (order === 'close first') {
      h.check('close first: the close wins at zero', ok(first) && row.status === 'CLOSED' && sum === 0, `${show(first)} sum ${String(sum)}`);
      h.check('close first: the queued payment is refused FOLIO_ALREADY_CLOSED', second.status === 409 && second.payload?.code === 'FOLIO_ALREADY_CLOSED', show(second));
    } else {
      h.check('payment first: the payment posts', ok(first), show(first));
      h.check('payment first: the queued close sees -500 and refuses', second.status === 409 && second.payload?.code === 'OUTSTANDING_BALANCE' && row.status === 'OPEN' && sum === -50000, `${show(second)} sum ${String(sum)}`);
    }
    h.check(`${order}: a CLOSED folio always sums to zero`, row.status !== 'CLOSED' || sum === 0);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n7. A refund parked behind a held lock gives up in bounded time.');
  {
    const s = await booking('Parked');
    const p = await pay(s, 100000, 'CASH');
    const f = p.payload?.folioId;
    const pl = (await lines(f)).find((l) => l.kind === 'PAYMENT');
    const before = (await lines(f)).length;
    const { settled, elapsed } = await underReservationLock(s.id, [() => refund(admin, f, pl.id, 10000)], { holdMs: 1 });
    const [parkedRefund] = settled;
    h.check('409 CONFLICT, not 500 or a hang', parkedRefund.status === 409 && parkedRefund.payload?.code === 'CONFLICT', show(parkedRefund));
    h.check('after the 3 s lock timeout (~3-8 s)', elapsed >= 2_500 && elapsed < 8_000, `${String(elapsed)} ms`);
    h.check('nothing was written', (await lines(f)).length === before);
  }
}

await runSuite({
  harness: h,
  prisma,
  label: 'folio settlement integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
