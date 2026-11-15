/**
 * Occupancy pricing, promotions, stay restrictions and derived plans in
 * quotes and bookings (AV-06, AV-07, and the F9 follow-ups).
 *
 * ===========================================================================
 * WHAT THIS PROVES, against a running API and a real PostgreSQL:
 *
 *   1. Occupancy: extra adults/children are priced from the plan's occupancy
 *      configuration into each night, taxed with it, and stored; a party over
 *      capacity is refused.
 *   2. Promotions: an eligible promotion's discount is taken off each night;
 *      a booking redeems it atomically (redemption row + counter); N parallel
 *      bookings racing the LAST redemption -> exactly one succeeds; a promo
 *      code selects its promotion, and a code that does not apply is refused.
 *   3. Restrictions: MinLOS and closed-to-arrival on the arrival night,
 *      closed-to-departure on the departure date, each a typed 409 naming the
 *      rule; clearing them re-opens the stay; rack-rate stays are unaffected.
 *   4. Derived plans: each night is the parent's night adjusted, follows the
 *      parent when it is repriced, cannot hold its own prices, and refuses
 *      multi-level, self and uncovered-room-type links.
 *   5. Permissions, and another property's plans are not-found.
 *
 * ISOLATION: suite-owned fixtures (prefix ZZRBF / ZZRBY), torn down here.
 * ===========================================================================
 */

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'rate booking features';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRBF',
  slugPrefix: 'zz-rbf-',
  emailDomain: 'rbf.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZRBY',
  slugPrefix: 'zz-rby-',
  emailDomain: 'rby.invalid',
  prisma,
});

const WINDOW_NIGHTS = 40;
const gst = (rate) => (rate < 100000 ? 0 : rate < 750000 ? 5 : 18);
const taxOf = (rate) => Math.round((rate * gst(rate)) / 100);
const dow = (iso) => new Date(`${iso}T12:00:00.000Z`).getUTCDay();

async function body() {
  console.log('\n════ occupancy, promotions, restrictions, derived plans ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.assertRoutesAreLoaded([
    '/properties/ZZRBF-PROBE/rate-plans',
    '/properties/ZZRBF-PROBE/rate-plans/00000000-0000-4000-8000-000000000000/restrictions',
    '/properties/ZZRBF-PROBE/rate-plans/00000000-0000-4000-8000-000000000000/derivation',
  ]);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', revenue: 'REVENUE_MANAGER' },
    rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertOwnership(fixture, { types: 2, rooms: 1, grants: 3, stays: 0 });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);

  // Generous physical stock: this suite is about price, not availability.
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: WINDOW_NIGHTS }, (_, i) => shiftDays(fixture.today, i)).flatMap(
      (night) => [
        {
          propertyId: fixture.propertyId,
          roomTypeId: fixture.categoryA,
          stayDate: utcMidnight(night),
          physical: 20,
        },
        {
          propertyId: fixture.propertyId,
          roomTypeId: fixture.categoryB,
          stayDate: utcMidnight(night),
          physical: 20,
        },
      ],
    ),
  });

  const base = `/properties/${fixture.propertyCode}`;
  const { admin, clerk, revenue } = {
    admin: fixture.users.admin.cookie,
    clerk: fixture.users.clerk.cookie,
    revenue: fixture.users.revenue.cookie,
  };
  const toMonday = (8 - dow(fixture.today)) % 7 || 7;
  const monday = shiftDays(fixture.today, toMonday);
  const d = (i) => shiftDays(monday, i);

  const roomType = await h.call('PATCH', `${base}/room-types/${fixture.categoryA}`, admin, {
    maxGuests: 4,
  });
  if (roomType.status !== 200) throw new Error(`room type setup: ${String(roomType.status)}`);

  const plan = await h.call('POST', `${base}/rate-plans`, revenue, {
    code: 'BAR',
    name: 'Best available',
    roomTypes: [
      { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 500000, currency: 'INR' } },
    ],
  });
  if (plan.status !== 201) throw new Error(`plan setup: ${String(plan.status)}`);
  const barId = plan.payload.id;

  const quote = (extra) =>
    h.call('POST', `${base}/reservations/quote`, clerk, {
      roomTypeId: fixture.categoryA,
      isTaxExempt: false,
      ...extra,
    });
  const book = (extra) =>
    h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Feature', lastName: 'Fixture' }],
      isInstantCheckIn: false,
      adults: 2,
      ...extra,
    });

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Occupancy pricing prices bookings.');
  {
    const cfg = await h.call(
      'PATCH',
      `${base}/rate-plans/${barId}/room-types/${fixture.categoryA}/occupancy-pricing`,
      revenue,
      {
        enabled: true,
        baseOccupancy: 2,
        includedChildren: 0,
        adult: { kind: 'FIXED', value: 100000 },
        child: { kind: 'FIXED', value: 50000 },
      },
    );
    h.check('occupancy configured', cfg.status === 200, `HTTP ${String(cfg.status)}`);

    const q = await quote({
      arrivalDate: d(1),
      departureDate: d(3),
      ratePlanId: barId,
      adults: 3,
      children: 1,
    });
    h.check(
      'quote: 201',
      q.status === 201,
      `HTTP ${String(q.status)} ${JSON.stringify(q.payload?.details ?? '')}`,
    );
    const night = 500000 + 100000 + 50000;
    h.check(
      `each night = 500000 + 100000 + 50000 = ${String(night)}`,
      q.payload?.nightly?.every(
        (n) => n.nightlyRateMinor === night && n.extraGuestMinor === 150000,
      ),
      JSON.stringify(q.payload?.nightly?.[0]),
    );
    h.check(
      'taxed on the full night',
      q.payload?.nightly?.every((n) => n.taxMinor === taxOf(night)),
    );
    h.check('extra-guest total reported', q.payload?.extraGuestTotalMinor === 300000);
    h.check('total = 2 x (night + tax)', q.payload?.totalMinor === 2 * (night + taxOf(night)));

    const two = await quote({
      arrivalDate: d(1),
      departureDate: d(3),
      ratePlanId: barId,
      adults: 2,
    });
    h.check(
      'base occupancy pays no extra',
      two.payload?.nightly?.every((n) => n.nightlyRateMinor === 500000),
    );

    const res = await book({
      arrivalDate: d(1),
      departureDate: d(3),
      ratePlanId: barId,
      adults: 3,
      children: 1,
      guests: [
        { firstName: 'Big', lastName: 'Party' },
        { firstName: 'Second', lastName: 'Adult' },
        { firstName: 'Third', lastName: 'Adult' },
      ],
    });
    h.check(
      'booking: 201',
      res.status === 201,
      `HTTP ${String(res.status)} ${JSON.stringify(res.payload?.details ?? res.payload?.message ?? '')}`,
    );
    const stored = await prisma.reservationNight.findMany({
      where: { propertyId: fixture.propertyId, reservationId: res.payload?.id },
      select: { rateMinor: true },
    });
    h.check(
      'stored nights carry the extra-guest charge',
      stored.length === 2 && stored.every((n) => n.rateMinor === night),
    );

    const over = await quote({
      arrivalDate: d(1),
      departureDate: d(2),
      ratePlanId: barId,
      adults: 5,
    });
    h.check('over capacity is refused 400', over.status === 400, `HTTP ${String(over.status)}`);
  }

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Promotions price and redeem.');
  let autoId;
  {
    const auto = await h.call('POST', `${base}/promotions`, revenue, {
      name: 'Ten off',
      discount: { kind: 'PERCENT', value: 1000 },
      priority: 0,
      appliesToAllRatePlans: true,
      ratePlanIds: [],
      appliesToAllRoomTypes: true,
      roomTypeIds: [],
      maxRedemptions: 2,
    });
    h.check(
      'auto promotion: 201',
      auto.status === 201,
      `HTTP ${String(auto.status)} ${JSON.stringify(auto.payload?.details ?? '')}`,
    );
    autoId = auto.payload?.id;
    await h.call('PATCH', `${base}/promotions/${autoId}/status`, revenue, { action: 'ACTIVATE' });

    const coded = await h.call('POST', `${base}/promotions`, revenue, {
      name: 'Fifteen with code',
      discount: { kind: 'PERCENT', value: 1500 },
      priority: 10,
      appliesToAllRatePlans: true,
      ratePlanIds: [],
      appliesToAllRoomTypes: true,
      roomTypeIds: [],
    });
    const codedId = coded.payload?.id;
    await h.call('PATCH', `${base}/promotions/${codedId}/status`, revenue, { action: 'ACTIVATE' });
    const code = await h.call('POST', `${base}/promotions/${codedId}/codes`, revenue, {
      code: 'SAVE15',
    });
    h.check(
      'promo code created',
      code.status === 201,
      `HTTP ${String(code.status)} ${JSON.stringify(code.payload?.details ?? '')}`,
    );

    const q = await quote({ arrivalDate: d(4), departureDate: d(6), ratePlanId: barId, adults: 2 });
    h.check(
      'the eligible promotion is applied',
      q.payload?.promotion?.promotionId === autoId,
      JSON.stringify(q.payload?.promotion),
    );
    h.check(
      'each night is 10% off: 450000',
      q.payload?.nightly?.every((n) => n.nightlyRateMinor === 450000 && n.discountMinor === 50000),
    );
    h.check('discount total 100000', q.payload?.promotion?.discountTotalMinor === 100000);

    const withCode = await quote({
      arrivalDate: d(4),
      departureDate: d(6),
      ratePlanId: barId,
      adults: 2,
      promoCode: 'save15',
    });
    h.check(
      'a code selects its promotion (15%): 425000',
      withCode.payload?.promotion?.promoCodeId != null &&
        withCode.payload?.nightly?.every((n) => n.nightlyRateMinor === 425000),
      JSON.stringify(withCode.payload?.promotion),
    );
    const badCode = await quote({
      arrivalDate: d(4),
      departureDate: d(6),
      ratePlanId: barId,
      adults: 2,
      promoCode: 'NOPE',
    });
    h.check(
      'a code that does not apply is refused 400',
      badCode.status === 400,
      `HTTP ${String(badCode.status)}`,
    );
    const codeNoPlan = await quote({ arrivalDate: d(4), departureDate: d(6), promoCode: 'SAVE15' });
    h.check('a code without a plan is refused 400', codeNoPlan.status === 400);

    // Redemption 1 of 2.
    const first = await book({ arrivalDate: d(4), departureDate: d(6), ratePlanId: barId });
    h.check(
      'booking with the promotion: 201',
      first.status === 201,
      `HTTP ${String(first.status)}`,
    );
    const redemption = await prisma.promotionRedemption.findFirst({
      where: { propertyId: fixture.propertyId, reservationId: first.payload?.id },
      select: { promotionId: true, discountAppliedMinor: true },
    });
    h.check(
      'a redemption row records it',
      redemption?.promotionId === autoId && redemption?.discountAppliedMinor === 100000,
    );
    const count1 = await prisma.promotion.findFirst({
      where: { id: autoId },
      select: { redeemedCount: true },
    });
    h.check('counter = 1', count1?.redeemedCount === 1);

    // Race for the LAST redemption.
    const N = 4;
    const racers = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        book({ arrivalDate: d(7 + i), departureDate: d(8 + i), ratePlanId: barId }),
      ),
    );
    // A racer priced while one redemption remained either takes it or is
    // refused 409; a racer priced AFTER the winner committed sees no
    // promotion and books at full price. Both are correct. The invariant is
    // that exactly one racer got the discount and nothing was double-spent.
    const statuses = racers
      .map((r) => `${String(r.status)}:${String(r.payload?.code ?? '')}`)
      .join(',');
    h.check(
      'every racer either booked or was refused with a typed 409, never 500',
      racers.every(
        (r) => r.status === 201 || (r.status === 409 && r.payload?.code === 'RATE_NOT_BOOKABLE'),
      ),
      statuses,
    );
    const booked = racers.filter((r) => r.status === 201).map((r) => r.payload?.id);
    const discounted = await prisma.promotionRedemption.count({
      where: { propertyId: fixture.propertyId, reservationId: { in: booked } },
    });
    h.check(
      `exactly one of ${String(N)} racers took the last redemption`,
      discounted === 1,
      `${statuses}; redeemed ${String(discounted)}`,
    );
    const fullPrice = await prisma.reservationNight.findMany({
      where: { propertyId: fixture.propertyId, reservationId: { in: booked } },
      select: { reservationId: true, rateMinor: true },
    });
    const redeemedIds = new Set(
      (
        await prisma.promotionRedemption.findMany({
          where: { propertyId: fixture.propertyId, reservationId: { in: booked } },
          select: { reservationId: true },
        })
      ).map((row) => row.reservationId),
    );
    h.check(
      'the others that booked paid the full 500000, the winner 450000',
      fullPrice.every((n) => n.rateMinor === (redeemedIds.has(n.reservationId) ? 450000 : 500000)),
      JSON.stringify(fullPrice.map((n) => n.rateMinor)),
    );
    const count2 = await prisma.promotion.findFirst({
      where: { id: autoId },
      select: { redeemedCount: true, maxRedemptions: true },
    });
    const rows = await prisma.promotionRedemption.count({
      where: { propertyId: fixture.propertyId, promotionId: autoId },
    });
    h.check(
      'counter = max = 2, never more',
      count2?.redeemedCount === 2 && count2?.maxRedemptions === 2,
    );
    h.check('redemption rows = counter', rows === 2);

    const after = await quote({
      arrivalDate: d(12),
      departureDate: d(13),
      ratePlanId: barId,
      adults: 2,
    });
    h.check('once exhausted, a new quote carries no promotion', after.payload?.promotion === null);

    const codedBooking = await book({
      arrivalDate: d(12),
      departureDate: d(13),
      ratePlanId: barId,
      promoCode: 'SAVE15',
    });
    h.check('booking with a code: 201', codedBooking.status === 201);
    const codeRow = await prisma.promoCode.findFirst({
      where: { promotionId: codedId },
      select: { redeemedCount: true },
    });
    h.check('the code counter moved too', codeRow?.redeemedCount === 1);
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. Stay restrictions.');
  {
    const setR = (body) =>
      h.call('PUT', `${base}/rate-plans/${barId}/restrictions`, revenue, {
        roomTypeId: fixture.categoryA,
        ...body,
      });

    const minLos = await setR({
      fromDate: d(14),
      throughDate: d(14),
      minLos: 3,
      closedToArrival: false,
      closedToDeparture: false,
    });
    h.check(
      'MinLOS 3 set: 200',
      minLos.status === 200 && minLos.payload?.days?.[0]?.minLos === 3,
      `HTTP ${String(minLos.status)} ${JSON.stringify(minLos.payload?.details ?? '')}`,
    );
    const short = await quote({
      arrivalDate: d(14),
      departureDate: d(16),
      ratePlanId: barId,
      adults: 2,
    });
    h.check(
      'a 2-night stay arriving that day: 409 MIN_LOS',
      short.status === 409 &&
        short.payload?.code === 'RATE_NOT_BOOKABLE' &&
        short.payload?.details?.restriction === 'MIN_LOS',
      `HTTP ${String(short.status)} ${JSON.stringify(short.payload?.details ?? '')}`,
    );
    const shortBook = await book({ arrivalDate: d(14), departureDate: d(16), ratePlanId: barId });
    h.check('and the booking is refused too', shortBook.status === 409);
    h.check(
      '3 nights is fine',
      (await quote({ arrivalDate: d(14), departureDate: d(17), ratePlanId: barId, adults: 2 }))
        .status === 201,
    );
    h.check(
      'arriving the day before is unaffected',
      (await quote({ arrivalDate: d(13), departureDate: d(15), ratePlanId: barId, adults: 2 }))
        .status === 201,
    );

    await setR({
      fromDate: d(18),
      throughDate: d(18),
      minLos: null,
      closedToArrival: true,
      closedToDeparture: false,
    });
    const cta = await quote({
      arrivalDate: d(18),
      departureDate: d(19),
      ratePlanId: barId,
      adults: 2,
    });
    h.check(
      'closed to arrival: 409 CLOSED_TO_ARRIVAL',
      cta.status === 409 && cta.payload?.details?.restriction === 'CLOSED_TO_ARRIVAL',
    );
    h.check(
      'staying THROUGH a CTA night is fine',
      (await quote({ arrivalDate: d(17), departureDate: d(19), ratePlanId: barId, adults: 2 }))
        .status === 201,
    );

    await setR({
      fromDate: d(21),
      throughDate: d(21),
      minLos: null,
      closedToArrival: false,
      closedToDeparture: true,
    });
    const ctd = await quote({
      arrivalDate: d(20),
      departureDate: d(21),
      ratePlanId: barId,
      adults: 2,
    });
    h.check(
      'closed to departure: 409 CLOSED_TO_DEPARTURE',
      ctd.status === 409 && ctd.payload?.details?.restriction === 'CLOSED_TO_DEPARTURE',
    );
    h.check(
      'a rack-rate stay ignores plan restrictions',
      (await quote({ arrivalDate: d(20), departureDate: d(21), adults: 2 })).status === 201,
    );

    const clear = await setR({
      fromDate: d(14),
      throughDate: d(21),
      minLos: null,
      closedToArrival: false,
      closedToDeparture: false,
    });
    h.check(
      'clearing the range: 200, nothing left',
      clear.status === 200 && clear.payload?.days?.length === 0,
    );
    h.check(
      'the short stay is now allowed',
      (await quote({ arrivalDate: d(14), departureDate: d(16), ratePlanId: barId, adults: 2 }))
        .status === 201,
    );

    const clerkSet = await h.call('PUT', `${base}/rate-plans/${barId}/restrictions`, clerk, {
      roomTypeId: fixture.categoryA,
      fromDate: d(14),
      throughDate: d(14),
      minLos: 2,
      closedToArrival: false,
      closedToDeparture: false,
    });
    h.check('FRONT_DESK may NOT set restrictions: 403', clerkSet.status === 403);
    const audits = await prisma.auditLog.count({
      where: { propertyId: fixture.propertyId, event: 'RATE_RESTRICTIONS_SET' },
    });
    h.check('restriction writes are audited', audits === 4, `${String(audits)} rows`);
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Derived plans.');
  let corpId;
  {
    const corp = await h.call('POST', `${base}/rate-plans`, revenue, {
      code: 'CORP',
      name: 'Corporate',
      roomTypes: [
        { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 1, currency: 'INR' } },
      ],
    });
    corpId = corp.payload?.id;
    const link = await h.call('PUT', `${base}/rate-plans/${corpId}/derivation`, revenue, {
      parentRatePlanId: barId,
      kind: 'PERCENT',
      value: -2000,
    });
    h.check(
      'CORP derived from BAR at -20%: 200',
      link.status === 200 && link.payload?.derivation?.parentCode === 'BAR',
      `HTTP ${String(link.status)} ${JSON.stringify(link.payload?.details ?? '')}`,
    );

    // A night with no promotion left: auto exhausted, coded needs a code.
    const q = await quote({
      arrivalDate: d(22),
      departureDate: d(23),
      ratePlanId: corpId,
      adults: 2,
    });
    h.check(
      'a CORP night = 80% of BAR’s 500000 = 400000',
      q.payload?.nightlyRateMinor === 400000,
      `got ${String(q.payload?.nightlyRateMinor)}`,
    );
    h.check('its own default (1) is ignored', q.payload?.nightlyRateMinor !== 1);

    await h.call('PUT', `${base}/rate-plans/${barId}/calendar`, revenue, {
      roomTypeId: fixture.categoryA,
      entries: [{ stayDate: d(22), amountMinor: 612345 }],
    });
    const followed = await quote({
      arrivalDate: d(22),
      departureDate: d(23),
      ratePlanId: corpId,
      adults: 2,
    });
    h.check(
      'repricing BAR moves CORP: round(612345 x 0.8) = 489876',
      followed.payload?.nightlyRateMinor === Math.round((612345 * 8000) / 10000),
      `got ${String(followed.payload?.nightlyRateMinor)}`,
    );

    const cal = await h.call(
      'GET',
      `${base}/rate-plans/${corpId}/calendar?roomTypeId=${fixture.categoryA}&fromDate=${d(22)}&toDate=${d(22)}`,
      clerk,
    );
    h.check(
      'the CORP calendar shows the derived price and is read-only',
      cal.payload?.days?.[0]?.effectiveRateMinor === 489876 && cal.payload?.isEditable === false,
      JSON.stringify({
        e: cal.payload?.days?.[0]?.effectiveRateMinor,
        ed: cal.payload?.isEditable,
      }),
    );
    const ownPrice = await h.call('PUT', `${base}/rate-plans/${corpId}/calendar`, revenue, {
      roomTypeId: fixture.categoryA,
      entries: [{ stayDate: d(22), amountMinor: 1 }],
    });
    h.check(
      'a derived plan cannot take its own prices: 409',
      ownPrice.status === 409,
      `HTTP ${String(ownPrice.status)}`,
    );
    const ownRule = await h.call('POST', `${base}/rate-plans/${corpId}/pricing-rules`, revenue, {
      kind: 'WEEKEND',
      name: 'No',
      prices: [{ roomTypeId: fixture.categoryA, amountMinor: 1 }],
    });
    h.check('nor its own rules: 409', ownRule.status === 409, `HTTP ${String(ownRule.status)}`);

    const fixed = await h.call('POST', `${base}/rate-plans`, revenue, {
      code: 'FIX',
      name: 'Fixed off',
      roomTypes: [
        { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 1, currency: 'INR' } },
      ],
    });
    await h.call('PUT', `${base}/rate-plans/${fixed.payload?.id}/derivation`, revenue, {
      parentRatePlanId: barId,
      kind: 'FIXED',
      value: -700000,
    });
    const floor = await quote({
      arrivalDate: d(23),
      departureDate: d(24),
      ratePlanId: fixed.payload?.id,
      adults: 2,
    });
    h.check(
      'a FIXED discount larger than the rate floors at 0',
      floor.payload?.nightlyRateMinor === 0,
      `got ${String(floor.payload?.nightlyRateMinor)}`,
    );

    const multi = await h.call(
      'PUT',
      `${base}/rate-plans/${fixed.payload?.id}/derivation`,
      revenue,
      { parentRatePlanId: corpId, kind: 'PERCENT', value: 0 },
    );
    h.check(
      'deriving from a derived plan: 409',
      multi.status === 409,
      `HTTP ${String(multi.status)}`,
    );
    const parentBecomesChild = await h.call(
      'PUT',
      `${base}/rate-plans/${barId}/derivation`,
      revenue,
      { parentRatePlanId: corpId, kind: 'PERCENT', value: 0 },
    );
    h.check('a parent cannot become derived: 409', parentBecomesChild.status === 409);
    const self = await h.call('PUT', `${base}/rate-plans/${corpId}/derivation`, revenue, {
      parentRatePlanId: corpId,
      kind: 'PERCENT',
      value: 0,
    });
    h.check('derived from itself: 400', self.status === 400);

    const bOnly = await h.call('POST', `${base}/rate-plans`, revenue, {
      code: 'BONLY',
      name: 'B only',
      roomTypes: [
        { roomTypeId: fixture.categoryB, defaultRate: { amountMinor: 300000, currency: 'INR' } },
      ],
    });
    const uncovered = await h.call(
      'PUT',
      `${base}/rate-plans/${bOnly.payload?.id}/derivation`,
      revenue,
      { parentRatePlanId: barId, kind: 'PERCENT', value: 0 },
    );
    h.check(
      'a parent that does not price the room type: 400',
      uncovered.status === 400,
      `HTTP ${String(uncovered.status)}`,
    );

    const clerkLink = await h.call(
      'PUT',
      `${base}/rate-plans/${bOnly.payload?.id}/derivation`,
      clerk,
      { parentRatePlanId: barId, kind: 'PERCENT', value: 0 },
    );
    h.check('FRONT_DESK may NOT link plans: 403', clerkLink.status === 403);

    const unlink = await h.call('DELETE', `${base}/rate-plans/${corpId}/derivation`, revenue);
    h.check(
      'unlink: 200, no derivation',
      unlink.status === 200 && unlink.payload?.derivation === null,
    );
    const own = await quote({
      arrivalDate: d(22),
      departureDate: d(23),
      ratePlanId: corpId,
      adults: 2,
    });
    h.check(
      'CORP prices from its own default again',
      own.payload?.nightlyRateMinor === 1,
      `got ${String(own.payload?.nightlyRateMinor)}`,
    );
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Tenancy.');
  {
    const foreign = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
    const outsider = foreign.users.admin.cookie;
    const theirs = await h.call(
      'POST',
      `/properties/${foreign.propertyCode}/rate-plans`,
      outsider,
      {
        code: 'THEIRS',
        name: 'Theirs',
        roomTypes: [
          { roomTypeId: foreign.categoryA, defaultRate: { amountMinor: 100000, currency: 'INR' } },
        ],
      },
    );
    const cross = await h.call('PUT', `${base}/rate-plans/${corpId}/derivation`, revenue, {
      parentRatePlanId: theirs.payload?.id,
      kind: 'PERCENT',
      value: 0,
    });
    h.check(
      "deriving from another property's plan: 404",
      cross.status === 404,
      `HTTP ${String(cross.status)}`,
    );
    const readOurs = await h.call(
      'GET',
      `/properties/${foreign.propertyCode}/rate-plans/${barId}/restrictions?roomTypeId=${fixture.categoryA}&fromDate=${d(1)}&toDate=${d(2)}`,
      outsider,
    );
    h.check('our restrictions from their property: 404', readOurs.status === 404);
    const setOurs = await h.call(
      'PUT',
      `/properties/${foreign.propertyCode}/rate-plans/${barId}/derivation`,
      outsider,
      {
        parentRatePlanId: theirs.payload?.id,
        kind: 'PERCENT',
        value: 0,
      },
    );
    h.check('linking our plan from their property: 404', setOurs.status === 404);
  }
}

await runSuite({
  harness: h,
  prisma,
  label: 'rate booking features integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
