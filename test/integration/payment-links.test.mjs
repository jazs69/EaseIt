/**
 * Razorpay payment links (FO-15) and the payments ledger (FO-16).
 *
 * ===========================================================================
 * Through the running API, with Razorpay replaced by a stand-in served from
 * this process (the documented request and response shapes). The API under
 * test must be started with:
 *
 *   RAZORPAY_KEY_ID=rzp_test_suite  RAZORPAY_KEY_SECRET=suite-secret
 *   RAZORPAY_WEBHOOK_SECRET=suite-webhook-secret
 *   RAZORPAY_BASE_URL=http://127.0.0.1:4993
 *
 * Asserted: the per-property switch and who may flip it; a link is created
 * once per key with our id as reference_id and the property in notes; the
 * webhook is refused unsigned or mis-signed; a signed payment_link.paid posts
 * the captured payment to the folio exactly once, under repeats and a race of
 * webhooks and status checks; card last four comes through; money captured
 * after the folio closed is flagged, never posted; cancel; the ledger; 403 and
 * 404, and a webhook naming another property cannot reach this one's link.
 * ===========================================================================
 */

import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { WHOLLY_DISPOSABLE } from '../support/isolation-guard.mjs';
import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'payment links';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZPLA',
  slugPrefix: 'zz-pla-',
  emailDomain: 'pla.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (B)`,
  prefix: 'ZZPLB',
  slugPrefix: 'zz-plb-',
  emailDomain: 'plb.invalid',
  prisma,
});

const WEBHOOK_SECRET = 'suite-webhook-secret';
const KEY_ID = 'rzp_test_suite';
const KEY_SECRET = 'suite-secret';
const RZP_PORT = 4993;

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;

/* ------------------------------------------------- the stand-in Razorpay -- */

const rzp = {
  links: new Map(), // plink id -> link
  calls: [],
};
let counter = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const expected = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;
    rzp.calls.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization === expected,
      body,
    });
    if (req.headers.authorization !== expected) {
      return send(401, {
        error: { code: 'BAD_REQUEST_ERROR', description: 'The api key provided is invalid' },
      });
    }
    if (req.method === 'POST' && req.url === '/v1/payment_links') {
      const input = JSON.parse(body);
      if ([...rzp.links.values()].some((l) => l.reference_id === input.reference_id)) {
        return send(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'payment link creation with reference ID already attempted',
          },
        });
      }
      counter += 1;
      const link = {
        ...input,
        id: `plink_suite${String(counter)}`,
        short_url: `https://rzp.io/i/suite${String(counter)}`,
        status: 'created',
        amount_paid: 0,
        payments: null,
      };
      rzp.links.set(link.id, link);
      return send(200, link);
    }
    const fetchMatch = /^\/v1\/payment_links\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && fetchMatch) {
      const link = rzp.links.get(fetchMatch[1]);
      return link === undefined
        ? send(400, { error: { description: 'The id provided does not exist' } })
        : send(200, link);
    }
    const cancelMatch = /^\/v1\/payment_links\/([^/]+)\/cancel$/.exec(req.url ?? '');
    if (req.method === 'POST' && cancelMatch) {
      const link = rzp.links.get(cancelMatch[1]);
      if (link === undefined || link.status !== 'created')
        return send(400, { error: { description: 'cannot cancel' } });
      link.status = 'cancelled';
      return send(200, link);
    }
    const payMatch = /^\/v1\/payments\/([^/?]+)\?expand\[\]=card$/.exec(req.url ?? '');
    if (req.method === 'GET' && payMatch) {
      return send(200, {
        id: payMatch[1],
        method: 'card',
        card: { last4: '1111', network: 'Visa', issuer: 'HDFC' },
      });
    }
    return send(404, { error: { description: 'not found' } });
  });
});

/** Razorpay captures a payment on a link. */
function capture(plinkId, paymentId, amount, method = 'card') {
  const link = rzp.links.get(plinkId);
  link.status = 'paid';
  link.amount_paid = amount;
  link.payments = [
    {
      payment_id: paymentId,
      amount,
      method,
      status: 'captured',
      plink_id: plinkId,
      created_at: 1,
      updated_at: 1,
    },
  ];
}

function webhookBody(plinkId, notes) {
  return JSON.stringify({
    entity: 'event',
    event: 'payment_link.paid',
    contains: ['payment_link', 'order', 'payment'],
    payload: { payment_link: { entity: { id: plinkId, status: 'paid', notes } } },
    created_at: 1,
  });
}

async function webhook(raw, signature) {
  const response = await fetch(`${h.API}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-razorpay-signature': signature }),
    },
    body: raw,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}
const sign = (raw) => createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

/* ---------------------------------------------------------------- suite -- */

async function body() {
  console.log('\n════ payment links (FO-15, FO-16) ════\n');
  await new Promise((resolve) => server.listen(RZP_PORT, '127.0.0.1', resolve));
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
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);

  const admin = A.users.admin.cookie;
  const clerk = A.users.clerk.cookie;
  const base = `/properties/${A.propertyCode}`;
  const D = A.today;
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 4 }, (_, i) => shiftDays(D, i)).map((night) => ({
      propertyId: A.propertyId,
      roomTypeId: A.categoryA,
      stayDate: utcMidnight(night),
      physical: 6,
    })),
  });

  const stayIn = async (last, room) => {
    const booked = await h.call('POST', `${base}/reservations`, admin, {
      roomTypeId: A.categoryA,
      roomId: null,
      arrivalDate: D,
      departureDate: shiftDays(D, 1),
      adults: 1,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [
        {
          firstName: 'Pay',
          lastName: last,
          email: `pay.${last.toLowerCase()}@pla.invalid`,
          phone: '+91 98765 43210',
          govtIdType: 'PASSPORT',
          govtIdNumber: 'P1234567',
        },
      ],
      isInstantCheckIn: false,
    });
    if (booked.status !== 201) throw new Error(`booking failed: ${show(booked)}`);
    const checkIn = await h.call(
      'POST',
      `${base}/reservations/${booked.payload.id}/check-in`,
      admin,
      {
        roomId: A.rooms[room].id,
        primaryGuestIdType: 'PASSPORT',
        primaryGuestIdNumber: 'P1234567',
        acknowledgeRoomNotClean: true,
      },
    );
    if (!ok(checkIn)) throw new Error(`check-in failed: ${show(checkIn)}`);
    const folio = await prisma.folio.findFirst({
      where: { reservationId: booked.payload.id },
      select: { id: true },
    });
    return { stay: booked.payload, folioId: folio.id };
  };
  const balanceOf = async (folioId) =>
    (await prisma.folioLine.aggregate({ where: { folioId }, _sum: { amountMinor: true } }))._sum
      .amountMinor ?? 0;
  const send = (cookie, folioId, amountMinor, key = randomUUID()) =>
    h.call('POST', `${base}/folios/${folioId}/payment-links`, cookie, {
      amountMinor,
      notifySms: true,
      notifyEmail: true,
      idempotencyKey: key,
    });

  /* -------------------------------------------------------------- 1 */
  console.log('1. The gateway switch.');
  const state = await h.call('GET', `${base}/payment-gateway`, clerk);
  h.check(
    'the API is configured in test mode, but this property is not switched on',
    ok(state) &&
      state.payload.configured === true &&
      state.payload.mode === 'test' &&
      state.payload.canSendLinks === false &&
      state.payload.webhookConfigured === true,
    JSON.stringify(state.payload),
  );
  if (!state.payload?.configured) {
    throw new Error(
      'The API under test has no Razorpay keys: start it with the RAZORPAY_* variables in this file’s header.',
    );
  }
  const s1 = await stayIn('One', 'R1');
  const owed = await balanceOf(s1.folioId);
  const offSend = await send(clerk, s1.folioId, owed);
  h.check(
    'a link cannot be sent while the property is switched off',
    offSend.status === 400,
    show(offSend),
  );
  const clerkOn = await h.call('PUT', `${base}/payment-gateway`, clerk, { status: 'ACTIVE' });
  h.check('front desk cannot switch it on: 403', clerkOn.status === 403, show(clerkOn));
  const on = await h.call('PUT', `${base}/payment-gateway`, admin, { status: 'ACTIVE' });
  h.check('an administrator switches it on', ok(on) && on.payload.canSendLinks === true, show(on));

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Sending a link.');
  const tooMuch = await send(clerk, s1.folioId, owed + 1);
  h.check('more than the balance is refused', tooMuch.status === 400, show(tooMuch));
  const key = randomUUID();
  const sent = await send(clerk, s1.folioId, owed, key);
  const link = sent.payload;
  h.check(
    'front desk sends a link; Razorpay confirms it',
    ok(sent) && link.status === 'ACTIVE' && link.shortUrl?.startsWith('https://rzp.io/') === true,
    show(sent),
  );
  const createCall = rzp.calls.find((c) => c.method === 'POST' && c.url === '/v1/payment_links');
  const created = JSON.parse(createCall?.body ?? '{}');
  h.check(
    'created with Basic auth, paise, our id as reference_id and the property in notes',
    createCall?.auth === true &&
      created.amount === owed &&
      created.reference_id === link.id &&
      created.notes?.property_id === A.propertyId &&
      created.notes?.link_id === link.id &&
      created.customer?.contact === '9876543210',
    JSON.stringify({
      amount: created.amount,
      reference_id: created.reference_id,
      notes: created.notes,
    }),
  );
  const replay = await send(clerk, s1.folioId, owed, key);
  h.check(
    'the same key is the same link, and Razorpay is not called again',
    ok(replay) &&
      replay.payload.id === link.id &&
      rzp.calls.filter((c) => c.url === '/v1/payment_links').length === 1,
    show(replay),
  );

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. The webhook.');
  capture(link.providerLinkId, 'pay_SuiteCard0001', owed, 'card');
  const raw = webhookBody(link.providerLinkId, {
    property_id: A.propertyId,
    link_id: link.id,
    booking: s1.stay.bookingCode,
  });
  const unsigned = await webhook(raw, undefined);
  h.check(
    'an unsigned webhook is refused with 401',
    unsigned.status === 401,
    String(unsigned.status),
  );
  const forged = await webhook(raw, sign(`${raw} `));
  h.check('a mis-signed webhook is refused with 401', forged.status === 401, String(forged.status));
  h.check('a refused webhook posted nothing', (await balanceOf(s1.folioId)) === owed);
  const signed = await webhook(raw, sign(raw));
  h.check(
    'a signed payment_link.paid is accepted',
    signed.status === 200 && signed.payload?.handled === true,
    JSON.stringify(signed),
  );
  const posted = await prisma.folioLine.findMany({
    where: { folioId: s1.folioId, idempotencyKey: 'razorpay_pay_SuiteCard0001' },
    select: { amountMinor: true, paymentMethod: true, cardLast4: true, postedById: true },
  });
  h.check(
    'the captured payment is on the folio once, as a card payment with its last four, by the system',
    posted.length === 1 &&
      posted[0].amountMinor === -owed &&
      posted[0].paymentMethod === 'CARD' &&
      posted[0].cardLast4 === '1111' &&
      posted[0].postedById === null,
    JSON.stringify(posted),
  );
  h.check('the folio balances to zero', (await balanceOf(s1.folioId)) === 0);
  const linkRow = await prisma.paymentLink.findFirst({
    where: { id: link.id },
    select: { status: true, amountPaidMinor: true },
  });
  h.check(
    'the link is PAID with the amount paid',
    linkRow?.status === 'PAID' && linkRow.amountPaidMinor === owed,
    JSON.stringify(linkRow),
  );

  const storm = await Promise.all([
    webhook(raw, sign(raw)),
    webhook(raw, sign(raw)),
    ...Array.from({ length: 6 }, () =>
      h.call('POST', `${base}/payment-links/${link.id}/refresh`, clerk),
    ),
  ]);
  h.check(
    'repeated webhooks and 6 racing checks all succeed',
    storm.every((res) => res.status === 200),
    storm.map((r) => r.status).join(','),
  );
  h.check(
    'and the payment is still on the folio exactly once',
    (await prisma.folioLine.count({
      where: { folioId: s1.folioId, idempotencyKey: 'razorpay_pay_SuiteCard0001' },
    })) === 1 && (await balanceOf(s1.folioId)) === 0,
  );

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Money captured after the folio closed is flagged, not posted.');
  const s2 = await stayIn('Two', 'R2');
  const owed2 = await balanceOf(s2.folioId);
  const link2 = (await send(clerk, s2.folioId, owed2)).payload;
  const cash = await h.call(
    'POST',
    `${base}/folios/by-booking/${s2.stay.bookingCode}/payment`,
    clerk,
    { method: 'CASH', amountMinor: owed2, remark: null, idempotencyKey: randomUUID() },
  );
  const out = await h.call('POST', `${base}/reservations/${s2.stay.id}/check-out`, clerk, {
    reason: null,
  });
  h.check(
    'the stay is paid in cash and checked out',
    ok(cash) && ok(out),
    `${show(cash)} ${show(out)}`,
  );
  capture(link2.providerLinkId, 'pay_SuiteLate0002', owed2, 'upi');
  const late = await h.call('POST', `${base}/payment-links/${link2.id}/refresh`, clerk);
  h.check(
    'the link needs attention, naming the Razorpay payment',
    ok(late) &&
      late.payload.status === 'NEEDS_ATTENTION' &&
      late.payload.lastError?.includes('pay_SuiteLate0002') === true,
    show(late),
  );
  h.check(
    'and nothing was posted to the closed folio',
    (await prisma.folioLine.count({ where: { idempotencyKey: 'razorpay_pay_SuiteLate0002' } })) ===
      0,
  );

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Cancel, the ledger, permissions and tenancy.');
  const s3 = await stayIn('Three', 'R3');
  const link3 = (await send(clerk, s3.folioId, await balanceOf(s3.folioId))).payload;
  const cancelled = await h.call('POST', `${base}/payment-links/${link3.id}/cancel`, clerk);
  h.check(
    'an unpaid link is cancelled at Razorpay',
    ok(cancelled) &&
      cancelled.payload.status === 'CANCELLED' &&
      rzp.links.get(link3.providerLinkId).status === 'cancelled',
    show(cancelled),
  );
  const again = await h.call('POST', `${base}/payment-links/${link3.id}/cancel`, clerk);
  h.check('a cancelled link cannot be cancelled again', again.status === 400, show(again));

  const ledger = await h.call('GET', `${base}/payments`, clerk);
  const online = ledger.payload?.entries?.find((e) => e.viaGateway);
  h.check(
    'the ledger lists the online card payment, and counts card money by method',
    ok(ledger) &&
      online?.amountMinor === owed &&
      online?.method === 'CARD' &&
      ledger.payload.totals.byMethod.CARD === owed &&
      ledger.payload.links.length === 3,
    show(ledger),
  );

  const hk = await h.call('GET', `${base}/payments`, A.users.housekeeper.cookie);
  h.check('housekeeping cannot read payments: 403', hk.status === 403, show(hk));
  const foreign = B.users.admin.cookie;
  const foreignRefresh = await h.call(
    'POST',
    `/properties/${B.propertyCode}/payment-links/${link.id}/refresh`,
    foreign,
  );
  h.check(
    'another property cannot check this link: 404',
    foreignRefresh.status === 404,
    show(foreignRefresh),
  );
  const foreignLedger = await h.call('GET', `${base}/payments`, foreign);
  h.check('nor read this ledger: 404', foreignLedger.status === 404, show(foreignLedger));
  const crossRaw = webhookBody(link3.providerLinkId, {
    property_id: B.propertyId,
    link_id: link3.id,
  });
  const cross = await webhook(crossRaw, sign(crossRaw));
  h.check(
    "a signed webhook naming another property cannot reach this property's link",
    cross.status === 200 && cross.payload?.handled === false,
    JSON.stringify(cross),
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
      server.close();
      await other.teardown();
    }
  },
});
