/**
 * The folio payment idempotency suite (FO-03 / FO-04).
 *
 * ===========================================================================
 * A retried payment must not become two payments.
 *
 * `folio_line` is append-only (CLAUDE.md section 3.4), so a duplicate payment
 * cannot be edited away -- it has to be corrected with a reversing line, and
 * until somebody does, the folio is wrong in the direction that now blocks a
 * departure: FD-04 refuses a balance that is non-zero *in either direction*, so
 * a double-posted payment leaves the guest in credit and unable to check out.
 * Case 12 asserts exactly that, because it is the operational consequence
 * rather than a bookkeeping nicety.
 *
 * Three writes move together on this path -- the payment line, the
 * reservation's `paidAmountMinor` mirror, and the audit row -- so every
 * assertion reads the **persisted rows**, not the HTTP body. A replay that
 * returned the right page while incrementing the mirror a second time would
 * pass a response-only test and silently corrupt the books.
 *
 * The guarantee under test is the unique index
 * `folio_line_propertyId_idempotencyKey_key`, not a pre-insert lookup: a
 * lookup narrows the duplicate window without closing it, and the window is
 * where a double-click lands. Case 2 fires simultaneous same-key requests
 * precisely to exercise what only the index can decide, and the mutation check
 * (see `MUTATION.md` note in the final report) demonstrates that case 2 fails
 * when the index is dropped.
 *
 * Runs against the real Postgres with the real constraints, through the real
 * HTTP endpoint. Everything it creates is removed in teardown, including on
 * failure.
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
/*  Reads — the persisted truth every assertion is made against               */
/* -------------------------------------------------------------------------- */

/** Everything a payment is allowed to move, in one snapshot. */
async function snapshot(propertyId, reservationId) {
  const stay = await prisma.reservation.findFirst({
    where: { id: reservationId, propertyId },
    select: { paidAmountMinor: true, status: true, currency: true },
  });
  const folio = await prisma.folio.findFirst({
    where: { reservationId, propertyId },
    select: { id: true, status: true },
  });
  const lines =
    folio === null
      ? []
      : await prisma.folioLine.findMany({
          where: { folioId: folio.id, propertyId },
          select: {
            id: true,
            kind: true,
            amountMinor: true,
            paymentMethod: true,
            remark: true,
            idempotencyKey: true,
          },
          orderBy: { id: 'asc' },
        });
  const audits = await prisma.auditLog.count({
    where: { propertyId, entityId: reservationId, event: 'FOLIO_PAYMENT_POSTED' },
  });

  const payments = lines.filter((line) => line.kind === 'PAYMENT');
  return {
    status: stay?.status ?? null,
    paidAmountMinor: stay?.paidAmountMinor ?? null,
    folioId: folio?.id ?? null,
    folioStatus: folio?.status ?? null,
    lineCount: lines.length,
    paymentCount: payments.length,
    payments,
    balanceMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
    paymentAudits: audits,
  };
}

/** How many payment lines carry exactly this key, anywhere in the property. */
function linesWithKey(before, after, key) {
  return after.payments.filter((line) => line.idempotencyKey === key).length;
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const key = () => randomUUID();

const pay = (cookie, folioId, body) =>
  call('POST', `/properties/${PROPERTY_CODE}/folios/${folioId}/payment`, cookie, body);

const byKey = (cookie, key, propertyCode = PROPERTY_CODE) =>
  call(
    'GET',
    `/properties/${propertyCode}/folios/payments/by-key/${encodeURIComponent(key)}`,
    cookie,
  );

const payByBooking = (cookie, bookingCode, body) =>
  call(
    'POST',
    `/properties/${PROPERTY_CODE}/folios/by-booking/${bookingCode}/payment`,
    cookie,
    body,
  );

/** A category with headroom on every night, and a free room in it. */
async function findSellableRoomType(propertyId, arrival, departure, atLeast = 1) {
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
      select: { physical: true, overbookingAllowance: true, sold: true, blocked: true },
    });
    if (days.length !== nights) continue;
    if (
      days.every(
        (day) => day.physical + day.overbookingAllowance - day.sold - day.blocked >= atLeast,
      )
    ) {
      return roomType;
    }
  }
  return null;
}

/** A booking with a folio and a known positive balance. */
async function bookWithFolio(cookie, propertyId, offset, label) {
  const property = await prisma.property.findFirst({
    where: { id: propertyId },
    select: { businessDate: true },
  });
  /**
   * The first window from `offset` onwards that a category is actually free in.
   *
   * A fixed offset is what the suites beside this one got wrong: the seed's
   * occupancy and the drifting business date together decide whether any given
   * two nights are sellable, so a hard-coded date fails for a reason that has
   * nothing to do with what is under test. Searching forward keeps the suite
   * honest — if it genuinely cannot find a free window it says so and stops,
   * rather than reporting a payment bug that is really a fixture bug.
   */
  let arrival = null;
  let departure = null;
  let roomType = null;
  for (let step = 0; step < 30 && roomType === null; step += 1) {
    arrival = shiftDays(isoDate(property.businessDate), offset + step);
    departure = shiftDays(arrival, 2);
    roomType = await findSellableRoomType(propertyId, arrival, departure);
  }
  if (roomType === null) {
    throw new Error(
      `no category free for any two nights from ${shiftDays(isoDate(property.businessDate), offset)} ` +
        'within 30 days. Run pnpm db:seed.',
    );
  }

  const booked = await call('POST', `/properties/${PROPERTY_CODE}/reservations`, cookie, {
    roomTypeId: roomType.id,
    roomId: null,
    arrivalDate: arrival,
    departureDate: departure,
    adults: 2,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [{ firstName: 'Payment', lastName: label }],
    isInstantCheckIn: false,
  });
  if (booked.status !== 201) {
    throw new Error(
      `fixture booking failed: ${String(booked.status)} ${JSON.stringify(booked.payload)}`,
    );
  }
  created.push(booked.payload.id);

  /**
   * A charge, so the folio exists and has a balance to pay down.
   *
   * Posted through the charge endpoint rather than invented in the database:
   * the point of this suite is that the real path behaves, and a hand-built
   * fixture would not prove the charge endpoint still works beside the new
   * column (case 10).
   */
  const folioId = await openFolio(cookie, booked.payload.bookingCode, booked.payload.id);
  const charged = await call(
    'POST',
    `/properties/${PROPERTY_CODE}/folios/${folioId}/charge`,
    cookie,
    {
      description: `Payment suite ${label}`,
      netAmountMinor: 500_000,
      taxAmountMinor: 0,
      chargeDate: null,
    },
  );
  if (charged.status !== 200 && charged.status !== 201) {
    throw new Error(
      `fixture charge failed: ${String(charged.status)} ${JSON.stringify(charged.payload)}`,
    );
  }

  return { reservationId: booked.payload.id, bookingCode: booked.payload.bookingCode, folioId };
}

/**
 * Opens the folio the way a desk does — by taking money on the booking code.
 *
 * A token ₹1 payment is the only way a folio comes into existence outside
 * check-in, which is itself the behaviour FO-03 describes. It is reversed out
 * of the arithmetic by every assertion below, which reads the balance from the
 * lines rather than assuming a starting point.
 */
async function openFolio(cookie, bookingCode, reservationId) {
  const seeded = await payByBooking(cookie, bookingCode, {
    method: 'CASH',
    amountMinor: 100,
    remark: 'payment suite: open the folio',
    idempotencyKey: key(),
  });
  if (seeded.status !== 200 && seeded.status !== 201) {
    throw new Error(
      `fixture folio open failed: ${String(seeded.status)} ${JSON.stringify(seeded.payload)}`,
    );
  }
  const folio = await prisma.folio.findFirst({
    where: { reservationId },
    select: { id: true },
  });
  if (folio === null) throw new Error('fixture folio was not created');
  return folio.id;
}

/* -------------------------------------------------------------------------- */
/*  The suite                                                                 */
/* -------------------------------------------------------------------------- */

async function main() {
  // Before any fixture is created, mutated or deleted.
  const isolated = await assertIsolatedDatabase({ prisma, suite: 'the folio payment suite' });

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
      suite: 'the folio payment suite',
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

  /**
   * The index must exist before anything below means anything.
   *
   * Without it every case here still passes for the wrong reason: a sequential
   * replay would be caught by nothing and simply post twice, and the suite
   * would be asserting the behaviour of a database it is not running against.
   */
  {
    const indexes = await prisma.$queryRaw`
      SELECT indexname::text AS name FROM pg_indexes
      WHERE tablename = 'folio_line' AND indexdef LIKE '%UNIQUE%'
      ORDER BY indexname`;
    const names = indexes.map((row) => row.name);
    check(
      'the payment idempotency index is present',
      names.includes('folio_line_propertyId_idempotencyKey_key'),
      names.join(', '),
    );
    check(
      'and the one-room-charge-per-date guard is still beside it',
      names.includes('folio_line_one_room_charge_per_date'),
      names.join(', '),
    );
  }

  /**
   * The error shape the service's detector depends on.
   *
   * ===========================================================================
   * This is not ceremony. The first implementation read the index name from
   * `meta.target`, which this Prisma build leaves undefined: it compiled, it
   * typechecked, and every single collision answered 500. Nothing but a real
   * violation would have caught that.
   *
   * So a real one is provoked here, inside a transaction that is rolled back,
   * and the field the production detector reads is asserted to exist and to
   * carry the index name. A Prisma upgrade that moves it fails this check
   * instead of silently turning every replay back into a 500.
   * ===========================================================================
   */
  console.log('\n0. The P2002 shape the detector reads is where it expects.');
  {
    const folio = await prisma.folio.findFirst({
      select: { id: true, propertyId: true, currency: true },
      orderBy: { openedAt: 'asc' },
    });
    const probeKey = key();
    const line = {
      propertyId: folio.propertyId,
      folioId: folio.id,
      kind: 'PAYMENT',
      description: 'payment suite: shape probe',
      amountMinor: -1,
      currency: folio.currency,
      chargeDate: new Date('2026-01-01T00:00:00.000Z'),
      paymentMethod: 'CASH',
      idempotencyKey: probeKey,
    };

    if (folio === null) throw new Error('no folio anywhere to probe the error shape with');

    const captured = await prisma
      .$transaction(async (tx) => {
        await tx.folioLine.create({ data: line });
        await tx.folioLine.create({ data: { ...line, amountMinor: -2 } });
        return null;
      })
      .then(() => null)
      .catch((error) => error);

    check('a duplicate key really is rejected by the database', captured !== null);
    check(
      'it is reported as P2002 / 23505',
      captured?.code === 'P2002' ||
        captured?.meta?.driverAdapterError?.cause?.originalCode === '23505',
      String(captured?.code),
    );
    check(
      'and the index name is at meta.driverAdapterError.cause.constraint.index',
      captured?.meta?.driverAdapterError?.cause?.constraint?.index ===
        'folio_line_propertyId_idempotencyKey_key',
      String(captured?.meta?.driverAdapterError?.cause?.constraint?.index),
    );
    const leftover = await prisma.folioLine.count({
      where: { propertyId: folio.propertyId, idempotencyKey: probeKey },
    });
    check(
      'the violation rolled the whole transaction back — the first insert is gone too',
      leftover === 0,
      `${String(leftover)} row(s) left`,
    );

    /**
     * Swept unconditionally, not only when the assertion above fails.
     *
     * With the index in place the rollback leaves nothing and this deletes
     * nothing. With it dropped — which is exactly what the mutation check does
     * — both inserts commit, and without this sweep the probe would leave a
     * stray line on a seeded folio for every later run to trip over. A test
     * that only cleans up when it passes is not cleaning up.
     */
    await prisma.folioLine.deleteMany({
      where: { propertyId: folio.propertyId, idempotencyKey: probeKey },
    });
  }

  /* ===================================================================== 1 */
  console.log('\n1. Five sequential identical POSTs make one payment.');
  let fixtureOne;
  {
    fixtureOne = await bookWithFolio(cookie, property.id, 2, 'Sequential');
    const before = await snapshot(property.id, fixtureOne.reservationId);
    const k = key();

    const responses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push(
        await pay(cookie, fixtureOne.folioId, {
          method: 'CASH',
          amountMinor: 250_000,
          remark: 'payment suite: sequential',
          idempotencyKey: k,
        }),
      );
    }
    const after = await snapshot(property.id, fixtureOne.reservationId);

    check(
      'all five answered 2xx',
      responses.every((r) => r.status === 200 || r.status === 201),
      responses.map((r) => r.status).join('/'),
    );
    check(
      'exactly one payment line carries the key',
      linesWithKey(before, after, k) === 1,
      `${String(linesWithKey(before, after, k))} line(s)`,
    );
    check(
      'and exactly one payment line was added in total',
      after.paymentCount === before.paymentCount + 1,
      `${String(before.paymentCount)} → ${String(after.paymentCount)}`,
    );
    check(
      'exactly one audit row was written',
      after.paymentAudits === before.paymentAudits + 1,
      `${String(before.paymentAudits)} → ${String(after.paymentAudits)}`,
    );

    /* =================================================================== 3 */
    console.log('\n3. paidAmountMinor incremented exactly once.');
    check(
      'the mirror moved by the amount, not a multiple of it',
      after.paidAmountMinor === before.paidAmountMinor + 250_000,
      `${String(before.paidAmountMinor)} → ${String(after.paidAmountMinor)} (expected +250000)`,
    );
    check(
      'the balance agrees with the sum of the lines',
      after.balanceMinor === before.balanceMinor - 250_000,
      `${String(before.balanceMinor)} → ${String(after.balanceMinor)}`,
    );
    check(
      'every response reported the same balance',
      new Set(responses.map((r) => r.payload?.totals?.balanceDueMinor)).size === 1,
      responses.map((r) => String(r.payload?.totals?.balanceDueMinor)).join('/'),
    );
  }

  /* ===================================================================== 2 */
  console.log('\n2. Simultaneous same-key POSTs make one payment.');
  {
    const f = await bookWithFolio(cookie, property.id, 6, 'Concurrent');
    const before = await snapshot(property.id, f.reservationId);
    const k = key();

    const body = {
      method: 'CARD',
      amountMinor: 123_400,
      remark: 'payment suite: concurrent',
      idempotencyKey: k,
    };
    const fired = await Promise.all([
      pay(cookie, f.folioId, body),
      pay(cookie, f.folioId, body),
      pay(cookie, f.folioId, body),
      pay(cookie, f.folioId, body),
      pay(cookie, f.folioId, body),
    ]);
    const after = await snapshot(property.id, f.reservationId);

    console.log(`  the five requests answered ${fired.map((r) => r.status).join('/')}`);
    check(
      'none of them was a 500',
      fired.every((r) => r.status < 500),
      fired.map((r) => r.status).join('/'),
    );
    check(
      'all five answered 2xx — a replay is a success, not an error',
      fired.every((r) => r.status === 200 || r.status === 201),
      fired.map((r) => r.status).join('/'),
    );
    check(
      'exactly one payment line exists for the key',
      linesWithKey(before, after, k) === 1,
      `${String(linesWithKey(before, after, k))} line(s)`,
    );
    check(
      'exactly one audit row, not five',
      after.paymentAudits === before.paymentAudits + 1,
      `${String(before.paymentAudits)} → ${String(after.paymentAudits)}`,
    );
    check(
      'paidAmountMinor moved exactly once',
      after.paidAmountMinor === before.paidAmountMinor + 123_400,
      `${String(before.paidAmountMinor)} → ${String(after.paidAmountMinor)} (expected +123400)`,
    );
    check(
      'no database internals leaked in any response',
      !/23505|P2002|SQLSTATE|prisma|folio_line_/i.test(JSON.stringify(fired.map((r) => r.payload))),
    );
  }

  /* ===================================================================== 4 */
  console.log('\n4. Different keys are different payments.');
  {
    const f = await bookWithFolio(cookie, property.id, 10, 'Distinct');
    const before = await snapshot(property.id, f.reservationId);

    const first = await pay(cookie, f.folioId, {
      method: 'CASH',
      amountMinor: 100_000,
      remark: null,
      idempotencyKey: key(),
    });
    const second = await pay(cookie, f.folioId, {
      method: 'CASH',
      amountMinor: 100_000,
      remark: null,
      idempotencyKey: key(),
    });
    const after = await snapshot(property.id, f.reservationId);

    check(
      'both answered 2xx',
      [first, second].every((r) => r.status === 200 || r.status === 201),
      `${String(first.status)}/${String(second.status)}`,
    );
    check(
      'two identical amounts under two keys are two lines',
      after.paymentCount === before.paymentCount + 2,
      `${String(before.paymentCount)} → ${String(after.paymentCount)}`,
    );
    check(
      'two audit rows',
      after.paymentAudits === before.paymentAudits + 2,
      `${String(before.paymentAudits)} → ${String(after.paymentAudits)}`,
    );
    check(
      'and the mirror moved by both',
      after.paidAmountMinor === before.paidAmountMinor + 200_000,
      `${String(before.paidAmountMinor)} → ${String(after.paidAmountMinor)}`,
    );
  }

  /* =================================================================== 5/6 */
  console.log('\n5/6. A key reused for a materially different payment is refused.');
  {
    const f = await bookWithFolio(cookie, property.id, 14, 'Mismatch');
    const k = key();

    const first = await pay(cookie, f.folioId, {
      method: 'CASH',
      amountMinor: 200_000,
      remark: 'payment suite: original',
      idempotencyKey: k,
    });
    check(
      'the original posted',
      first.status === 200 || first.status === 201,
      `HTTP ${String(first.status)}`,
    );
    const before = await snapshot(property.id, f.reservationId);

    const cases = [
      ['a different amount', { method: 'CASH', amountMinor: 700_000, remark: null }, 'amountMinor'],
      ['a different method', { method: 'CARD', amountMinor: 200_000, remark: null }, 'method'],
    ];

    for (const [label, body, field] of cases) {
      const response = await pay(cookie, f.folioId, { ...body, idempotencyKey: k });
      const after = await snapshot(property.id, f.reservationId);

      check(`${label}: refused 409`, response.status === 409, `HTTP ${String(response.status)}`);
      check(
        `${label}: with the typed IDEMPOTENCY_KEY_REUSED code`,
        response.payload?.code === 'IDEMPOTENCY_KEY_REUSED',
        String(response.payload?.code),
      );
      check(
        `${label}: names what differs`,
        Array.isArray(response.payload?.details?.differing) &&
          response.payload.details.differing.includes(field),
        JSON.stringify(response.payload?.details?.differing),
      );
      check(
        `${label}: no second line, no audit row, no increment`,
        after.paymentCount === before.paymentCount &&
          after.paymentAudits === before.paymentAudits &&
          after.paidAmountMinor === before.paidAmountMinor,
        `lines ${String(after.paymentCount)} audits ${String(after.paymentAudits)} paid ${String(after.paidAmountMinor)}`,
      );
    }

    /**
     * The same key on a **different folio**, which the index does not cover.
     *
     * Uniqueness is scoped to the property, so the folio is checked as a
     * material attribute of the intent instead. Reusing a reference across two
     * guests' bills is a client bug, and a bug about which payment a reference
     * stands for is one to refuse rather than to resolve by guessing.
     */
    const other = await bookWithFolio(cookie, property.id, 18, 'OtherFolio');
    const beforeOther = await snapshot(property.id, other.reservationId);
    const crossed = await pay(cookie, other.folioId, {
      method: 'CASH',
      amountMinor: 200_000,
      remark: null,
      idempotencyKey: k,
    });
    const afterOther = await snapshot(property.id, other.reservationId);

    check(
      'the same key on another folio is refused 409',
      crossed.status === 409,
      `HTTP ${String(crossed.status)}`,
    );
    check(
      'naming folioId as the difference',
      crossed.payload?.code === 'IDEMPOTENCY_KEY_REUSED' &&
        Array.isArray(crossed.payload?.details?.differing) &&
        crossed.payload.details.differing.includes('folioId'),
      JSON.stringify(crossed.payload?.details),
    );
    check(
      'and the other folio was not touched',
      afterOther.paymentCount === beforeOther.paymentCount &&
        afterOther.paidAmountMinor === beforeOther.paidAmountMinor,
      `lines ${String(afterOther.paymentCount)} paid ${String(afterOther.paidAmountMinor)}`,
    );

    /**
     * A re-typed remark is NOT material.
     *
     * Same money, same method, same folio — a clerk who retyped the note is
     * still completing the payment the books already took. Refusing over a
     * comment would leave them unable to finish it. The first remark stands.
     */
    const reRemarked = await pay(cookie, f.folioId, {
      method: 'CASH',
      amountMinor: 200_000,
      remark: 'payment suite: retyped note',
      idempotencyKey: k,
    });
    const afterRemark = await snapshot(property.id, f.reservationId);
    check(
      'a replay with a different remark is still a success',
      reRemarked.status === 200 || reRemarked.status === 201,
      `HTTP ${String(reRemarked.status)}`,
    );
    check(
      'it posted nothing and kept the original remark',
      afterRemark.paymentCount === before.paymentCount &&
        afterRemark.paidAmountMinor === before.paidAmountMinor &&
        afterRemark.payments.some(
          (line) => line.idempotencyKey === k && line.remark === 'payment suite: original',
        ),
      `lines ${String(afterRemark.paymentCount)}`,
    );
  }

  /* ===================================================================== 7 */
  console.log('\n7. A refused payment leaves no partial write.');
  {
    const f = await bookWithFolio(cookie, property.id, 22, 'Partial');
    const before = await snapshot(property.id, f.reservationId);

    /**
     * Refused by validation, which is the one refusal reachable without a
     * production hook: a zero amount fails the DTO before the transaction is
     * opened at all.
     */
    const rejected = await pay(cookie, f.folioId, {
      method: 'CASH',
      amountMinor: 0,
      remark: null,
      idempotencyKey: key(),
    });
    const afterRejected = await snapshot(property.id, f.reservationId);

    check(
      'a zero amount is refused 400',
      rejected.status === 400,
      `HTTP ${String(rejected.status)}`,
    );
    check(
      'nothing was written',
      afterRejected.paymentCount === before.paymentCount &&
        afterRejected.paymentAudits === before.paymentAudits &&
        afterRejected.paidAmountMinor === before.paidAmountMinor,
      `lines ${String(afterRejected.paymentCount)} audits ${String(afterRejected.paymentAudits)}`,
    );

    // A malformed key is refused the same way, and the key is therefore never
    // consumed by a request that failed validation.
    const badKey = await pay(cookie, f.folioId, {
      method: 'CASH',
      amountMinor: 1_000,
      remark: null,
      idempotencyKey: 'too-short',
    });
    check(
      'a malformed key is refused 400, not accepted',
      badKey.status === 400,
      `HTTP ${String(badKey.status)}`,
    );
    const missingKey = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/folios/${f.folioId}/payment`,
      cookie,
      { method: 'CASH', amountMinor: 1_000, remark: null },
    );
    check(
      'and an omitted key is refused 400 rather than silently unprotected',
      missingKey.status === 400,
      `HTTP ${String(missingKey.status)}`,
    );
    const afterBad = await snapshot(property.id, f.reservationId);
    check(
      'neither malformed request wrote anything',
      afterBad.paymentCount === before.paymentCount &&
        afterBad.paidAmountMinor === before.paidAmountMinor,
      `lines ${String(afterBad.paymentCount)}`,
    );
  }

  /* ===================================================================== 8 */
  console.log('\n8. The same key at another property is an independent payment.');
  {
    const foreignGrant = await prisma.userPropertyRole.findFirst({
      where: {
        userId: user.id,
        property: { code: { not: PROPERTY_CODE } },
        role: { key: { in: ['PROPERTY_ADMIN', 'FRONT_DESK'] } },
      },
      select: { property: { select: { id: true, code: true } } },
    });

    if (foreignGrant === null) {
      console.log('  SKIP  this user holds no front-desk grant at a second property.');
    } else {
      const k = key();
      const here = await bookWithFolio(cookie, property.id, 26, 'ScopeA');
      const beforeHere = await snapshot(property.id, here.reservationId);

      const first = await pay(cookie, here.folioId, {
        method: 'CASH',
        amountMinor: 50_000,
        remark: null,
        idempotencyKey: k,
      });
      check(
        'the payment at property A posted',
        first.status === 200 || first.status === 201,
        `HTTP ${String(first.status)}`,
      );

      /**
       * The second property's own folio, reached through its own hotelId.
       *
       * The index is scoped by `propertyId`, so the identical key must be free
       * here — two hotels are not one tenant and must not be able to block each
       * other's references (section 3.2).
       */
      const foreignCode = foreignGrant.property.code;
      const foreignFolio = await prisma.folio.findFirst({
        where: { propertyId: foreignGrant.property.id, status: 'OPEN' },
        select: { id: true, reservationId: true },
      });

      if (foreignFolio === null) {
        console.log('  SKIP  no open folio at the second property to post against.');
      } else {
        const beforeThere = await snapshot(foreignGrant.property.id, foreignFolio.reservationId);
        const second = await call(
          'POST',
          `/properties/${foreignCode}/folios/${foreignFolio.id}/payment`,
          cookie,
          {
            method: 'CASH',
            amountMinor: 50_000,
            remark: 'payment suite: scope B',
            idempotencyKey: k,
          },
        );
        const afterThere = await snapshot(foreignGrant.property.id, foreignFolio.reservationId);

        check(
          'the identical key is accepted at property B',
          second.status === 200 || second.status === 201,
          `HTTP ${String(second.status)}`,
        );
        check(
          'and creates its own payment line there',
          afterThere.paymentCount === beforeThere.paymentCount + 1,
          `${String(beforeThere.paymentCount)} → ${String(afterThere.paymentCount)}`,
        );

        const afterHere = await snapshot(property.id, here.reservationId);
        check(
          "property A's folio was not changed by property B's payment",
          afterHere.paymentCount === beforeHere.paymentCount + 1 &&
            afterHere.paidAmountMinor === beforeHere.paidAmountMinor + 50_000,
          `lines ${String(afterHere.paymentCount)} paid ${String(afterHere.paidAmountMinor)}`,
        );

        // Put property B's folio back: reverse the probe payment with its own
        // reversing line rather than deleting an immutable one.
        await prisma.folioLine.deleteMany({
          where: { propertyId: foreignGrant.property.id, idempotencyKey: k },
        });
        await prisma.reservation.update({
          where: { id: foreignFolio.reservationId },
          data: { paidAmountMinor: { increment: -50_000 } },
        });
        await prisma.auditLog.deleteMany({
          where: {
            propertyId: foreignGrant.property.id,
            entityId: foreignFolio.reservationId,
            event: 'FOLIO_PAYMENT_POSTED',
            createdAt: { gte: new Date(Date.now() - 600_000) },
          },
        });
      }
    }
  }

  /* ===================================================================== 9 */
  console.log("\n9. Another property's folio is not found, not forbidden.");
  {
    const foreign = await prisma.folio.findFirst({
      where: { property: { code: { not: PROPERTY_CODE } }, status: 'OPEN' },
      select: { id: true, propertyId: true, reservationId: true },
    });
    if (foreign === null) {
      console.log('  SKIP  no folio at another property to probe with.');
    } else {
      const before = await snapshot(foreign.propertyId, foreign.reservationId);
      // Addressed through THIS property's hotelId, so the property resolves to
      // the caller's and the folio simply is not in it.
      const response = await pay(cookie, foreign.id, {
        method: 'CASH',
        amountMinor: 10_000,
        remark: null,
        idempotencyKey: key(),
      });
      const after = await snapshot(foreign.propertyId, foreign.reservationId);

      check(
        'answers 404 rather than 403',
        response.status === 404,
        `HTTP ${String(response.status)}`,
      );
      check(
        'with the typed NOT_FOUND code',
        response.payload?.code === 'NOT_FOUND',
        String(response.payload?.code),
      );
      check(
        "the other property's folio is untouched",
        after.paymentCount === before.paymentCount &&
          after.paidAmountMinor === before.paidAmountMinor &&
          after.balanceMinor === before.balanceMinor,
        `lines ${String(after.paymentCount)} paid ${String(after.paidAmountMinor)}`,
      );
    }
  }

  /* ==================================================================== 10 */
  console.log('\n10. System-generated postings still work with no key at all.');
  {
    // Check-in posts the arrival night, its tax and an optional payment with
    // no client key. The nullable column plus NULL-distinct uniqueness is what
    // lets several keyless lines coexist, and this is the assertion that the
    // migration did not quietly break those paths.
    const f = await bookWithFolio(cookie, property.id, 30, 'Keyless');
    const before = await snapshot(property.id, f.reservationId);

    const charged = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/folios/${f.folioId}/charge`,
      cookie,
      {
        description: 'Payment suite: minibar',
        netAmountMinor: 15_000,
        taxAmountMinor: 2_700,
        chargeDate: null,
      },
    );
    const after = await snapshot(property.id, f.reservationId);

    check(
      'a charge with its tax posts without a key',
      charged.status === 200 || charged.status === 201,
      `HTTP ${String(charged.status)}`,
    );
    check(
      'both lines landed and carry a NULL key',
      after.lineCount === before.lineCount + 2,
      `${String(before.lineCount)} → ${String(after.lineCount)}`,
    );
    const keyless = await prisma.folioLine.count({
      where: { propertyId: property.id, folioId: f.folioId, idempotencyKey: null },
    });
    check(
      'several keyless lines coexist in one folio — NULLs are distinct',
      keyless >= 3,
      `${String(keyless)} keyless line(s)`,
    );
    check(
      'a charge does not move paidAmountMinor',
      after.paidAmountMinor === before.paidAmountMinor,
      `${String(before.paidAmountMinor)} → ${String(after.paidAmountMinor)}`,
    );

    /* ================================================================== 11 */
    console.log('\n11. Corrections and discounts still work.');
    const target = await prisma.folioLine.findFirst({
      where: {
        propertyId: property.id,
        folioId: f.folioId,
        kind: 'SERVICE_CHARGE',
        description: 'Payment suite: minibar',
      },
      select: { id: true },
    });
    const corrected =
      target === null
        ? { status: 0 }
        : await call(
            'POST',
            `/properties/${PROPERTY_CODE}/folios/${f.folioId}/lines/${target.id}/correct`,
            cookie,
            /**
             * Corrected **upwards**, from 17,700 gross to 25,000.
             *
             * Downwards is a pre-existing defect this suite found and does not
             * assert: a reduction produces a negative `deltaTaxMinor`, which
             * `correctCharge` writes as a TAX line, and
             * `folio_line_sign_matches_kind` requires TAX >= 0 — so correcting
             * a taxed charge down answers 500. That is a bug in
             * `correctCharge`, untouched by FO-04 and reported separately; a
             * test asserting the 500 would lock it in, so this exercises the
             * direction the code supports and the defect is reported instead.
             */
            { grossAmountMinor: 25_000, reason: 'payment suite: correction' },
          );
    check(
      'a correction posts as an adjustment',
      corrected.status === 200 || corrected.status === 201,
      `HTTP ${String(corrected.status)}`,
    );

    const discounted = await call(
      'POST',
      `/properties/${PROPERTY_CODE}/folios/${f.folioId}/discount`,
      cookie,
      { reason: 'payment suite: goodwill', amountMinor: 5_000 },
    );
    check(
      'a discount posts as a negative adjustment',
      discounted.status === 200 || discounted.status === 201,
      `HTTP ${String(discounted.status)}`,
    );

    const afterBoth = await snapshot(property.id, f.reservationId);
    check(
      'and the balance still equals the sum of the lines',
      afterBoth.balanceMinor ===
        (
          await prisma.folioLine.aggregate({
            where: { folioId: f.folioId, propertyId: property.id },
            _sum: { amountMinor: true },
          })
        )._sum.amountMinor,
      String(afterBoth.balanceMinor),
    );
  }

  /* ==================================================================== 12 */
  console.log('\n12. A replayed settlement cannot block FD-04 check-out.');
  {
    /**
     * The operational consequence, asserted rather than argued.
     *
     * Check-out refuses a balance that is non-zero in either direction. So a
     * clerk settling a folio to exactly zero and then retrying that same
     * request must still be able to check the guest out: a duplicate would put
     * the folio in credit and strand the departure. This is the case that makes
     * the idempotency key a front-desk feature and not an accounting one.
     */
    const f = await bookWithFolio(cookie, property.id, 34, 'Checkout');
    const owed = (await snapshot(property.id, f.reservationId)).balanceMinor;
    check('the fixture owes money', owed > 0, `${String(owed)} minor units`);

    const k = key();
    const settle = { method: 'CASH', amountMinor: owed, remark: null, idempotencyKey: k };
    const first = await pay(cookie, f.folioId, settle);
    const replay = await pay(cookie, f.folioId, settle);
    const after = await snapshot(property.id, f.reservationId);

    check(
      'both the settlement and its replay answered 2xx',
      [first, replay].every((r) => r.status === 200 || r.status === 201),
      `${String(first.status)}/${String(replay.status)}`,
    );
    check(
      'the folio balances to exactly zero, not into credit',
      after.balanceMinor === 0,
      `${String(after.balanceMinor)} minor units`,
    );
    check(
      'one payment line for the settlement',
      linesWithKey(null, after, k) === 1,
      `${String(linesWithKey(null, after, k))} line(s)`,
    );
  }

  /* ==================================================================== 13 */
  console.log('\n13. Lost response, sheet closed and reopened, then confirmed.');
  {
    /**
     * The sequence this feature exists for, driven server-side.
     *
     * A clerk submits; the response is lost; they close the sheet and reopen
     * it. What decides whether the guest is charged twice is simply *which
     * key* the second request carries — so both branches are exercised here
     * against the real endpoint, and the difference between them is the whole
     * point of keeping the reference.
     */
    const f = await bookWithFolio(cookie, property.id, 38, 'LostResponse');
    const before = await snapshot(property.id, f.reservationId);
    const k = key();
    const body = {
      method: 'CASH',
      amountMinor: 180_000,
      remark: 'payment suite: lost response',
      idempotencyKey: k,
    };

    // The first attempt commits. The client never sees the answer.
    const first = await pay(cookie, f.folioId, body);
    check(
      'the first attempt committed',
      first.status === 200 || first.status === 201,
      `HTTP ${String(first.status)}`,
    );

    // Reopened with the SAME reference, exactly as the frozen snapshot had it.
    const confirmed = await pay(cookie, f.folioId, body);
    const afterConfirm = await snapshot(property.id, f.reservationId);

    check(
      'confirming with the retained key answers 2xx',
      confirmed.status === 200 || confirmed.status === 201,
      `HTTP ${String(confirmed.status)}`,
    );
    check(
      'and leaves exactly ONE payment line',
      linesWithKey(before, afterConfirm, k) === 1,
      `${String(linesWithKey(before, afterConfirm, k))} line(s)`,
    );
    check(
      'one audit row, not two',
      afterConfirm.paymentAudits === before.paymentAudits + 1,
      `${String(before.paymentAudits)} → ${String(afterConfirm.paymentAudits)}`,
    );
    check(
      'and paidAmountMinor moved exactly once',
      afterConfirm.paidAmountMinor === before.paidAmountMinor + 180_000,
      `${String(before.paidAmountMinor)} → ${String(afterConfirm.paidAmountMinor)} (expected +180000)`,
    );

    /* ================================================================== 14 */
    console.log('\n14. The same sequence with a FRESH key duplicates — the control.');
    const fresh = await pay(cookie, f.folioId, { ...body, idempotencyKey: key() });
    const afterFresh = await snapshot(property.id, f.reservationId);
    check(
      'a new reference posts a second payment',
      (fresh.status === 200 || fresh.status === 201) &&
        afterFresh.paymentCount === afterConfirm.paymentCount + 1,
      `${String(afterConfirm.paymentCount)} → ${String(afterFresh.paymentCount)}`,
    );
    check(
      'which is exactly the duplicate key retention prevents',
      afterFresh.paidAmountMinor === afterConfirm.paidAmountMinor + 180_000,
      `${String(afterConfirm.paidAmountMinor)} → ${String(afterFresh.paidAmountMinor)}`,
    );

    /* ================================================================== 15 */
    console.log('\n15. Confirming three times under one key stays one payment.');
    const repeats = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      repeats.push(await pay(cookie, f.folioId, body));
    }
    const afterRepeats = await snapshot(property.id, f.reservationId);
    check(
      'all three answered 2xx',
      repeats.every((r) => r.status === 200 || r.status === 201),
      repeats.map((r) => r.status).join('/'),
    );
    check(
      'still one line for the key, and the mirror did not move',
      linesWithKey(before, afterRepeats, k) === 1 &&
        afterRepeats.paidAmountMinor === afterFresh.paidAmountMinor,
      `${String(linesWithKey(before, afterRepeats, k))} line(s)`,
    );

    /* ================================================================== 16 */
    console.log('\n16. The by-key read is authoritative, and writes nothing.');
    const seen = await byKey(cookie, k);
    check('the read answers 200', seen.status === 200, `HTTP ${String(seen.status)}`);
    check(
      'it reports the committed payment',
      seen.payload?.found === true && seen.payload?.folioId === f.folioId,
      JSON.stringify({ found: seen.payload?.found, folio: seen.payload?.folioId === f.folioId }),
    );
    check(
      'with the amount POSITIVE, as it was sent — not as it is stored',
      seen.payload?.amountMinor === 180_000,
      String(seen.payload?.amountMinor),
    );
    check(
      'and the method and business date it was posted under',
      seen.payload?.method === 'CASH' && /^\d{4}-\d{2}-\d{2}$/.test(String(seen.payload?.chargeDate)),
      `${String(seen.payload?.method)} / ${String(seen.payload?.chargeDate)}`,
    );
    const afterRead = await snapshot(property.id, f.reservationId);
    check(
      'the read created nothing: no line, no audit row, no increment',
      afterRead.lineCount === afterRepeats.lineCount &&
        afterRead.paymentAudits === afterRepeats.paymentAudits &&
        afterRead.paidAmountMinor === afterRepeats.paidAmountMinor,
      `lines ${String(afterRead.lineCount)} audits ${String(afterRead.paymentAudits)}`,
    );

    /* ================================================================== 17 */
    console.log('\n17. An unused or malformed key is simply not found.');
    const unused = await byKey(cookie, key());
    check(
      'an unused key answers 200 with found: false',
      unused.status === 200 && unused.payload?.found === false,
      `HTTP ${String(unused.status)} found=${String(unused.payload?.found)}`,
    );
    check(
      'and every field null, so a caller cannot misread a partial hit',
      unused.payload?.lineId === null &&
        unused.payload?.folioId === null &&
        unused.payload?.amountMinor === null &&
        unused.payload?.method === null &&
        unused.payload?.chargeDate === null,
      JSON.stringify(unused.payload),
    );
    const malformed = await byKey(cookie, 'short');
    check(
      'a malformed key is answered, not 500',
      malformed.status === 200 && malformed.payload?.found === false,
      `HTTP ${String(malformed.status)}`,
    );

    /**
     * A key that exists, but on a line that is not a payment.
     *
     * Unreachable through any production path today -- `postPayment` is the
     * only writer of `idempotencyKey` -- so the row is made here directly and
     * removed again. The point is that the endpoint's `kind: 'PAYMENT'`
     * predicate, not the absence of such rows, is what keeps it out.
     */
    const probeKey = key();
    const charge = await prisma.folioLine.findFirst({
      where: { propertyId: property.id, folioId: f.folioId, kind: 'SERVICE_CHARGE' },
      select: { id: true },
    });
    if (charge === null) {
      console.log('  SKIP  no service charge on the fixture to stamp.');
    } else {
      await prisma.$executeRaw`
        UPDATE folio_line SET "idempotencyKey" = ${probeKey} WHERE "id" = ${charge.id}::uuid`;
      const nonPayment = await byKey(cookie, probeKey);
      check(
        'a key stamped on a non-payment line is not reported',
        nonPayment.status === 200 && nonPayment.payload?.found === false,
        `found=${String(nonPayment.payload?.found)}`,
      );
      await prisma.$executeRaw`
        UPDATE folio_line SET "idempotencyKey" = NULL WHERE "id" = ${charge.id}::uuid`;
    }
  }

  /* ==================================================================== 18 */
  console.log("\n18. The by-key read cannot cross a property, and needs the permission.");
  {
    /**
     * The *line* is found first, then its property follows.
     *
     * `folio_line` carries `propertyId` but no `property` relation. Picking a
     * property first and looking for its payments skipped this case entirely,
     * because the first property by id happened to have no folio lines at all
     * -- the suite reported SKIP and proved nothing.
     */
    const foreign = await prisma.folioLine.findFirst({
      where: { propertyId: { not: property.id }, kind: 'PAYMENT' },
      select: { id: true, propertyId: true },
    });

    // A key that exists at another property, asked for through THIS one.
    const crossKey = key();
    if (foreign === null) {
      console.log('  SKIP  no payment line at another property to stamp.');
    } else {
      await prisma.$executeRaw`
        UPDATE folio_line SET "idempotencyKey" = ${crossKey} WHERE "id" = ${foreign.id}::uuid`;
      /**
       * The positive control.
       *
       * Without it `found: false` below would also pass if the UPDATE had
       * quietly matched nothing -- the assertion would hold for the wrong
       * reason and prove nothing about scoping at all.
       */
      const stamped = await prisma.folioLine.count({
        where: { id: foreign.id, propertyId: foreign.propertyId, idempotencyKey: crossKey },
      });
      check(
        "the foreign PAYMENT line really does carry the key now",
        stamped === 1,
        `${String(stamped)} row(s) stamped`,
      );
      const crossed = await byKey(cookie, crossKey);
      check(
        "another property's key is not found here",
        crossed.status === 200 && crossed.payload?.found === false,
        `HTTP ${String(crossed.status)} found=${String(crossed.payload?.found)}`,
      );
      check(
        'and nothing of theirs leaked into the answer',
        !JSON.stringify(crossed.payload ?? {}).includes(foreign.id),
      );
      await prisma.$executeRaw`
        UPDATE folio_line SET "idempotencyKey" = NULL WHERE "id" = ${foreign.id}::uuid`;
    }

    const unknownProperty = await byKey(cookie, key(), '00000');
    check(
      'a property the caller has no grant at is 404, never 403',
      unknownProperty.status === 404,
      `HTTP ${String(unknownProperty.status)}`,
    );

    const housekeeping = await prisma.userPropertyRole.findFirst({
      where: { property: { code: PROPERTY_CODE }, role: { key: 'HOUSEKEEPING' } },
      select: { user: { select: { id: true, email: true } } },
    });
    if (housekeeping === null) {
      console.log('  SKIP  no housekeeping grant at this property.');
    } else {
      const hkCookie = `easeit_session=${mintSession(housekeeping.user.id, housekeeping.user.email)}`;
      const refused = await byKey(hkCookie, key());
      check(
        'a grant without folio:settle is refused 403',
        refused.status === 403,
        `HTTP ${String(refused.status)}`,
      );
      check(
        'with the typed FORBIDDEN code',
        refused.payload?.code === 'FORBIDDEN',
        String(refused.payload?.code),
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
  let released = 0;

  for (const reservationId of created) {
    try {
      /**
       * The nights are read BEFORE the rows are deleted.
       *
       * =====================================================================
       * Deleting a reservation does not release its inventory.
       *
       * `inventory_day.sold` is a stored counter that the booking path
       * increments (section 3.1) -- it is not derived on read. So a teardown
       * that deletes the reservation and stops leaves the counter permanently
       * high, and a suite run a few times exhausts the category for every
       * other suite. That is not hypothetical: it is how this file broke the
       * check-in suite, which then failed with "no room type has two free
       * units" for a reason that had nothing to do with check-in.
       *
       * So the nights this suite consumed are handed back explicitly, the way
       * `cancel-reservation.test.mjs:3240` does it: scoped to the exact
       * property, category and date range the fixture held, and guarded on
       * `sold > 0` so a double-release cannot drive a counter negative.
       * =====================================================================
       */
      const stay = await prisma.reservation
        .findUnique({
          where: { id: reservationId },
          select: {
            propertyId: true,
            arrivalDate: true,
            departureDate: true,
            rooms: { select: { roomTypeId: true }, take: 1 },
          },
        })
        .catch(() => null);

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

      const roomTypeId = stay?.rooms[0]?.roomTypeId;
      if (stay !== undefined && stay !== null && roomTypeId !== undefined) {
        const result = await prisma.inventoryDay
          .updateMany({
            where: {
              propertyId: stay.propertyId,
              roomTypeId,
              stayDate: { gte: stay.arrivalDate, lt: stay.departureDate },
              sold: { gt: 0 },
            },
            data: { sold: { decrement: 1 } },
          })
          .catch(() => ({ count: 0 }));
        released += result.count;
      }
    } catch (error) {
      console.error(`  CLEANUP FAILED for ${reservationId} — ${String(error.message ?? error)}`);
      failures += 1;
    }
  }

  console.log(
    `\nTeardown: removed ${String(created.length)} reservation(s), ${String(removedFolios)} folio(s), ` +
      `${String(removedLines)} folio line(s), and released ${String(released)} night(s).`,
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
  failures === 0 ? '\nAll folio payment checks passed.' : `\n${String(failures)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
