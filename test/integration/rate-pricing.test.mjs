/**
 * Quotes and bookings priced from a rate plan, night by night (F9, P0-3).
 *
 * ===========================================================================
 * WHAT THIS PROVES, against a running API and a real PostgreSQL:
 *
 *   1. A quote with `ratePlanId` prices each night from the plan's calendar
 *      (override > season > weekday > weekend > default), and the quoted
 *      total equals the nightly rates plus each night's own tax, in integer
 *      minor units. A stay straddling a GST band is taxed per night.
 *   2. Without a plan the quote is the room type's rack rate, unchanged; an
 *      override wins over a plan for every night.
 *   3. A booking stores one `reservation_night` row per night matching the
 *      quote, and records the plan. Repricing the plan afterwards does not
 *      change what was sold.
 *   4. Check-in -- both instant and at the desk -- posts the ARRIVAL night's
 *      own price, not the stay average.
 *   5. The folio's scheduled nights show each night at its own price.
 *   6. An inactive or archived plan is refused 409 RATE_NOT_BOOKABLE; a plan
 *      not assigned to the room type, or another property's plan, is 404.
 *      No refusal writes anything.
 *
 * ISOLATION: suite-owned fixtures (prefix ZZRPR / ZZRPX), torn down here.
 * ===========================================================================
 */

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'rate pricing';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRPR',
  slugPrefix: 'zz-rpr-',
  emailDomain: 'rpr.invalid',
  prisma,
});

const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZRPX',
  slugPrefix: 'zz-rpx-',
  emailDomain: 'rpx.invalid',
  prisma,
});

const WINDOW_NIGHTS = 21;
/** Statutory GST bands: 0 below 1,000; 5% to 7,500; 18% above (minor units). */
const gstPercent = (rateMinor) => (rateMinor < 100000 ? 0 : rateMinor < 750000 ? 5 : 18);
const taxOf = (rateMinor) => Math.round((rateMinor * gstPercent(rateMinor)) / 100);
const dow = (iso) => new Date(`${iso}T12:00:00.000Z`).getUTCDay();

let fixture;

async function body() {
  console.log('\n════ rate pricing (F9) ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded(['/properties/ZZRPR-PROBE/rate-plans']);
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

  await prisma.inventoryDay.createMany({
    data: Array.from({ length: WINDOW_NIGHTS }, (_, i) => shiftDays(fixture.today, i)).flatMap(
      (night) => [
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
      ],
    ),
  });

  const base = `/properties/${fixture.propertyCode}`;
  const clerk = fixture.users.clerk.cookie;
  const revenue = fixture.users.revenue.cookie;
  const today = fixture.today;

  // Next Monday, so the weekday of each night is known. Mon = d(0).
  const toMonday = (8 - dow(today)) % 7 || 7;
  const monday = shiftDays(today, toMonday);
  const d = (i) => shiftDays(monday, i);

  /* ------------------------------------------------------------ setup */
  // Plan BAR: A default 7,000 (5%), weekend 8,000 (18%); Friday overridden to 6,500.
  const plan = await h.call('POST', `${base}/rate-plans`, revenue, {
    code: 'BAR',
    name: 'Best available',
    roomTypes: [
      { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 700000, currency: 'INR' } },
    ],
  });
  if (plan.status !== 201) throw new Error(`plan setup failed: ${String(plan.status)}`);
  const planId = plan.payload.id;
  const weekend = await h.call('POST', `${base}/rate-plans/${planId}/pricing-rules`, revenue, {
    kind: 'WEEKEND',
    name: 'Weekend',
    prices: [{ roomTypeId: fixture.categoryA, amountMinor: 800000 }],
  });
  if (weekend.status !== 201) throw new Error(`rule setup failed: ${String(weekend.status)}`);
  const override = await h.call('PUT', `${base}/rate-plans/${planId}/calendar`, revenue, {
    roomTypeId: fixture.categoryA,
    entries: [
      { stayDate: d(4), amountMinor: 650000 },
      // Today is distinctive so an average can never pass for it (section 4).
      { stayDate: today, amountMinor: 720000 },
    ],
  });
  if (override.status !== 200) throw new Error(`override setup failed: ${String(override.status)}`);
  h.note(`plan BAR=${planId}; Thu ${d(3)} default, Fri ${d(4)} override, Sat ${d(5)} weekend`);

  const quote = (extra) =>
    h.call('POST', `${base}/reservations/quote`, clerk, {
      roomTypeId: fixture.categoryA,
      isTaxExempt: false,
      ...extra,
    });

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. A quote prices each night from the plan.');
  const expected = [
    { stayDate: d(3), rate: 700000, source: 'DEFAULT' },
    { stayDate: d(4), rate: 650000, source: 'DATE_OVERRIDE' },
    { stayDate: d(5), rate: 800000, source: 'WEEKEND' },
  ];
  {
    const res = await quote({ arrivalDate: d(3), departureDate: d(6), ratePlanId: planId });
    h.check(
      'quote: 201 (POST)',
      res.status === 201,
      `HTTP ${String(res.status)} ${JSON.stringify(res.payload?.details ?? '')}`,
    );
    const q = res.payload;
    h.check('three nights', q?.nights === 3 && q?.nightly?.length === 3);
    for (const [i, want] of expected.entries()) {
      const line = q?.nightly?.[i];
      h.check(
        `${want.stayDate}: ${want.source} ${String(want.rate)} taxed ${String(gstPercent(want.rate))}%`,
        line?.stayDate === want.stayDate &&
          line?.rateSource === want.source &&
          line?.nightlyRateMinor === want.rate &&
          line?.taxRatePercent === gstPercent(want.rate) &&
          line?.taxMinor === taxOf(want.rate),
        JSON.stringify(line),
      );
    }
    const exTax = expected.reduce((s, n) => s + n.rate, 0);
    const tax = expected.reduce((s, n) => s + taxOf(n.rate), 0);
    h.check(`ex-tax = ${String(exTax)}`, q?.exTaxMinor === exTax, `got ${String(q?.exTaxMinor)}`);
    h.check(
      `tax = ${String(tax)} (per-night bands, not one band)`,
      q?.taxMinor === tax,
      `got ${String(q?.taxMinor)}`,
    );
    h.check(`total = ${String(exTax + tax)}`, q?.totalMinor === exTax + tax);
    h.check(
      'total equals the sum of the nightly lines exactly',
      q?.totalMinor === q?.nightly?.reduce((s, n) => s + n.nightlyRateMinor + n.taxMinor, 0),
    );
    h.check(
      'every figure is an integer',
      [q?.exTaxMinor, q?.taxMinor, q?.totalMinor].every(Number.isInteger),
    );
    h.check(
      'flagged as varying, naming the plan',
      q?.isRateVarying === true && q?.ratePlanId === planId && q?.ratePlanCode === 'BAR',
    );
  }

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. No plan, and a plan with an override.');
  {
    const rack = await quote({ arrivalDate: d(3), departureDate: d(6) });
    h.check(
      'without a plan: the rack rate 500000 every night',
      rack.status === 201 &&
        rack.payload?.nightly?.every(
          (n) => n.nightlyRateMinor === 500000 && n.rateSource === 'RACK',
        ),
    );
    h.check(
      'not varying, no plan',
      rack.payload?.isRateVarying === false && rack.payload?.ratePlanId === null,
    );

    const manual = await quote({
      arrivalDate: d(3),
      departureDate: d(6),
      ratePlanId: planId,
      overrideNightlyRateMinor: 600000,
    });
    h.check(
      'an override wins over the plan for every night',
      manual.status === 201 &&
        manual.payload?.nightly?.every(
          (n) => n.nightlyRateMinor === 600000 && n.rateSource === 'MANUAL',
        ),
    );
    h.check('and the quote names no plan', manual.payload?.ratePlanId === null);
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. A booking stores what each night was sold for.');
  let bookingId;
  {
    const res = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      roomId: null,
      arrivalDate: d(3),
      departureDate: d(6),
      adults: 2,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Rate', lastName: 'Fixture' }],
      isInstantCheckIn: false,
      ratePlanId: planId,
    });
    h.check(
      'booking: 201',
      res.status === 201,
      `HTTP ${String(res.status)} ${JSON.stringify(res.payload?.details ?? '')}`,
    );
    bookingId = res.payload?.id;
    const exTax = expected.reduce((s, n) => s + n.rate, 0);
    const tax = expected.reduce((s, n) => s + taxOf(n.rate), 0);

    const reservation = await prisma.reservation.findFirst({
      where: { id: bookingId, propertyId: fixture.propertyId },
      select: { ratePlanId: true, totalAmountMinor: true, taxAmountMinor: true },
    });
    h.check('the plan is recorded on the reservation', reservation?.ratePlanId === planId);
    h.check(
      'stored totals equal the quote',
      reservation?.totalAmountMinor === exTax + tax && reservation?.taxAmountMinor === tax,
    );

    const nights = await prisma.reservationNight.findMany({
      where: { propertyId: fixture.propertyId, reservationId: bookingId },
      orderBy: { stayDate: 'asc' },
      select: {
        stayDate: true,
        rateMinor: true,
        taxMinor: true,
        taxRatePercent: true,
        rateSource: true,
      },
    });
    h.check('one reservation_night row per night', nights.length === 3);
    for (const [i, want] of expected.entries()) {
      const row = nights[i];
      h.check(
        `stored ${want.stayDate}: ${String(want.rate)} + ${String(taxOf(want.rate))}`,
        row?.stayDate.toISOString().slice(0, 10) === want.stayDate &&
          row?.rateMinor === want.rate &&
          row?.taxMinor === taxOf(want.rate) &&
          Number(row?.taxRatePercent) === gstPercent(want.rate) &&
          row?.rateSource === want.source,
      );
    }
    h.check(
      'nights sum to the stored total',
      nights.reduce((s, n) => s + n.rateMinor + n.taxMinor, 0) === reservation?.totalAmountMinor,
    );

    // Reprice Thursday after the sale: the booking must not move.
    await h.call('PUT', `${base}/rate-plans/${planId}/calendar`, revenue, {
      roomTypeId: fixture.categoryA,
      entries: [{ stayDate: d(3), amountMinor: 990000 }],
    });
    const after = await prisma.reservationNight.findFirst({
      where: {
        propertyId: fixture.propertyId,
        reservationId: bookingId,
        stayDate: utcMidnight(d(3)),
      },
      select: { rateMinor: true },
    });
    h.check('repricing the plan later does not change the sold night', after?.rateMinor === 700000);
    const requote = await quote({ arrivalDate: d(3), departureDate: d(4), ratePlanId: planId });
    h.check('while a new quote sees the new price', requote.payload?.nightlyRateMinor === 990000);

    const rack = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryB,
      roomId: null,
      arrivalDate: d(7),
      departureDate: d(9),
      adults: 2,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Rack', lastName: 'Fixture' }],
      isInstantCheckIn: false,
    });
    h.check('a rack-rate booking still works: 201', rack.status === 201);
    const rackNights = await prisma.reservationNight.findMany({
      where: { propertyId: fixture.propertyId, reservationId: rack.payload?.id },
      select: { rateMinor: true, rateSource: true },
    });
    h.check(
      'and stores RACK nights at the base rate',
      rackNights.length === 2 &&
        rackNights.every((n) => n.rateMinor === 400000 && n.rateSource === 'RACK'),
    );
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Check-in posts the arrival night, not the average.');
  const arrivalRate = 720000; // today's override
  const secondRate =
    dow(shiftDays(today, 1)) === 0 || dow(shiftDays(today, 1)) === 6 ? 800000 : 700000;
  h.note(`today ${today} priced ${String(arrivalRate)}, tomorrow ${String(secondRate)}`);

  const roomCharge = async (reservationId) => {
    const folio = await prisma.folio.findFirst({
      where: { propertyId: fixture.propertyId, reservationId },
      select: { id: true },
    });
    if (folio === null) return null;
    const lines = await prisma.folioLine.findMany({
      where: {
        propertyId: fixture.propertyId,
        folioId: folio.id,
        kind: { in: ['ROOM_CHARGE', 'TAX'] },
      },
      select: { kind: true, amountMinor: true },
    });
    return {
      charge: lines.filter((l) => l.kind === 'ROOM_CHARGE').reduce((s, l) => s + l.amountMinor, 0),
      tax: lines.filter((l) => l.kind === 'TAX').reduce((s, l) => s + l.amountMinor, 0),
    };
  };
  {
    const instant = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A1.id,
      arrivalDate: today,
      departureDate: shiftDays(today, 2),
      adults: 2,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [
        {
          firstName: 'Instant',
          lastName: 'Fixture',
          govtIdType: 'PASSPORT',
          govtIdNumber: 'P1234567',
        },
      ],
      isInstantCheckIn: true,
      ratePlanId: planId,
    });
    h.check(
      'instant check-in booking: 201',
      instant.status === 201,
      `HTTP ${String(instant.status)} ${JSON.stringify(instant.payload?.details ?? instant.payload?.message ?? '')}`,
    );
    const posted = await roomCharge(instant.payload?.id);
    h.check(
      `instant check-in posts ${String(arrivalRate)} + ${String(taxOf(arrivalRate))}`,
      posted?.charge === arrivalRate && posted?.tax === taxOf(arrivalRate),
      JSON.stringify(posted),
    );
    h.check(
      'which is not the stay average',
      posted?.charge !== Math.round((arrivalRate + secondRate) / 2),
    );

    const desk = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      roomId: fixture.rooms.A2.id,
      arrivalDate: today,
      departureDate: shiftDays(today, 2),
      adults: 2,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [
        {
          firstName: 'Desk',
          lastName: 'Fixture',
          govtIdType: 'PASSPORT',
          govtIdNumber: 'P7654321',
        },
      ],
      isInstantCheckIn: false,
      ratePlanId: planId,
    });
    h.check('desk booking: 201', desk.status === 201);
    const checkIn = await h.call(
      'POST',
      `${base}/reservations/${desk.payload?.id}/check-in`,
      clerk,
      {
        roomId: fixture.rooms.A2.id,
        primaryGuestIdType: 'PASSPORT',
        primaryGuestIdNumber: 'P7654321',
        acknowledgeRoomNotClean: true,
      },
    );
    h.check(
      'desk check-in: 200/201',
      checkIn.status === 200 || checkIn.status === 201,
      `HTTP ${String(checkIn.status)} ${JSON.stringify(checkIn.payload?.details ?? checkIn.payload?.message ?? '')}`,
    );
    const deskPosted = await roomCharge(desk.payload?.id);
    h.check(
      `desk check-in posts the stored arrival night ${String(arrivalRate)} + ${String(taxOf(arrivalRate))}`,
      deskPosted?.charge === arrivalRate && deskPosted?.tax === taxOf(arrivalRate),
      JSON.stringify(deskPosted),
    );

    /* ------------------------------------------------------------ 5 */
    console.log('\n5. The folio schedules each remaining night at its own price.');
    const code = desk.payload?.bookingCode;
    const folio = await h.call('GET', `${base}/folios/by-booking/${code}`, clerk);
    h.check('folio: 200', folio.status === 200, `HTTP ${String(folio.status)}`);
    const tomorrow = shiftDays(today, 1);
    const scheduled = folio.payload?.transactions?.find(
      (t) => t.isPosted === false && t.kind === 'ROOM_CHARGE' && t.date === tomorrow,
    );
    h.check(
      `tomorrow is scheduled at ${String(secondRate)} + ${String(taxOf(secondRate))}`,
      scheduled?.netMinor === secondRate && scheduled?.taxMinor === taxOf(secondRate),
      JSON.stringify(scheduled ?? null),
    );
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Refusals.');
  {
    const before = await prisma.reservation.count({ where: { propertyId: fixture.propertyId } });

    const notAssigned = await h.call('POST', `${base}/reservations/quote`, clerk, {
      roomTypeId: fixture.categoryB,
      arrivalDate: d(3),
      departureDate: d(4),
      ratePlanId: planId,
    });
    h.check(
      'a plan not assigned to the room type: 404',
      notAssigned.status === 404,
      `HTTP ${String(notAssigned.status)}`,
    );

    const malformed = await quote({ arrivalDate: d(3), departureDate: d(4), ratePlanId: 'nope' });
    h.check('a malformed plan id: 400', malformed.status === 400);

    const deactivate = await h.call('POST', `${base}/rate-plans/${planId}/status`, revenue, {
      action: 'DEACTIVATE',
    });
    h.check('deactivate the plan', deactivate.status === 200, `HTTP ${String(deactivate.status)}`);
    const inactive = await quote({ arrivalDate: d(3), departureDate: d(4), ratePlanId: planId });
    h.check(
      'an inactive plan: 409 RATE_NOT_BOOKABLE',
      inactive.status === 409 && inactive.payload?.code === 'RATE_NOT_BOOKABLE',
      `HTTP ${String(inactive.status)} ${String(inactive.payload?.code)}`,
    );
    const inactiveBook = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      arrivalDate: d(10),
      departureDate: d(11),
      adults: 2,
      guests: [{ firstName: 'No', lastName: 'Sale' }],
      ratePlanId: planId,
    });
    h.check('nor bookable: 409', inactiveBook.status === 409);

    await h.call('POST', `${base}/rate-plans/${planId}/status`, revenue, { action: 'ARCHIVE' });
    const archived = await quote({ arrivalDate: d(3), departureDate: d(4), ratePlanId: planId });
    h.check(
      'an archived plan: 409 RATE_NOT_BOOKABLE',
      archived.status === 409 && archived.payload?.code === 'RATE_NOT_BOOKABLE',
    );

    const foreign = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
    const theirPlan = await h.call(
      'POST',
      `/properties/${foreign.propertyCode}/rate-plans`,
      foreign.users.admin.cookie,
      {
        code: 'THEIRS',
        name: 'Theirs',
        roomTypes: [
          { roomTypeId: foreign.categoryA, defaultRate: { amountMinor: 100, currency: 'INR' } },
        ],
      },
    );
    h.check(
      'the other property has its own plan',
      theirPlan.status === 201,
      `HTTP ${String(theirPlan.status)}`,
    );
    const cross = await quote({
      arrivalDate: d(3),
      departureDate: d(4),
      ratePlanId: theirPlan.payload?.id,
    });
    h.check(
      "another property's plan: 404, never 403",
      cross.status === 404,
      `HTTP ${String(cross.status)}`,
    );
    const crossBook = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      arrivalDate: d(10),
      departureDate: d(11),
      adults: 2,
      guests: [{ firstName: 'Cross', lastName: 'Sale' }],
      ratePlanId: theirPlan.payload?.id,
    });
    h.check('nor bookable with it: 404', crossBook.status === 404);

    const afterCount = await prisma.reservation.count({
      where: { propertyId: fixture.propertyId },
    });
    h.check(
      'no refusal created a reservation',
      afterCount === before,
      `${String(before)} -> ${String(afterCount)}`,
    );
  }
}

await runSuite({
  harness: h,
  prisma,
  label: 'rate pricing integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
