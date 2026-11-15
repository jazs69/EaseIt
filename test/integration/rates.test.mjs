/**
 * Rate plans, the rate calendar, pricing rules, occupancy pricing and
 * promotions (AV-05, AV-06; rates increments F1-F8), end to end.
 *
 * ===========================================================================
 * WHAT THIS PROVES, against a running API and a real PostgreSQL:
 *
 *   1. A rate plan is created with per-room-type default rates in integer
 *      minor units; bad input and duplicate codes are refused and write nothing.
 *   2. The calendar resolves every night by the documented precedence:
 *      DATE_OVERRIDE > SEASONAL > WEEKDAY > WEEKEND > DEFAULT, and an override
 *      reports the rule it masks. Clearing an override returns the night to
 *      the rule or default beneath it.
 *   3. Two equally-ranked overlapping rules are refused at write time.
 *   4. Occupancy pricing adds fixed per-guest charges above the base
 *      occupancy, priced from the SAME resolved base rate.
 *   5. A promotion's discount is integer arithmetic whose totals add up.
 *   6. An archived plan cannot be repriced.
 *   7. Permissions, and another property's plans are not-found, never 403.
 *
 * What this does NOT prove: that a reservation quote uses any of this. It
 * does not -- quote and booking still price from `room_type.baseRateMinor`
 * (rates increment F9, tracked separately). Do not read a green run as P0-3.
 *
 * ISOLATION: suite-owned fixtures (prefix ZZRAT / ZZRAX), torn down here.
 * ===========================================================================
 */

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
} from '../support/room-fixture.mjs';

const SUITE = 'rates';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRAT',
  slugPrefix: 'zz-rat-',
  emailDomain: 'rat.invalid',
  prisma,
});

const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZRAX',
  slugPrefix: 'zz-rax-',
  emailDomain: 'rax.invalid',
  prisma,
});

/** 0 = Sunday ... 6 = Saturday, anchored at UTC noon like the server. */
const dow = (iso) => new Date(`${iso}T12:00:00.000Z`).getUTCDay();

async function body() {
  console.log('\n════ rates ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded(['/properties/ZZRAT-PROBE/rate-plans']);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', revenue: 'REVENUE_MANAGER' },
    rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertOwnership(fixture, { types: 2, rooms: 1, grants: 3, stays: 0 });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);

  const base = `/properties/${fixture.propertyCode}`;
  const { clerk, revenue } = {
    clerk: fixture.users.clerk.cookie,
    revenue: fixture.users.revenue.cookie,
  };

  // A 14-night window starting next Monday, so weekday and weekend nights are
  // known regardless of the day the suite runs.
  const toMonday = (8 - dow(fixture.today)) % 7 || 7;
  const start = shiftDays(fixture.today, toMonday);
  const d = (i) => shiftDays(start, i); // d(0) Monday ... d(5) Saturday, d(6) Sunday
  h.note(`window starts Monday ${start}`);

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Rate plans.');
  let planId;
  {
    const res = await h.call('POST', `${base}/rate-plans`, revenue, {
      code: 'BAR',
      name: 'Best available',
      roomTypes: [
        { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 500000, currency: 'INR' } },
        { roomTypeId: fixture.categoryB, defaultRate: { amountMinor: 400000, currency: 'INR' } },
      ],
    });
    h.check(
      'REVENUE_MANAGER creates a plan: 201',
      res.status === 201,
      `HTTP ${String(res.status)} ${JSON.stringify(res.payload?.details ?? '')}`,
    );
    planId = res.payload?.id;
    h.check(
      'active, in the property currency',
      res.payload?.isActive === true && res.payload?.currency === 'INR',
    );
    const a = res.payload?.roomTypes?.find((rt) => rt.roomTypeId === fixture.categoryA);
    h.check('A default is 500000 minor units', a?.defaultRate?.amountMinor === 500000);
    h.check('no propertyId leaks', res.payload !== null && !('propertyId' in res.payload));

    const dup = await h.call('POST', `${base}/rate-plans`, revenue, {
      code: 'BAR',
      name: 'Duplicate',
      roomTypes: [
        { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 1, currency: 'INR' } },
      ],
    });
    h.check('a duplicate code: 409', dup.status === 409, `HTTP ${String(dup.status)}`);

    const fractional = await h.call('POST', `${base}/rate-plans`, revenue, {
      code: 'FRAC',
      name: 'Fractional',
      roomTypes: [
        { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 1000.5, currency: 'INR' } },
      ],
    });
    h.check('a fractional amount: 400', fractional.status === 400);

    const negative = await h.call('POST', `${base}/rate-plans`, revenue, {
      code: 'NEG',
      name: 'Negative',
      roomTypes: [
        { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: -1, currency: 'INR' } },
      ],
    });
    h.check('a negative rate: 400', negative.status === 400);

    const plans = await prisma.ratePlan.count({ where: { propertyId: fixture.propertyId } });
    h.check('refusals created nothing: one plan', plans === 1, `${String(plans)} plans`);

    const read = await h.call('GET', `${base}/rate-plans`, clerk);
    h.check('FRONT_DESK may read plans', read.status === 200 && read.payload?.items?.length === 1);
    const clerkWrite = await h.call('PATCH', `${base}/rate-plans/${planId}`, clerk, { name: 'x' });
    h.check('FRONT_DESK may NOT edit a plan: 403', clerkWrite.status === 403);

    const audit = await prisma.auditLog.count({
      where: { propertyId: fixture.propertyId, entityId: planId },
    });
    h.check('plan creation is audited', audit >= 1);
  }

  const calendar = async (from, to, roomTypeId = fixture.categoryA) =>
    h.call(
      'GET',
      `${base}/rate-plans/${planId}/calendar?roomTypeId=${roomTypeId}&fromDate=${from}&toDate=${to}`,
      clerk,
    );
  const day = (res, date) => res.payload?.days?.find((x) => x.stayDate === date);

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Calendar overrides.');
  {
    const before = await calendar(d(0), d(6));
    h.check(
      'calendar answers 200 with 7 nights',
      before.status === 200 && before.payload?.days?.length === 7,
    );
    h.check(
      'with no rules every night is DEFAULT 500000',
      before.payload?.days?.every(
        (x) => x.source === 'DEFAULT' && x.effectiveRateMinor === 500000,
      ) === true,
    );

    const put = await h.call('PUT', `${base}/rate-plans/${planId}/calendar`, revenue, {
      roomTypeId: fixture.categoryA,
      entries: [{ stayDate: d(1), amountMinor: 650000 }],
    });
    h.check('an override is written: 200', put.status === 200, `HTTP ${String(put.status)}`);
    const after = await calendar(d(0), d(6));
    h.check(
      'Tuesday is DATE_OVERRIDE 650000',
      day(after, d(1))?.source === 'DATE_OVERRIDE' &&
        day(after, d(1))?.effectiveRateMinor === 650000,
    );
    h.check(
      'its neighbours are unchanged',
      day(after, d(0))?.effectiveRateMinor === 500000 &&
        day(after, d(2))?.effectiveRateMinor === 500000,
    );
    h.check(
      'category B is unaffected',
      day(await calendar(d(1), d(1), fixture.categoryB), d(1))?.effectiveRateMinor === 400000,
    );

    const clear = await h.call('POST', `${base}/rate-plans/${planId}/calendar/clear`, revenue, {
      roomTypeId: fixture.categoryA,
      stayDates: [d(1)],
    });
    h.check('clear: 200, one night cleared', clear.status === 200 && clear.payload?.cleared === 1);
    h.check(
      'Tuesday is back to DEFAULT',
      day(await calendar(d(1), d(1)), d(1))?.source === 'DEFAULT',
    );

    const clerkPut = await h.call('PUT', `${base}/rate-plans/${planId}/calendar`, clerk, {
      roomTypeId: fixture.categoryA,
      entries: [{ stayDate: d(1), amountMinor: 1 }],
    });
    h.check('FRONT_DESK may NOT reprice: 403', clerkPut.status === 403);
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. Pricing rules and precedence.');
  {
    const weekend = await h.call('POST', `${base}/rate-plans/${planId}/pricing-rules`, revenue, {
      kind: 'WEEKEND',
      name: 'Weekend',
      prices: [{ roomTypeId: fixture.categoryA, amountMinor: 550000 }],
    });
    h.check(
      'a WEEKEND rule: 201',
      weekend.status === 201,
      `HTTP ${String(weekend.status)} ${JSON.stringify(weekend.payload?.details ?? '')}`,
    );

    const wednesday = await h.call('POST', `${base}/rate-plans/${planId}/pricing-rules`, revenue, {
      kind: 'WEEKDAY',
      name: 'Midweek',
      daysOfWeek: [3],
      prices: [{ roomTypeId: fixture.categoryA, amountMinor: 450000 }],
    });
    h.check('a WEEKDAY rule (Wednesday): 201', wednesday.status === 201);

    const season = await h.call('POST', `${base}/rate-plans/${planId}/seasons`, revenue, {
      kind: 'SEASONAL',
      name: 'Festival',
      startDate: d(4),
      endDate: d(5),
      prices: [{ roomTypeId: fixture.categoryA, amountMinor: 700000 }],
    });
    h.check(
      'a SEASONAL rule (Fri-Sat) via /seasons: 201',
      season.status === 201,
      `HTTP ${String(season.status)} ${JSON.stringify(season.payload?.details ?? '')}`,
    );
    const wrongRoute = await h.call('POST', `${base}/rate-plans/${planId}/pricing-rules`, revenue, {
      kind: 'SEASONAL',
      name: 'Wrong route',
      startDate: d(8),
      endDate: d(9),
      prices: [{ roomTypeId: fixture.categoryA, amountMinor: 1 }],
    });
    h.check('a SEASONAL rule on /pricing-rules is refused 400', wrongRoute.status === 400);
    const seasonId = season.payload?.id;

    await h.call('PUT', `${base}/rate-plans/${planId}/calendar`, revenue, {
      roomTypeId: fixture.categoryA,
      entries: [{ stayDate: d(5), amountMinor: 900000 }],
    });

    const cal = await calendar(d(0), d(6));
    const expect = [
      [d(0), 'DEFAULT', 500000],
      [d(2), 'WEEKDAY', 450000],
      [d(4), 'SEASONAL', 700000],
      [d(5), 'DATE_OVERRIDE', 900000],
      [d(6), 'WEEKEND', 550000],
    ];
    for (const [date, source, amount] of expect) {
      const x = day(cal, date);
      h.check(
        `${date} (dow ${String(dow(date))}) resolves ${source} ${String(amount)}`,
        x?.source === source && x?.effectiveRateMinor === amount,
        `got ${String(x?.source)} ${String(x?.effectiveRateMinor)}`,
      );
    }
    h.check(
      'Saturday override reports the season it masks',
      day(cal, d(5))?.maskedSource === 'SEASONAL' && day(cal, d(5))?.ruleRateMinor === 700000,
    );
    h.check('no night is ambiguous', cal.payload?.ambiguousCount === 0);

    const clash = await h.call('POST', `${base}/rate-plans/${planId}/seasons`, revenue, {
      kind: 'SEASONAL',
      name: 'Clash',
      startDate: d(5),
      endDate: d(6),
      prices: [{ roomTypeId: fixture.categoryA, amountMinor: 1 }],
    });
    h.check(
      'an overlapping season at the same priority is refused 400',
      clash.status === 400 && clash.payload?.code === 'VALIDATION_FAILED',
      `HTTP ${String(clash.status)}`,
    );
    const rules = await prisma.ratePricingRule.count({ where: { propertyId: fixture.propertyId } });
    h.check('and nothing was written: 3 rules', rules === 3);

    const disable = await h.call(
      'PATCH',
      `${base}/rate-plans/${planId}/seasons/${seasonId}/status`,
      revenue,
      { action: 'DISABLE' },
    );
    h.check('disable the season: 200', disable.status === 200, `HTTP ${String(disable.status)}`);
    h.check(
      'Friday falls back to DEFAULT',
      day(await calendar(d(4), d(4)), d(4))?.source === 'DEFAULT',
    );
    await h.call('PATCH', `${base}/rate-plans/${planId}/seasons/${seasonId}/status`, revenue, {
      action: 'ENABLE',
    });
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Occupancy pricing.');
  {
    const roomType = await h.call(
      'PATCH',
      `${base}/room-types/${fixture.categoryA}`,
      fixture.users.admin.cookie,
      {
        maxGuests: 4,
      },
    );
    h.check(
      'category A takes 4 guests',
      roomType.status === 200,
      `HTTP ${String(roomType.status)}`,
    );

    const cfg = await h.call(
      'PATCH',
      `${base}/rate-plans/${planId}/room-types/${fixture.categoryA}/occupancy-pricing`,
      revenue,
      {
        enabled: true,
        baseOccupancy: 2,
        includedChildren: 0,
        adult: { kind: 'FIXED', value: 100000 },
        child: { kind: 'FIXED', value: 50000 },
      },
    );
    h.check(
      'occupancy pricing configured: 200',
      cfg.status === 200,
      `HTTP ${String(cfg.status)} ${JSON.stringify(cfg.payload?.details ?? '')}`,
    );

    const preview = await h.call(
      'POST',
      `${base}/rate-plans/${planId}/occupancy-pricing/preview`,
      clerk,
      { roomTypeId: fixture.categoryA, stayDate: d(4), adults: 3, children: 1 },
    );
    h.check(
      'preview: 200',
      preview.status === 200,
      `HTTP ${String(preview.status)} ${JSON.stringify(preview.payload ?? '')}`,
    );
    const p = preview.payload;
    h.check(
      'base comes from the resolved season: 700000',
      p?.baseRateMinor === 700000 && p?.baseRateSource === 'SEASONAL',
    );
    h.check(
      'one extra adult, one extra child',
      p?.extraAdultCount === 1 && p?.extraChildCount === 1,
    );
    h.check(
      'night = 700000 + 100000 + 50000 = 850000',
      p?.effectiveNightlyRateMinor === 850000 && p?.totalExtraChargeMinor === 150000,
      `got ${String(p?.effectiveNightlyRateMinor)}`,
    );
    h.check(
      'every figure is an integer',
      [p?.baseRateMinor, p?.effectiveNightlyRateMinor].every(Number.isInteger),
    );

    const tooMany = await h.call(
      'POST',
      `${base}/rate-plans/${planId}/occupancy-pricing/preview`,
      clerk,
      { roomTypeId: fixture.categoryA, stayDate: d(4), adults: 4, children: 1 },
    );
    h.check(
      'over capacity is refused, not priced',
      tooMany.status !== 200 || (tooMany.payload?.refusals?.length ?? 0) > 0,
      `HTTP ${String(tooMany.status)}`,
    );
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Promotions.');
  {
    const promo = await h.call('POST', `${base}/promotions`, revenue, {
      name: 'Ten off',
      discount: { kind: 'PERCENT', value: 1000 },
      appliesToAllRatePlans: true,
      ratePlanIds: [],
      appliesToAllRoomTypes: true,
      roomTypeIds: [],
    });
    h.check(
      'a 10% promotion: 201',
      promo.status === 201,
      `HTTP ${String(promo.status)} ${JSON.stringify(promo.payload?.details ?? '')}`,
    );
    const promoId = promo.payload?.id;
    const activate = await h.call('PATCH', `${base}/promotions/${promoId}/status`, revenue, {
      action: 'ACTIVATE',
    });
    h.check(
      'activated (or already active)',
      activate.status === 200 || activate.status === 409,
      `HTTP ${String(activate.status)}`,
    );

    const preview = await h.call('POST', `${base}/promotions/preview`, clerk, {
      ratePlanId: planId,
      roomTypeId: fixture.categoryA,
      arrivalDate: d(0),
      departureDate: d(3),
      bookingDate: fixture.today,
      adults: 2,
    });
    h.check(
      'promotion preview: 200',
      preview.status === 200,
      `HTTP ${String(preview.status)} ${JSON.stringify(preview.payload ?? '')}`,
    );
    const p = preview.payload;
    h.check('three nights', p?.nights === 3 && p?.perNight?.length === 3);
    h.check('the promotion was selected', p?.selectedPromotionId === promoId);
    // Mon 500000, Tue 500000 (override cleared), Wed 450000 (weekday rule).
    h.check(
      'base total = 500000 + 500000 + 450000',
      p?.baseTotalMinor === 1450000,
      `got ${String(p?.baseTotalMinor)}`,
    );
    h.check(
      'discount = 10% of each night = 145000',
      p?.discountTotalMinor === 145000,
      `got ${String(p?.discountTotalMinor)}`,
    );
    h.check(
      'final = adjusted - discount, exactly',
      p?.finalTotalMinor === p?.occupancyAdjustedTotalMinor - p?.discountTotalMinor,
    );
    h.check(
      'per-night discounts add up to the total',
      p?.perNight?.reduce((sum, n) => sum + n.discountMinor, 0) === p?.discountTotalMinor,
    );
    h.check(
      'every amount is an integer',
      [p?.baseTotalMinor, p?.discountTotalMinor, p?.finalTotalMinor].every(Number.isInteger),
    );

    const clerkPromo = await h.call('POST', `${base}/promotions`, clerk, {
      name: 'No',
      discount: { kind: 'PERCENT', value: 100 },
      appliesToAllRatePlans: true,
      ratePlanIds: [],
      appliesToAllRoomTypes: true,
      roomTypeIds: [],
    });
    h.check('FRONT_DESK may NOT create a promotion: 403', clerkPromo.status === 403);
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. An archived plan cannot be repriced.');
  {
    const archive = await h.call('POST', `${base}/rate-plans/${planId}/status`, revenue, {
      action: 'ARCHIVE',
    });
    h.check(
      'archive: 200',
      archive.status === 200,
      `HTTP ${String(archive.status)} ${JSON.stringify(archive.payload ?? '')}`,
    );
    const put = await h.call('PUT', `${base}/rate-plans/${planId}/calendar`, revenue, {
      roomTypeId: fixture.categoryA,
      entries: [{ stayDate: d(0), amountMinor: 1 }],
    });
    h.check(
      'repricing an archived plan is refused',
      put.status >= 400 && put.status < 500 && put.status !== 404,
      `HTTP ${String(put.status)}`,
    );
    h.check(
      'Monday is still DEFAULT 500000',
      day(await calendar(d(0), d(0)), d(0))?.effectiveRateMinor === 500000,
    );
  }

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. Tenancy.');
  {
    const foreign = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
    const outsider = foreign.users.admin.cookie;

    h.check(
      'their admin on our plans: 404',
      (await h.call('GET', `${base}/rate-plans`, outsider)).status === 404,
    );
    h.check(
      'our plan id under their property: 404, never 403',
      (await h.call('GET', `/properties/${foreign.propertyCode}/rate-plans/${planId}`, outsider))
        .status === 404,
    );
    const crossPut = await h.call(
      'PUT',
      `/properties/${foreign.propertyCode}/rate-plans/${planId}/calendar`,
      outsider,
      { roomTypeId: fixture.categoryA, entries: [{ stayDate: d(0), amountMinor: 1 }] },
    );
    h.check(
      'repricing our plan from their property: 404',
      crossPut.status === 404,
      `HTTP ${String(crossPut.status)}`,
    );

    const crossAssign = await h.call(
      'POST',
      `/properties/${foreign.propertyCode}/rate-plans`,
      outsider,
      {
        code: 'STEAL',
        name: 'Steal',
        roomTypes: [
          { roomTypeId: fixture.categoryA, defaultRate: { amountMinor: 1, currency: 'INR' } },
        ],
      },
    );
    h.check(
      'their plan cannot name our room type',
      crossAssign.status === 400 || crossAssign.status === 404,
      `HTTP ${String(crossAssign.status)}`,
    );
    const malformed = await h.call(
      'PATCH',
      `${base}/rate-plans/${planId}/pricing-rules/undefined/status`,
      revenue,
      { action: 'DISABLE' },
    );
    h.check(
      'a malformed rule id is 404, not 500',
      malformed.status === 404,
      `HTTP ${String(malformed.status)}`,
    );
    h.check(
      'a malformed plan id is 404, not 500',
      (await h.call('GET', `${base}/rate-plans/not-a-uuid`, clerk)).status === 404,
    );
    h.check(
      'and nothing was created there',
      (await prisma.ratePlan.count({ where: { propertyId: foreign.propertyId } })) === 0,
    );
  }
}

await runSuite({
  harness: h,
  prisma,
  label: 'rates integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
