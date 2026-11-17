/**
 * The public booking engine (BE-01..BE-05, AV-08, AV-09), through the running
 * API, with no session, on suite-owned fixtures and a stand-in Razorpay.
 *
 * ===========================================================================
 * - BE-05: the slug is resolved server-side; unknown or inactive is 404; a
 *   header naming another property changes nothing.
 * - AV-08: only sellable categories, fitting the party, priced by PUBLIC plans
 *   (a corporate-only category is not offered; an unpriced one sells at rack).
 * - AV-09: a repeated search is served from the cache (stale on purpose), while
 *   quote and book read live inventory.
 * - BE-03: the quote holds the PRICE (a rate change after quoting does not
 *   change what the guest pays); tampered, expired and cross-property quotes
 *   are refused with nothing written; one booking per quote, also when the
 *   same quote is submitted 6 times in parallel; 8 different guests racing
 *   for the last room: exactly one wins (CLAUDE.md 3.1's required test), and
 *   `inventory_day.sold` equals live `reservation_room` rows PER DATE AND
 *   CATEGORY; the overbooking allowance is never sold publicly.
 * - BE-04: pay now gives a Razorpay link for the balance; a signed capture
 *   posts once, even when the webhook repeats; then nothing is owed.
 * - Guest access needs the booking's access token: a wrong one, or another
 *   property's slug, is 404.
 * ===========================================================================
 */

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { WHOLLY_DISPOSABLE } from '../support/isolation-guard.mjs';
import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'booking engine';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZBEA',
  slugPrefix: 'zz-bea-',
  emailDomain: 'bea.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (B)`,
  prefix: 'ZZBEB',
  slugPrefix: 'zz-beb-',
  emailDomain: 'beb.invalid',
  prisma,
});

const JWT_SECRET = /^JWT_SECRET\s*=\s*"?([^"\r\n]+)"?/m.exec(
  readFileSync(new URL('../../apps/api/.env', import.meta.url), 'utf8'),
)?.[1];
if (!JWT_SECRET) throw new Error('JWT_SECRET not found in apps/api/.env');
const WEBHOOK_SECRET = 'suite-webhook-secret';
const KEY_ID = 'rzp_test_suite';
const KEY_SECRET = 'suite-secret';
const RZP_PORT = 4993;

const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? res.payload?.message ?? '').slice(0, 240)}`;

/* ------------------------------------------------- the stand-in Razorpay -- */

const rzp = { links: new Map() };
let counter = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`
    ) {
      return send(401, { error: { description: 'bad key' } });
    }
    if (req.method === 'POST' && req.url === '/v1/payment_links') {
      const input = JSON.parse(body);
      counter += 1;
      const link = {
        ...input,
        id: `plink_be${String(counter)}`,
        short_url: `https://rzp.io/i/be${String(counter)}`,
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
        ? send(400, { error: { description: 'no such link' } })
        : send(200, link);
    }
    const payMatch = /^\/v1\/payments\/([^/?]+)\?expand\[\]=card$/.exec(req.url ?? '');
    if (req.method === 'GET' && payMatch) {
      return send(200, { id: payMatch[1], method: 'upi', card: null });
    }
    return send(404, { error: { description: 'not found' } });
  });
});

/* -------------------------------------------------------------- helpers -- */

let ipCounter = 0;
/** A distinct client address per call (the API trusts the proxy header), so the suite's volume never trips the per-client limits it does not mean to test. */
const freshIp = () =>
  `10.77.${String(Math.floor(++ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;

async function pub(method, path, body, { ip = freshIp(), headers = {} } = {}) {
  const response = await fetch(`${h.API}/public/properties${path}`, {
    method,
    headers: {
      'x-forwarded-for': ip,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
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

const decode = (token) =>
  JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString('utf8'));
const resign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', JWT_SECRET).update(`easeit-booking-quote:${body}`).digest('base64url')}`;
};
const guest = (n) => ({
  firstName: 'Asha',
  lastName: `Guest ${String(n)}`,
  email: `guest${String(n)}@bea.invalid`,
  phone: '+91 98765 43210',
});

async function body() {
  console.log('\n════ booking engine (BE-01..BE-05, AV-08, AV-09) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
  if (serverDb !== 'easeit_test' && !WHOLLY_DISPOSABLE.includes(serverDb)) {
    throw new Error(
      `REFUSING TO RUN: current_database() = "${String(serverDb)}". Nothing was created.`,
    );
  }
  await h.sweepLeftovers();
  await other.sweepLeftovers();
  await new Promise((resolve) => server.listen(RZP_PORT, '127.0.0.1', resolve));

  const A = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'B1', category: 'B', status: 'VACANT_CLEAN' },
    ],
  });
  const B = await other.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN' },
    rooms: [{ label: 'X1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);
  const P = A.propertyId;
  const slugA = (await prisma.property.findUnique({ where: { id: P }, select: { slug: true } }))
    .slug;
  const slugB = (
    await prisma.property.findUnique({ where: { id: B.propertyId }, select: { slug: true } })
  ).slug;
  const run = A.runId;

  // Category C: no plan prices it, so it sells at its standard (rack) rate.
  const catC = await prisma.roomType.create({
    data: {
      propertyId: P,
      code: `ZZBEAC${run}`.slice(0, 20),
      name: `ZZ Category C ${run}`,
      baseRateMinor: 300000,
      currency: 'INR',
      maxGuests: 2,
      sortOrder: 3,
    },
    select: { id: true },
  });
  await prisma.room.create({
    data: { propertyId: P, roomTypeId: catC.id, number: 'ZZBEA-C1', status: 'VACANT_CLEAN' },
  });

  const D = shiftDays(A.today, 5);
  const nights = Array.from({ length: 20 }, (_, i) => shiftDays(D, i));
  const physical = { [A.categoryA]: 2, [A.categoryB]: 1, [catC.id]: 1 };
  for (const [typeId, count] of Object.entries(physical)) {
    await prisma.inventoryDay.createMany({
      data: nights.map((n) => ({
        propertyId: P,
        roomTypeId: typeId,
        stayDate: utcMidnight(n),
        physical: count,
      })),
    });
  }
  await prisma.inventoryDay.createMany({
    data: nights.map((n) => ({
      propertyId: B.propertyId,
      roomTypeId: B.categoryA,
      stayDate: utcMidnight(n),
      physical: 1,
    })),
  });

  // Plans: a public BAR on A; a corporate plan on B only (B is never sold online).
  const mkPlan = (code, kind, propertyId = P, admin = A.users.admin.id) =>
    prisma.ratePlan.create({
      data: {
        propertyId,
        code,
        name: `ZZ ${code} ${run}`,
        kind,
        currency: 'INR',
        createdByUserId: admin,
      },
      select: { id: true, name: true },
    });
  const bar = await mkPlan(`BAR${run}`, 'STANDARD');
  await prisma.ratePlanRoomType.create({
    data: { propertyId: P, ratePlanId: bar.id, roomTypeId: A.categoryA, defaultRateMinor: 500000 },
  });
  const corp = await mkPlan(`CORP${run}`, 'CORPORATE');
  await prisma.ratePlanRoomType.create({
    data: { propertyId: P, ratePlanId: corp.id, roomTypeId: A.categoryB, defaultRateMinor: 400000 },
  });
  h.note(`slugA=${slugA} slugB=${slugB} C=${catC.id} BAR=${bar.id} CORP=${corp.id}`);

  /** inventory_day.sold must equal live reservation_room rows, per date AND per category. */
  const consistent = async () => {
    const rows = await prisma.$queryRaw`
      SELECT i."roomTypeId"::text AS t, to_char(i."stayDate", 'YYYY-MM-DD') AS d, i."sold" AS sold,
             (SELECT count(*)::int FROM "reservation_room" rr JOIN "reservation" r ON r."id" = rr."reservationId"
               WHERE rr."propertyId" = i."propertyId" AND rr."roomTypeId" = i."roomTypeId"
                 AND rr."arrivalDate" <= i."stayDate" AND rr."departureDate" > i."stayDate"
                 AND r."status"::text IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')) AS live
        FROM "inventory_day" i WHERE i."propertyId" = ${P}::uuid`;
    const bad = rows.filter((r) => r.sold !== r.live);
    return { ok: bad.length === 0, bad: bad.slice(0, 4), sold: rows };
  };
  const soldOn = async (typeId, date) =>
    (
      await prisma.inventoryDay.findFirst({
        where: { propertyId: P, roomTypeId: typeId, stayDate: utcMidnight(date) },
        select: { sold: true },
      })
    ).sold;

  /* -------------------------------------------------------------- 1 */
  console.log('1. BE-05: the slug, resolved on the server.');
  const profile = await pub('GET', `/${slugA}`);
  h.check(
    'the hotel by slug, no session: 200',
    profile.status === 200 && profile.payload?.slug === slugA && profile.payload?.today === A.today,
    show(profile),
  );
  h.check(
    'profile lists the categories',
    profile.payload?.roomTypes?.length === 3,
    JSON.stringify(profile.payload?.roomTypes?.map((t) => t.name)),
  );
  h.check('an unknown slug: 404', (await pub('GET', '/zz-no-such-hotel-anywhere')).status === 404);
  h.check('a malformed slug: 404', (await pub('GET', '/..%2Fadmin')).status === 404);
  await prisma.property.update({ where: { id: B.propertyId }, data: { status: 'INACTIVE' } });
  h.check('an inactive hotel: 404 (no hint why)', (await pub('GET', `/${slugB}`)).status === 404);
  await prisma.property.update({ where: { id: B.propertyId }, data: { status: 'ACTIVE' } });
  const spoof = await pub('GET', `/${slugA}`, undefined, {
    headers: { 'x-property-id': B.propertyId, 'x-hotel-id': B.propertyCode },
  });
  h.check(
    'a header naming another property changes nothing',
    spoof.payload?.slug === slugA && spoof.payload?.roomTypes?.length === 3,
    show(spoof),
  );

  /* -------------------------------------------------------------- 2 */
  console.log('2. AV-08: search.');
  const q = (arrival, departure, adults = 2, children = 0) =>
    `/${slugA}/availability?arrivalDate=${arrival}&departureDate=${departure}&adults=${String(adults)}&children=${String(children)}`;
  const search = await pub('GET', q(D, shiftDays(D, 2)));
  const roomNames = (res) => (res.payload?.rooms ?? []).map((r) => r.roomTypeId);
  const offerA = search.payload?.rooms?.find((r) => r.roomTypeId === A.categoryA);
  h.check(
    '200 with category A (public plan) and C (rack), not B (corporate only)',
    search.status === 200 &&
      roomNames(search).includes(A.categoryA) &&
      roomNames(search).includes(catC.id) &&
      !roomNames(search).includes(A.categoryB),
    show(search),
  );
  h.check(
    'A offered on the public plan, rooms left 2',
    offerA?.offers?.[0]?.ratePlanId === bar.id && offerA?.roomsLeft === 2,
    JSON.stringify(offerA),
  );
  h.check(
    'C offered at its standard rate',
    search.payload?.rooms?.find((r) => r.roomTypeId === catC.id)?.offers?.[0]?.ratePlanId === null,
  );
  h.check(
    'price: 2 nights at 5000 plus tax, in minor units',
    offerA?.offers?.[0]?.exTaxMinor === 1_000_000 &&
      offerA.offers[0].totalMinor === offerA.offers[0].exTaxMinor + offerA.offers[0].taxMinor,
    JSON.stringify(offerA?.offers?.[0]),
  );
  h.check(
    'a party of 3 fits nothing',
    (await pub('GET', q(D, shiftDays(D, 2), 3))).payload?.rooms?.length === 0,
  );
  h.check(
    'a past arrival: refused',
    [400, 422].includes((await pub('GET', q(shiftDays(A.today, -1), A.today))).status),
  );
  h.check(
    '31 nights: refused',
    [400, 422].includes((await pub('GET', q(D, shiftDays(D, 31)))).status),
  );
  h.check(
    'no inventory rows for the nights: nothing offered',
    (await pub('GET', q(shiftDays(D, 40), shiftDays(D, 41)))).payload?.rooms?.length === 0,
  );

  /* -------------------------------------------------------------- 3 */
  console.log('3. Quote: the price, signed and held.');
  const quoteA = (arrival, departure, extra = {}) =>
    pub('POST', `/${slugA}/quotes`, {
      roomTypeId: A.categoryA,
      ratePlanId: bar.id,
      arrivalDate: arrival,
      departureDate: departure,
      adults: 2,
      children: 0,
      ...extra,
    });
  const q1 = await quoteA(D, shiftDays(D, 2));
  h.check(
    'quote: 200, token, the searched price',
    q1.status === 200 &&
      typeof q1.payload?.quoteToken === 'string' &&
      q1.payload?.totalMinor === offerA?.offers?.[0]?.totalMinor,
    show(q1),
  );
  h.check(
    'held for 15 minutes',
    Math.abs(Date.parse(q1.payload?.expiresAt) - Date.now() - 15 * 60_000) < 60_000,
    q1.payload?.expiresAt,
  );
  const corpQuote = await pub('POST', `/${slugA}/quotes`, {
    roomTypeId: A.categoryB,
    ratePlanId: corp.id,
    arrivalDate: D,
    departureDate: shiftDays(D, 1),
    adults: 1,
    children: 0,
  });
  h.check(
    'a corporate plan cannot be quoted publicly: 404',
    corpQuote.status === 404,
    show(corpQuote),
  );
  const rackOnPlanned = await quoteA(D, shiftDays(D, 1), { ratePlanId: null });
  h.check(
    'the rack rate is not offered where a plan prices the room',
    [400, 422].includes(rackOnPlanned.status),
    show(rackOnPlanned),
  );

  /* -------------------------------------------------------------- 4 */
  console.log('4. Book, pay at hotel.');
  // Price changes after quoting; the held price stands.
  await prisma.ratePlanRoomType.updateMany({
    where: { propertyId: P, ratePlanId: bar.id, roomTypeId: A.categoryA },
    data: { defaultRateMinor: 900000 },
  });
  const book1 = await pub('POST', `/${slugA}/bookings`, {
    quoteToken: q1.payload.quoteToken,
    guest: guest(1),
    specialRequests: 'High floor',
    paymentChoice: 'PAY_AT_HOTEL',
  });
  h.check(
    'booked: 201, CONFIRMED, at the held price despite the rate change',
    book1.status === 201 &&
      book1.payload?.status === 'CONFIRMED' &&
      book1.payload?.totalMinor === q1.payload.totalMinor,
    show(book1),
  );
  await prisma.ratePlanRoomType.updateMany({
    where: { propertyId: P, ratePlanId: bar.id, roomTypeId: A.categoryA },
    data: { defaultRateMinor: 500000 },
  });
  const res1 = await prisma.reservation.findFirst({
    where: { propertyId: P, confirmationCode: book1.payload?.bookingCode ?? '' },
    select: {
      id: true,
      source: true,
      ratePlanId: true,
      totalAmountMinor: true,
      notes: true,
      guestEmail: true,
    },
  });
  h.check(
    'stored as DIRECT_WEB on the plan, with the request noted',
    res1?.source === 'DIRECT_WEB' &&
      res1.ratePlanId === bar.id &&
      res1.totalAmountMinor === q1.payload.totalMinor &&
      (res1.notes ?? '').includes('High floor'),
    JSON.stringify(res1),
  );
  const online1 = await prisma.onlineBooking.findFirst({
    where: { propertyId: P, reservationId: res1?.id },
    select: { paymentChoice: true, quoteId: true },
  });
  h.check(
    'online booking recorded with its quote and choice',
    online1?.paymentChoice === 'PAY_AT_HOTEL' &&
      online1.quoteId === decode(q1.payload.quoteToken).quoteId,
    JSON.stringify(online1),
  );
  const audit1 = await prisma.auditLog.findFirst({
    where: { propertyId: P, event: 'RESERVATION_BOOKED_ONLINE', entityId: res1?.id },
    select: { actorUserId: true },
  });
  h.check(
    'audited in the same transaction, with no staff actor',
    audit1 !== null && audit1.actorUserId === null,
  );
  const email1 = await prisma.outboxEvent.count({
    where: {
      propertyId: P,
      eventType: 'RESERVATION_CONFIRMATION_EMAIL',
      dedupeKey: `reservation-confirmation:${res1?.id}`,
    },
  });
  h.check('the confirmation email is queued (outbox)', email1 === 1, String(email1));
  h.check(
    'sold +1 on each night of A only',
    (await soldOn(A.categoryA, D)) === 1 &&
      (await soldOn(A.categoryA, shiftDays(D, 1))) === 1 &&
      (await soldOn(A.categoryA, shiftDays(D, 2))) === 0,
  );
  h.check('counters agree with live rows, per date and category', (await consistent()).ok);

  /* -------------------------------------------------------------- 5 */
  console.log('5. Guest access to the booking.');
  const code1 = book1.payload.bookingCode;
  const access1 = book1.payload.accessToken;
  const view = await pub('GET', `/${slugA}/bookings/${code1}?access=${access1}`);
  h.check(
    'with its access token: 200, balance = total',
    view.status === 200 && view.payload?.balanceMinor === q1.payload.totalMinor,
    show(view),
  );
  h.check(
    'a wrong token: 404, not 403',
    (await pub('GET', `/${slugA}/bookings/${code1}?access=${'x'.repeat(43)}`)).status === 404,
  );
  h.check(
    "another hotel's slug: 404",
    (await pub('GET', `/${slugB}/bookings/${code1}?access=${access1}`)).status === 404,
  );

  /* -------------------------------------------------------------- 6 */
  console.log('6. One booking per quote.');
  const again = await pub('POST', `/${slugA}/bookings`, {
    quoteToken: q1.payload.quoteToken,
    guest: guest(1),
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  h.check(
    'the same quote again: the first booking, replayed',
    again.status === 201 &&
      again.payload?.bookingCode === code1 &&
      again.payload?.replayed === true,
    show(again),
  );
  const q2 = await quoteA(D, shiftDays(D, 2));
  const burst = await Promise.all(
    Array.from({ length: 6 }, () =>
      pub('POST', `/${slugA}/bookings`, {
        quoteToken: q2.payload.quoteToken,
        guest: guest(2),
        specialRequests: null,
        paymentChoice: 'PAY_AT_HOTEL',
      }),
    ),
  );
  const codes = new Set(burst.map((r) => r.payload?.bookingCode));
  h.check(
    '6 parallel submits of one quote: all 201, one booking code',
    burst.every((r) => r.status === 201) && codes.size === 1,
    burst.map((r) => `${String(r.status)}:${String(r.payload?.bookingCode)}`).join(' '),
  );
  h.check(
    'exactly one reservation for that quote',
    (await prisma.onlineBooking.count({
      where: { propertyId: P, quoteId: decode(q2.payload.quoteToken).quoteId },
    })) === 1,
  );
  h.check(
    'A now sold out on those nights (2 of 2), counters consistent',
    (await soldOn(A.categoryA, D)) === 2 && (await consistent()).ok,
  );

  /* -------------------------------------------------------------- 7 */
  console.log('7. AV-09: search is cached; quote and book read live.');
  const cacheProbe = q(shiftDays(D, 3), shiftDays(D, 4));
  const before = await pub('GET', cacheProbe);
  const qCache = await quoteA(shiftDays(D, 3), shiftDays(D, 4));
  const qCache2 = await quoteA(shiftDays(D, 3), shiftDays(D, 4));
  await pub('POST', `/${slugA}/bookings`, {
    quoteToken: qCache.payload.quoteToken,
    guest: guest(3),
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  await pub('POST', `/${slugA}/bookings`, {
    quoteToken: qCache2.payload.quoteToken,
    guest: guest(4),
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  const after = await pub('GET', cacheProbe);
  h.check(
    'the repeated search is the cached answer (still shows A)',
    roomNames(before).includes(A.categoryA) &&
      JSON.stringify(after.payload) === JSON.stringify(before.payload),
    `${JSON.stringify(roomNames(before))} -> ${JSON.stringify(roomNames(after))}`,
  );
  const fresh = await pub('GET', q(shiftDays(D, 3), shiftDays(D, 4), 1));
  h.check(
    'an uncached search sees A sold out',
    fresh.status === 200 && !roomNames(fresh).includes(A.categoryA),
    JSON.stringify(roomNames(fresh)),
  );
  const liveQuote = await quoteA(shiftDays(D, 3), shiftDays(D, 4));
  h.check(
    'a quote reads live inventory: 409 ROOM_UNAVAILABLE',
    liveQuote.status === 409 && liveQuote.payload?.code === 'ROOM_UNAVAILABLE',
    show(liveQuote),
  );

  /* -------------------------------------------------------------- 8 */
  console.log('8. Refused quotes write nothing.');
  const q3 = await quoteA(shiftDays(D, 6), shiftDays(D, 7));
  const p3 = decode(q3.payload.quoteToken);
  const reservationsBefore = await prisma.reservation.count({ where: { propertyId: P } });
  const cheaper = { ...p3, quote: { ...p3.quote, totalMinor: 100 } };
  const forged = `${Buffer.from(JSON.stringify(cheaper)).toString('base64url')}.${q3.payload.quoteToken.split('.').pop()}`;
  const tamper = await pub('POST', `/${slugA}/bookings`, {
    quoteToken: forged,
    guest: guest(5),
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  h.check(
    'a lowered price: refused',
    [400, 422].includes(tamper.status) && JSON.stringify(tamper.payload).includes('quoteToken'),
    show(tamper),
  );
  const expired = await pub('POST', `/${slugA}/bookings`, {
    quoteToken: resign({ ...p3, expiresAt: Date.now() - 1000 }),
    guest: guest(5),
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  h.check(
    'an expired hold: refused, says expired',
    [400, 422].includes(expired.status) && JSON.stringify(expired.payload).includes('expired'),
    show(expired),
  );
  const crossSite = await pub('POST', `/${slugB}/bookings`, {
    quoteToken: q3.payload.quoteToken,
    guest: guest(5),
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  h.check(
    "hotel A's quote at hotel B: refused",
    [400, 422].includes(crossSite.status),
    show(crossSite),
  );
  h.check(
    'nothing written by any of them',
    (await prisma.reservation.count({ where: { propertyId: P } })) === reservationsBefore &&
      (await prisma.reservation.count({ where: { propertyId: B.propertyId } })) === 0,
  );
  const badGuest = await pub('POST', `/${slugA}/bookings`, {
    quoteToken: q3.payload.quoteToken,
    guest: { ...guest(5), email: 'not-an-email' },
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  h.check('a malformed email: 400', badGuest.status === 400, show(badGuest));

  /* -------------------------------------------------------------- 9 */
  console.log('9. Eight guests race for the last room (CLAUDE.md 3.1).');
  const lastNight = shiftDays(D, 10);
  const racers = await Promise.all(
    Array.from({ length: 8 }, () =>
      pub('POST', `/${slugA}/quotes`, {
        roomTypeId: catC.id,
        ratePlanId: null,
        arrivalDate: lastNight,
        departureDate: shiftDays(lastNight, 1),
        adults: 2,
        children: 0,
      }),
    ),
  );
  h.check(
    '8 quotes for the last C room, all held',
    racers.every((r) => r.status === 200),
    racers.map((r) => r.status).join(','),
  );
  const race = await Promise.all(
    racers.map((r, i) =>
      pub('POST', `/${slugA}/bookings`, {
        quoteToken: r.payload.quoteToken,
        guest: guest(10 + i),
        specialRequests: null,
        paymentChoice: 'PAY_AT_HOTEL',
      }),
    ),
  );
  const won = race.filter((r) => r.status === 201);
  const lost = race.filter((r) => r.status === 409 && r.payload?.code === 'ROOM_UNAVAILABLE');
  h.check(
    'exactly one booking wins; seven get 409 ROOM_UNAVAILABLE; no 500',
    won.length === 1 && lost.length === 7,
    race.map((r) => `${String(r.status)}:${String(r.payload?.code ?? '')}`).join(' '),
  );
  h.check(
    'C sold exactly 1 on that night; counters consistent per date and category',
    (await soldOn(catC.id, lastNight)) === 1 && (await consistent()).ok,
    JSON.stringify((await consistent()).bad),
  );

  /* ------------------------------------------------------------- 10 */
  console.log('10. The overbooking allowance is not sold publicly.');
  await prisma.roomType.update({ where: { id: catC.id }, data: { overbookingAllowance: 1 } });
  const withAllowance = await pub('GET', q(lastNight, shiftDays(lastNight, 1), 1));
  h.check(
    'search does not offer the allowance',
    !roomNames(withAllowance).includes(catC.id),
    JSON.stringify(roomNames(withAllowance)),
  );
  const allowanceQuote = await pub('POST', `/${slugA}/quotes`, {
    roomTypeId: catC.id,
    ratePlanId: null,
    arrivalDate: lastNight,
    departureDate: shiftDays(lastNight, 1),
    adults: 1,
    children: 0,
  });
  h.check('quote refuses it: 409', allowanceQuote.status === 409, show(allowanceQuote));
  const lateBook = await pub('POST', `/${slugA}/bookings`, {
    // A losing racer's held quote: valid, unexpired, never booked.
    quoteToken: resign({ ...decode(racers[1].payload.quoteToken), quoteId: randomUUID() }),
    guest: guest(30),
    specialRequests: null,
    paymentChoice: 'PAY_AT_HOTEL',
  });
  h.check(
    'a valid held quote still cannot book into it: 409, sold stays 1',
    lateBook.status === 409 && (await soldOn(catC.id, lastNight)) === 1,
    show(lateBook),
  );
  await prisma.roomType.update({ where: { id: catC.id }, data: { overbookingAllowance: 0 } });

  /* ------------------------------------------------------------- 11 */
  console.log('11. BE-04: pay now.');
  const q4 = await quoteA(shiftDays(D, 12), shiftDays(D, 14));
  const noGateway = await pub('POST', `/${slugA}/bookings`, {
    quoteToken: q4.payload.quoteToken,
    guest: guest(40),
    specialRequests: null,
    paymentChoice: 'PAY_NOW',
  });
  h.check(
    'pay now without an active gateway: refused, nothing booked',
    [400, 422].includes(noGateway.status) &&
      (await prisma.onlineBooking.count({
        where: { propertyId: P, quoteId: decode(q4.payload.quoteToken).quoteId },
      })) === 0,
    show(noGateway),
  );
  const on = await h.call(
    'PUT',
    `/properties/${A.propertyCode}/payment-gateway`,
    A.users.admin.cookie,
    { status: 'ACTIVE' },
  );
  h.check('gateway switched on', on.status === 200, `HTTP ${String(on.status)}`);
  h.check(
    'profile now offers prepay',
    (await pub('GET', `/${slugA}`)).payload?.prepayAvailable === true,
  );
  const paid = await pub('POST', `/${slugA}/bookings`, {
    quoteToken: q4.payload.quoteToken,
    guest: guest(41),
    specialRequests: null,
    paymentChoice: 'PAY_NOW',
  });
  h.check(
    'pay now: booked and a link for the whole total',
    paid.status === 201 &&
      paid.payload?.paymentChoice === 'PAY_NOW' &&
      typeof paid.payload?.payment?.url === 'string' &&
      paid.payload.payment.amountMinor === q4.payload.totalMinor,
    show(paid),
  );
  const link = [...rzp.links.values()].at(-1);
  link.status = 'paid';
  link.amount_paid = q4.payload.totalMinor;
  link.payments = [
    {
      payment_id: `pay_be${run}`,
      amount: q4.payload.totalMinor,
      method: 'upi',
      status: 'captured',
      plink_id: link.id,
      created_at: 1,
      updated_at: 1,
    },
  ];
  const raw = JSON.stringify({
    entity: 'event',
    event: 'payment_link.paid',
    contains: ['payment_link'],
    payload: { payment_link: { entity: { id: link.id, status: 'paid', notes: link.notes } } },
    created_at: 1,
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const hook = () =>
    fetch(`${h.API}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      body: raw,
    });
  await Promise.all([hook(), hook(), hook()]);
  const paidView = await pub(
    'GET',
    `/${slugA}/bookings/${paid.payload.bookingCode}?access=${paid.payload.accessToken}`,
  );
  h.check(
    'captured once, though the webhook came three times: nothing owed',
    paidView.payload?.paidMinor === q4.payload.totalMinor && paidView.payload?.balanceMinor === 0,
    show(paidView),
  );
  const resPaid = await prisma.reservation.findFirst({
    where: { propertyId: P, confirmationCode: paid.payload.bookingCode },
    select: { folio: { select: { lines: { select: { kind: true, amountMinor: true } } } } },
  });
  h.check(
    'exactly one payment line on the folio',
    resPaid?.folio?.lines?.filter((l) => l.kind === 'PAYMENT').length === 1,
    JSON.stringify(resPaid?.folio?.lines),
  );
  const payAgain = await pub(
    'POST',
    `/${slugA}/bookings/${paid.payload.bookingCode}/pay?access=${paid.payload.accessToken}`,
  );
  h.check('pay again: nothing owed', [400, 422].includes(payAgain.status), show(payAgain));
  const laterPay = await pub('POST', `/${slugA}/bookings/${code1}/pay?access=${access1}`);
  h.check(
    'a pay-at-hotel guest may still pay online later',
    laterPay.status === 200 && typeof laterPay.payload?.payment?.url === 'string',
    show(laterPay),
  );

  /* ------------------------------------------------------------- 12 */
  console.log('12. Throttling.');
  const ip = '10.99.0.1';
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    statuses.push(
      (
        await pub(
          'POST',
          `/${slugA}/bookings`,
          {
            quoteToken: 'x'.repeat(40),
            guest: guest(50),
            specialRequests: null,
            paymentChoice: 'PAY_AT_HOTEL',
          },
          { ip },
        )
      ).status,
    );
  }
  h.check(
    'one address: bookings throttled after 10 (429)',
    statuses.slice(0, 10).every((s) => s === 400) && statuses.slice(10).every((s) => s === 429),
    statuses.join(','),
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
