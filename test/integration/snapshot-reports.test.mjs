/**
 * Reports read the night audit's snapshots (RP-05, RP-08, RP-09, RP-10, GR-02).
 *
 * ===========================================================================
 * The suite seeds closed-day snapshots whose figures deliberately DISAGREE with
 * the live counters for the same dates (the counters say nothing was sold).
 * So every assertion below proves which source a screen read, not merely that
 * it returned a number.
 *
 * Asserted, through the running API:
 * - the revenue endpoint returns exactly the snapshots, totals derived from
 *   sums, missing closed days named and open days counted;
 * - the flash report reads only snapshots, against the last closed day;
 * - the sales report reads snapshots for closed dates and live counters for
 *   open ones, labelled;
 * - the tax report reconciles exactly to the folio tax lines in the database
 *   and calls out a closed day whose snapshot disagrees with the ledger;
 * - the dashboard shows the last closed day to a financial role only;
 * - group performance takes closed property-days from snapshots;
 * - permissions (403 for housekeeping) and tenancy (404 for another property).
 *
 * Suite-owned fixtures only; snapshots go with the property's cascade.
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

const SUITE = 'snapshot reports';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZSRA',
  slugPrefix: 'zz-sra-',
  emailDomain: 'sra.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (B)`,
  prefix: 'ZZSRB',
  slugPrefix: 'zz-srb-',
  emailDomain: 'srb.invalid',
  prisma,
});

const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;
const firstOfMonth = (iso) => `${iso.slice(0, 7)}-01`;
const rowBy = (report, key, value) => report.rows.find((row) => row[key] === value);

/** A closed day's figures, chosen so no two days and no live counter agree. */
function closedFigures(n) {
  const sold = 2 + n;
  const available = 5;
  const room = 300_000 + n * 10_000;
  return {
    roomsPhysical: 6,
    roomsBlocked: 1,
    roomsAvailable: available,
    roomsSold: sold,
    occupancyBp: Math.round((sold * 10_000) / available),
    currency: 'INR',
    roomRevenueMinor: room,
    adrMinor: Math.round(room / sold),
    revparMinor: Math.round(room / available),
    serviceRevenueMinor: 5_000 * n,
    taxMinor: 36_000 + n,
    paymentsMinor: 200_000 + n,
    refundsMinor: n === 3 ? 1_000 : 0,
  };
}

async function body() {
  console.log('\n════ snapshot reports (RP-05, RP-08, RP-09, RP-10, GR-02) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
  if (serverDb !== 'easeit_test' && !WHOLLY_DISPOSABLE.includes(serverDb)) {
    throw new Error(
      `REFUSING TO RUN: the server reports current_database() = "${String(serverDb)}". Nothing was created.`,
    );
  }
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const A = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', housekeeper: 'HOUSEKEEPING' },
    rooms: [{ label: 'R1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);
  await h.assertRoutesAreLoaded([`/properties/${A.propertyCode}/revenue`]);

  const admin = A.users.admin.cookie;
  const base = `/properties/${A.propertyCode}`;
  const D = A.today; // the open business date
  const lastClosed = shiftDays(D, -1);

  // Live counters: physical 6, nothing blocked, nothing sold, D-5 .. D+5.
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 11 }, (_, i) => shiftDays(D, i - 5)).map((night) => ({
      propertyId: A.propertyId,
      roomTypeId: A.categoryA,
      stayDate: utcMidnight(night),
      physical: 6,
    })),
  });

  // Closed days D-3, D-2, D-1 (n = 1, 2, 3). D-5 and D-4 are closed by the
  // calendar but have no snapshot: the "missing" case.
  const closed = new Map();
  for (const n of [1, 2, 3]) {
    const date = shiftDays(D, n - 4);
    const figures = closedFigures(n);
    await prisma.dailySnapshot.create({
      data: {
        propertyId: A.propertyId,
        businessDate: utcMidnight(date),
        runId: randomUUID(),
        ...figures,
      },
    });
    closed.set(date, figures);
  }
  h.note(`snapshots for ${[...closed.keys()].join(', ')}; business date ${D}`);

  // One real stay from D, checked in (posts D's room charge and its tax), plus
  // a service charge with tax on D.
  const booked = await h.call('POST', `${base}/reservations`, admin, {
    roomTypeId: A.categoryA,
    roomId: null,
    arrivalDate: D,
    departureDate: shiftDays(D, 2),
    adults: 1,
    mealPlan: 'EP',
    source: 'WALK_IN',
    guests: [
      { firstName: 'Snap', lastName: 'Shot', govtIdType: 'PASSPORT', govtIdNumber: 'P1234567' },
    ],
    isInstantCheckIn: false,
  });
  if (booked.status !== 201) throw new Error(`booking failed: ${show(booked)}`);
  const stay = booked.payload;
  const checkIn = await h.call('POST', `${base}/reservations/${stay.id}/check-in`, admin, {
    roomId: A.rooms.R1.id,
    primaryGuestIdType: 'PASSPORT',
    primaryGuestIdNumber: 'P1234567',
    acknowledgeRoomNotClean: true,
  });
  if (checkIn.status !== 200 && checkIn.status !== 201)
    throw new Error(`check-in failed: ${show(checkIn)}`);
  const folio = await prisma.folio.findFirst({
    where: { reservationId: stay.id },
    select: { id: true },
  });
  const charge = await h.call('POST', `${base}/folios/${folio.id}/charge`, admin, {
    description: 'Laundry',
    netAmountMinor: 1_000,
    taxAmountMinor: 180,
  });
  if (charge.status !== 200 && charge.status !== 201)
    throw new Error(`charge failed: ${show(charge)}`);

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Revenue screen: exactly the snapshots, gaps named, open days counted.');
  const from = shiftDays(D, -5);
  const to = shiftDays(D, 1);
  const rev = await h.call('GET', `${base}/revenue?from=${from}&to=${to}`, admin);
  h.check('revenue answers 200', rev.status === 200, show(rev));
  const days = rev.payload?.days ?? [];
  h.check(
    'one day per snapshot, oldest first',
    days.map((d) => d.businessDate).join(',') === [...closed.keys()].join(','),
    days.map((d) => d.businessDate).join(','),
  );
  for (const day of days) {
    const want = closed.get(day.businessDate);
    h.check(
      `${day.businessDate} is the snapshot, not the live counter (sold 0)`,
      want !== undefined &&
        day.roomsSold === want.roomsSold &&
        day.roomsAvailable === want.roomsAvailable &&
        day.roomRevenueMinor === want.roomRevenueMinor &&
        day.taxMinor === want.taxMinor &&
        day.serviceRevenueMinor === want.serviceRevenueMinor &&
        day.paymentsMinor === want.paymentsMinor,
      `sold ${String(day.roomsSold)} revenue ${String(day.roomRevenueMinor)}`,
    );
  }
  const sum = (key) => [...closed.values()].reduce((total, f) => total + f[key], 0);
  const t = rev.payload?.totals ?? {};
  h.check(
    'totals are sums, ratios recomputed from them',
    t.days === 3 &&
      t.roomsSold === sum('roomsSold') &&
      t.roomRevenueMinor === sum('roomRevenueMinor') &&
      t.adrMinor === Math.round(sum('roomRevenueMinor') / sum('roomsSold')) &&
      t.occupancyBp === Math.round((sum('roomsSold') * 10_000) / sum('roomsAvailable')),
    JSON.stringify(t),
  );
  h.check(
    'closed days without a snapshot are listed',
    JSON.stringify(rev.payload?.missingDates) ===
      JSON.stringify([shiftDays(D, -5), shiftDays(D, -4)]),
    JSON.stringify(rev.payload?.missingDates),
  );
  h.check(
    'open days are counted, not shown',
    rev.payload?.openDays === 2,
    String(rev.payload?.openDays),
  );

  const revDefault = await h.call('GET', `${base}/revenue`, admin);
  h.check(
    'default window is the month of the last closed day',
    revDefault.status === 200 &&
      revDefault.payload.to === lastClosed &&
      revDefault.payload.from === firstOfMonth(lastClosed),
    `${String(revDefault.payload?.from)}..${String(revDefault.payload?.to)}`,
  );
  const backwards = await h.call('GET', `${base}/revenue?from=${D}&to=${lastClosed}`, admin);
  h.check('from after to is a 400', backwards.status === 400, show(backwards));

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Flash report: snapshots only, against the last closed day.');
  const flash = await h.call('GET', `${base}/reports/flash-manager`, admin);
  h.check('flash answers 200', flash.status === 200, show(flash));
  const dayRow = flash.payload ? rowBy(flash.payload, 'period', 'Day') : undefined;
  const last = closed.get(lastClosed);
  h.check(
    'the Day row is the last closed day’s snapshot',
    dayRow?.to === lastClosed &&
      dayRow?.closedDays === 1 &&
      dayRow?.roomsSold === last.roomsSold &&
      dayRow?.roomRevenueMinor === last.roomRevenueMinor &&
      dayRow?.taxMinor === last.taxMinor &&
      dayRow?.paymentsMinor === last.paymentsMinor &&
      dayRow?.refundsMinor === last.refundsMinor,
    JSON.stringify(dayRow),
  );
  const monthStart = firstOfMonth(lastClosed);
  const inMonth = [...closed.entries()].filter(([date]) => date >= monthStart).map(([, f]) => f);
  const mtd = flash.payload ? rowBy(flash.payload, 'period', 'Month to date') : undefined;
  h.check(
    'month to date sums the month’s snapshots and nothing live',
    mtd?.closedDays === inMonth.length &&
      mtd?.roomRevenueMinor === inMonth.reduce((total, f) => total + f.roomRevenueMinor, 0) &&
      mtd?.roomsSold === inMonth.reduce((total, f) => total + f.roomsSold, 0),
    JSON.stringify(mtd),
  );
  h.check(
    'the gap in closed days is said in the notes',
    (flash.payload?.notes ?? []).some((note) => note.includes('have no snapshot')),
  );
  const flashOpen = await h.call('GET', `${base}/reports/flash-manager?endDate=${D}`, admin);
  const openDayRow = flashOpen.payload ? rowBy(flashOpen.payload, 'period', 'Day') : undefined;
  h.check(
    'the open business date has no snapshot, so its Day row is empty',
    flashOpen.status === 200 && openDayRow?.closedDays === 0 && openDayRow?.roomsSold === 0,
    JSON.stringify(openDayRow),
  );

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. Sales report: closed rows from snapshots, open rows live, each labelled.');
  const sales = await h.call(
    'GET',
    `${base}/reports/sales?startDate=${shiftDays(D, -3)}&endDate=${shiftDays(D, 1)}`,
    admin,
  );
  h.check('sales answers 200', sales.status === 200, show(sales));
  for (const [date, figures] of closed) {
    const row = sales.payload ? rowBy(sales.payload, 'date', date) : undefined;
    h.check(
      `${date} is Closed with the snapshot’s figures`,
      row?.basis === 'Closed' &&
        row?.roomsSold === figures.roomsSold &&
        row?.roomsAvailable === figures.roomsAvailable &&
        row?.revenueMinor === figures.roomRevenueMinor,
      JSON.stringify(row),
    );
  }
  for (const date of [D, shiftDays(D, 1)]) {
    const row = sales.payload ? rowBy(sales.payload, 'date', date) : undefined;
    h.check(
      `${date} is On the books, from the live counters`,
      row?.basis === 'On the books' && row?.roomsSold === 1 && row?.roomsAvailable === 6,
      JSON.stringify(row),
    );
  }

  /* -------------------------------------------------------------- 4 */
  console.log(
    '\n4. Tax report: reconciles to the folio tax lines, and flags a ledger/snapshot disagreement.',
  );
  const ledger = await prisma.$queryRaw`
    SELECT COALESCE(SUM("amountMinor"), 0)::int AS total, COUNT(*)::int AS lines
      FROM "folio_line"
     WHERE "propertyId" = ${A.propertyId}::uuid AND "chargeDate" = ${utcMidnight(D)}::date
       AND ("kind" = 'TAX' OR "isTaxAdjustment")`;
  const roomLedger = await prisma.$queryRaw`
    SELECT COALESCE(SUM(t."amountMinor"), 0)::int AS total
      FROM "folio_line" t JOIN "folio_line" c ON c."id" = t."derivedFromLineId"
     WHERE t."propertyId" = ${A.propertyId}::uuid AND t."chargeDate" = ${utcMidnight(D)}::date
       AND t."kind" = 'TAX' AND c."kind" = 'ROOM_CHARGE'`;
  const tax = await h.call(
    'GET',
    `${base}/reports/tax?startDate=${shiftDays(D, -1)}&endDate=${D}`,
    admin,
  );
  h.check('tax answers 200', tax.status === 200, show(tax));
  const taxToday = tax.payload ? rowBy(tax.payload, 'date', D) : undefined;
  h.check(
    'total tax equals every tax line on the date in the database',
    taxToday?.totalTaxMinor === ledger[0].total &&
      taxToday?.taxLines === ledger[0].lines &&
      ledger[0].lines >= 1,
    `report ${String(taxToday?.totalTaxMinor)} / ledger ${String(ledger[0].total)} in ${String(ledger[0].lines)} line(s)`,
  );
  h.check(
    'room and service tax trace to their charges; nothing unattributed',
    taxToday?.serviceTaxMinor === 180 &&
      taxToday?.serviceTaxableMinor === 1_000 &&
      taxToday?.roomTaxMinor === roomLedger[0].total &&
      taxToday?.otherTaxMinor === 0,
    JSON.stringify(taxToday),
  );
  h.check('an open day has no snapshot column', taxToday?.snapshotTaxMinor === null);
  const taxClosed = tax.payload ? rowBy(tax.payload, 'date', lastClosed) : undefined;
  h.check(
    'a closed day whose snapshot holds tax the ledger lacks is shown, not hidden',
    taxClosed?.totalTaxMinor === 0 &&
      taxClosed?.snapshotTaxMinor === last.taxMinor &&
      (tax.payload?.notes ?? []).some(
        (note) => note.includes(lastClosed) && note.includes('differs'),
      ),
    JSON.stringify(taxClosed),
  );

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Dashboard: the last closed day, for a financial role only.');
  const dashAdmin = await h.call('GET', `${base}/dashboard-summary`, admin);
  const lcd = dashAdmin.payload?.lastClosedDay;
  h.check(
    'admin sees the last closed day from its snapshot',
    dashAdmin.status === 200 &&
      lcd?.businessDate === lastClosed &&
      lcd?.roomRevenueMinor === last.roomRevenueMinor &&
      lcd?.occupancyBp === last.occupancyBp,
    show(dashAdmin),
  );
  const dashClerk = await h.call('GET', `${base}/dashboard-summary`, A.users.clerk.cookie);
  h.check(
    'front desk sees the board without it',
    dashClerk.status === 200 && dashClerk.payload?.lastClosedDay === null,
    show(dashClerk),
  );

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Group performance: closed property-days from snapshots.');
  const perf = await h.call(
    'GET',
    `/properties/group-performance?timeframe=mtd&targetDate=${lastClosed}&propertyIds=${A.propertyId}`,
    admin,
  );
  h.check('group performance answers 200', perf.status === 200, show(perf));
  const monthDays = Number(lastClosed.slice(8, 10));
  h.check(
    'closed property-days are counted, the rest live',
    perf.payload?.basis?.closedPropertyDays === inMonth.length &&
      perf.payload?.basis?.livePropertyDays === monthDays - inMonth.length,
    JSON.stringify(perf.payload?.basis),
  );
  // Live days in the window sold nothing, so the totals are the snapshots'.
  h.check(
    'rooms sold and revenue are the snapshots’, not the live counters',
    perf.payload?.metrics?.roomNightsSold ===
      inMonth.reduce((total, f) => total + f.roomsSold, 0) &&
      perf.payload?.metrics?.totalRevenueMinor ===
        inMonth.reduce((total, f) => total + f.roomRevenueMinor, 0),
    JSON.stringify(perf.payload?.metrics),
  );
  const perfToday = await h.call(
    'GET',
    `/properties/group-performance?timeframe=today&targetDate=${D}&propertyIds=${A.propertyId}`,
    admin,
  );
  h.check(
    'the open business date is live: one room sold of six',
    perfToday.status === 200 &&
      perfToday.payload?.basis?.closedPropertyDays === 0 &&
      perfToday.payload?.metrics?.roomNightsSold === 1 &&
      perfToday.payload?.metrics?.roomNightsAvailable === 6,
    JSON.stringify(perfToday.payload?.metrics),
  );

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. Permissions and tenancy.');
  const hk = A.users.housekeeper.cookie;
  const hkRevenue = await h.call('GET', `${base}/revenue`, hk);
  h.check('housekeeping is refused revenue with a 403', hkRevenue.status === 403, show(hkRevenue));
  const hkTax = await h.call('GET', `${base}/reports/tax`, hk);
  h.check('housekeeping is refused the tax report with a 403', hkTax.status === 403, show(hkTax));
  const foreign = await h.call('GET', `${base}/revenue`, B.users.admin.cookie);
  h.check(
    'another property’s admin gets a 404, never a 403',
    foreign.status === 404,
    show(foreign),
  );
  const foreignTax = await h.call('GET', `${base}/reports/tax`, B.users.admin.cookie);
  h.check(
    'the tax report is 404 to another property too',
    foreignTax.status === 404,
    show(foreignTax),
  );
  const foreignPerf = await h.call(
    'GET',
    `/properties/group-performance?timeframe=mtd&targetDate=${lastClosed}&propertyIds=${A.propertyId}`,
    B.users.admin.cookie,
  );
  h.check(
    'group performance never includes a property the caller holds no grant at',
    foreignPerf.status === 200 &&
      foreignPerf.payload?.propertiesCount === 0 &&
      foreignPerf.payload?.basis?.closedPropertyDays === 0,
    JSON.stringify(foreignPerf.payload?.basis),
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
