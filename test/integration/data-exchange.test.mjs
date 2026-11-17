/**
 * Bulk import (IE-01) and data export (IE-02), through the running API, on
 * suite-owned fixtures.
 *
 * ===========================================================================
 * - A dry run reports every row and writes NOTHING (row counts and audit rows
 *   compared before and after), yet has been through the database.
 * - A commit needs the dry run's digest; with it, everything lands at once,
 *   with audit rows in the same transaction. Re-importing is UNCHANGED.
 * - One bad row and the commit is refused with nothing written, including
 *   the good rows beside it.
 * - Refusals: unknown column, unknown category, duplicate key, a sub-unit
 *   amount, derived / archived plans, overlapping dates, reclassifying a room,
 *   a dated rate before the plan prices the category.
 * - Rate nights asserted PER DATE against rate_plan_day.
 * - Permissions: rooms:manage / rates:manage / data:export (403); another
 *   property is not-found (404), never 403 (CLAUDE.md 3.2).
 * - Concurrency: 6 identical commits in parallel create once; imports racing
 *   the rooms screen for one room number leave exactly one room, no 500.
 * - Export: CSV headers, formula neutralised, windows enforced, every export
 *   audited (personal data flagged), no other property's rows, and the
 *   configuration export imports back as all-UNCHANGED.
 * ===========================================================================
 */

import { WHOLLY_DISPOSABLE } from '../support/isolation-guard.mjs';
import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
} from '../support/room-fixture.mjs';

const SUITE = 'data exchange';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZIEA',
  slugPrefix: 'zz-iea-',
  emailDomain: 'iea.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (B)`,
  prefix: 'ZZIEB',
  slugPrefix: 'zz-ieb-',
  emailDomain: 'ieb.invalid',
  prisma,
});

const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? res.payload?.counts ?? '').slice(0, 300)}`;
const refusedAsInvalid = (res) => res.status === 400 || res.status === 422;

async function body() {
  console.log('\n════ data exchange (IE-01, IE-02) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
  if (serverDb !== 'easeit_test' && !WHOLLY_DISPOSABLE.includes(serverDb)) {
    throw new Error(
      `REFUSING TO RUN: current_database() = "${String(serverDb)}". Nothing was created.`,
    );
  }
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const A = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', revenue: 'REVENUE_MANAGER' },
    rooms: [{ label: 'R1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);

  const admin = A.users.admin.cookie;
  const base = `/properties/${A.propertyCode}`;
  const P = A.propertyId;
  const run = A.runId;
  const NEW = `ZZN${run}`.slice(0, 16);
  const D0 = shiftDays(A.today, 30);
  const D9 = shiftDays(D0, 9);

  // Rate plans: an active one priced for category A, a derived child, an archived one.
  const mkPlan = (code, extra = {}) =>
    prisma.ratePlan.create({
      data: {
        propertyId: P,
        code,
        name: `ZZ ${code} ${run}`,
        currency: 'INR',
        createdByUserId: A.users.admin.id,
        ...extra,
      },
      select: { id: true, code: true },
    });
  const bar = await mkPlan(`BAR${run}`);
  await prisma.ratePlanRoomType.create({
    data: { propertyId: P, ratePlanId: bar.id, roomTypeId: A.categoryA, defaultRateMinor: 500000 },
  });
  const derived = await mkPlan(`DRV${run}`, {
    parentRatePlanId: bar.id,
    derivationKind: 'PERCENT',
    derivationValue: -10,
  });
  const archived = await mkPlan(`OLD${run}`, { archivedAt: new Date(), isActive: false });
  h.note(`plans BAR=${bar.id} DRV=${derived.id} OLD=${archived.id}`);

  const imp = (cookie, docs, mode = 'DRY_RUN', digest) =>
    h.call('POST', `${base}/import`, cookie, { mode, ...docs, ...(digest ? { digest } : {}) });

  const snapshot = async () => {
    const [types, rooms, days, assignments, audits] = await Promise.all([
      prisma.roomType.count({ where: { propertyId: P } }),
      prisma.room.count({ where: { propertyId: P } }),
      prisma.ratePlanDay.count({ where: { propertyId: P } }),
      prisma.ratePlanRoomType.count({ where: { propertyId: P } }),
      prisma.auditLog.count({ where: { propertyId: P } }),
    ]);
    return { types, rooms, days, assignments, audits };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const good = {
    roomTypes: [
      'code,name,maxGuests,maxAdults,baseRate,sortOrder,description',
      `${NEW},"ZZ Garden, view ${run}",3,2,4500.00,5,Imported category`,
      `${A.categoryACode},ZZ Category A ${run},2,,5000,1,`,
    ].join('\r\n'),
    rooms: [
      'number,roomTypeCode,floor,notes',
      `ZZIEA-N1,${NEW},2,`,
      `ZZIEA-N2,${NEW},2,"=HYPERLINK(""x"")"`,
      `ZZIEA-N3,${NEW},3,Corner`,
      `ZZIEA-R1,${A.categoryACode},1,Updated by import`,
    ].join('\n'),
    rates: [
      'ratePlanCode,roomTypeCode,fromDate,toDate,amount',
      `${bar.code},${NEW},,,4500`,
      `${bar.code},${NEW},${D0},${D9},"5,250.50"`,
      `${bar.code},${A.categoryACode},${D0},${shiftDays(D0, 2)},6000`,
    ].join('\n'),
  };

  /* -------------------------------------------------------------- 1 */
  console.log('1. A dry run reports every row and writes nothing.');
  const before = await snapshot();
  const dry = await imp(admin, good);
  const after = await snapshot();
  h.check(
    'dry run answers 200, valid, with a digest',
    dry.status === 200 &&
      dry.payload?.valid === true &&
      /^[0-9a-f]{64}$/.test(dry.payload?.digest ?? ''),
    show(dry),
  );
  h.check(
    'counts: 1 category created, 1 unchanged',
    dry.payload?.counts?.roomTypes?.create === 1 && dry.payload?.counts?.roomTypes?.unchanged === 1,
    JSON.stringify(dry.payload?.counts),
  );
  h.check(
    'counts: 3 rooms created, 1 updated',
    dry.payload?.counts?.rooms?.create === 3 && dry.payload?.counts?.rooms?.update === 1,
    JSON.stringify(dry.payload?.counts?.rooms),
  );
  h.check(
    'counts: 3 rate rows created',
    dry.payload?.counts?.rates?.create === 3,
    JSON.stringify(dry.payload?.counts?.rates),
  );
  h.check(
    'nothing written: categories, rooms, nights, assignments, audit rows',
    same(before, after),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
  h.check(
    'notes say new categories need inventory nights',
    (dry.payload?.notes ?? []).some((n) => /inventory nights/.test(n)),
    JSON.stringify(dry.payload?.notes),
  );

  /* -------------------------------------------------------------- 2 */
  console.log('2. A commit needs the digest of the dry run it follows.');
  const noDigest = await h.call('POST', `${base}/import`, admin, { mode: 'COMMIT', ...good });
  h.check('commit without a digest: refused', refusedAsInvalid(noDigest), show(noDigest));
  const changedDocs = { ...good, rooms: `${good.rooms}\nZZIEA-N4,${NEW},4,` };
  const wrongDigest = await imp(admin, changedDocs, 'COMMIT', dry.payload.digest);
  h.check(
    'commit of different documents with that digest: refused',
    refusedAsInvalid(wrongDigest) && JSON.stringify(wrongDigest.payload).includes('dry run'),
    show(wrongDigest),
  );
  h.check('still nothing written', same(before, await snapshot()));

  /* -------------------------------------------------------------- 3 */
  console.log('3. The commit lands everything, once, with its audit trail.');
  const commit = await imp(admin, good, 'COMMIT', dry.payload.digest);
  h.check(
    'commit: 200, committed',
    commit.status === 200 && commit.payload?.committed === true,
    show(commit),
  );
  const created = await prisma.roomType.findFirst({
    where: { propertyId: P, code: NEW },
    select: {
      id: true,
      name: true,
      maxAdults: true,
      baseRateMinor: true,
      sortOrder: true,
      description: true,
    },
  });
  h.check(
    'category stored exactly (quoted comma name, 4500.00 → 450000 minor)',
    created?.name === `ZZ Garden, view ${run}` &&
      created.baseRateMinor === 450000 &&
      created.maxAdults === 2 &&
      created.sortOrder === 5 &&
      created.description === 'Imported category',
    JSON.stringify(created),
  );
  const newRooms = await prisma.room.findMany({
    where: { propertyId: P, roomTypeId: created?.id },
    select: { number: true, floor: true, notes: true, status: true },
    orderBy: { number: 'asc' },
  });
  h.check(
    'three rooms in the new category, clean',
    newRooms.length === 3 && newRooms.every((r) => r.status === 'VACANT_CLEAN'),
    JSON.stringify(newRooms),
  );
  h.check(
    'the formula-looking note is stored as text',
    newRooms[1]?.notes === '=HYPERLINK("x")',
    JSON.stringify(newRooms[1]),
  );
  const r1 = await prisma.room.findFirst({
    where: { propertyId: P, number: 'ZZIEA-R1' },
    select: { floor: true, notes: true, roomTypeId: true },
  });
  h.check(
    'existing room updated in place, category unchanged',
    r1?.floor === '1' && r1.notes === 'Updated by import' && r1.roomTypeId === A.categoryA,
    JSON.stringify(r1),
  );
  const assignment = await prisma.ratePlanRoomType.findFirst({
    where: { propertyId: P, ratePlanId: bar.id, roomTypeId: created?.id },
    select: { defaultRateMinor: true },
  });
  h.check(
    'plan now prices the new category, default 450000',
    assignment?.defaultRateMinor === 450000,
    JSON.stringify(assignment),
  );
  const nights = await prisma.ratePlanDay.findMany({
    where: { propertyId: P, ratePlanId: bar.id },
    select: { roomTypeId: true, stayDate: true, amountMinor: true },
    orderBy: [{ roomTypeId: 'asc' }, { stayDate: 'asc' }],
  });
  const perDate = (typeId) =>
    nights
      .filter((n) => n.roomTypeId === typeId)
      .map((n) => [n.stayDate.toISOString().slice(0, 10), n.amountMinor]);
  const expectNew = Array.from({ length: 10 }, (_, i) => [shiftDays(D0, i), 525050]);
  h.check(
    'new category: exactly 10 nights, each 525050 (per date)',
    JSON.stringify(perDate(created?.id)) === JSON.stringify(expectNew),
    JSON.stringify(perDate(created?.id)),
  );
  h.check(
    'category A: exactly 3 nights at 600000 (per date)',
    JSON.stringify(perDate(A.categoryA)) ===
      JSON.stringify([0, 1, 2].map((i) => [shiftDays(D0, i), 600000])),
    JSON.stringify(perDate(A.categoryA)),
  );
  const audits = await prisma.auditLog.groupBy({
    by: ['event'],
    where: { propertyId: P, createdAt: { gte: new Date(Date.now() - 600_000) } },
    _count: true,
  });
  const auditCount = Object.fromEntries(audits.map((a) => [a.event, a._count]));
  h.check(
    'audit rows: DATA_IMPORTED 1, ROOM_TYPE_CREATED 1, ROOM_CREATED 3, ROOM_UPDATED 1, ASSIGNED 1, RATE_CALENDAR_UPDATED 2',
    auditCount.DATA_IMPORTED === 1 &&
      auditCount.ROOM_TYPE_CREATED === 1 &&
      auditCount.ROOM_CREATED === 3 &&
      auditCount.ROOM_UPDATED === 1 &&
      auditCount.RATE_PLAN_ROOM_TYPE_ASSIGNED === 1 &&
      auditCount.RATE_CALENDAR_UPDATED === 2,
    JSON.stringify(auditCount),
  );

  /* -------------------------------------------------------------- 4 */
  console.log('4. Importing the same documents again changes nothing.');
  const settled = await snapshot();
  const again = await imp(admin, good);
  const allUnchanged = (r) =>
    ['roomTypes', 'rooms', 'rates'].every(
      (d) =>
        r.payload?.counts?.[d]?.create === 0 &&
        r.payload?.counts?.[d]?.update === 0 &&
        r.payload?.counts?.[d]?.error === 0,
    );
  h.check(
    'second dry run: every row UNCHANGED',
    again.status === 200 && allUnchanged(again),
    JSON.stringify(again.payload?.counts),
  );
  const againCommit = await imp(admin, good, 'COMMIT', again.payload.digest);
  const afterAgain = await snapshot();
  h.check(
    'second commit writes no data rows (only its own DATA_IMPORTED audit row)',
    againCommit.status === 200 && same({ ...settled, audits: settled.audits + 1 }, afterAgain),
    `${JSON.stringify(settled)} -> ${JSON.stringify(afterAgain)}`,
  );

  /* -------------------------------------------------------------- 5 */
  console.log('5. One bad row: every error reported, nothing written, good rows included.');
  const bad = {
    roomTypes: [
      'code,name,maxGuests,baseRate',
      `ZZG${run},ZZ Good ${run},2,3000`,
      `ZZH${run},ZZ Bad money ${run},2,12.345`,
      `ZZG${run},ZZ Dup ${run},2,3000`,
    ].join('\n'),
    rooms: [
      'number,roomTypeCode',
      'ZZIEA-G1,ZZNOPE',
      `ZZIEA-N1,${A.categoryACode}`,
      `ZZIEA-G2,ZZG${run}`,
      `ZZIEA-G2,ZZG${run}`,
    ].join('\n'),
    rates: [
      'ratePlanCode,roomTypeCode,fromDate,toDate,amount',
      `${derived.code},${A.categoryACode},,,100`,
      `${archived.code},${A.categoryACode},,,100`,
      `${bar.code},${A.categoryACode},${D0},${shiftDays(D0, 4)},100`,
      `${bar.code},${A.categoryACode},${shiftDays(D0, 4)},${shiftDays(D0, 6)},100`,
      `${bar.code},${A.categoryBCode},${D0},${D0},100`,
      `${bar.code},${A.categoryACode},2026-02-30,2026-03-01,100`,
      `${bar.code},${A.categoryACode},${D0},,100`,
    ].join('\n'),
  };
  const preBad = await snapshot();
  const badDry = await imp(admin, bad);
  const errorText = JSON.stringify(badDry.payload?.rows ?? []);
  const hasError = (doc, line, needle) =>
    (badDry.payload?.rows ?? []).some(
      (r) =>
        r.document === doc &&
        r.line === line &&
        r.outcome === 'ERROR' &&
        r.messages.join(' ').includes(needle),
    );
  h.check(
    'dry run: 200 and valid=false',
    badDry.status === 200 && badDry.payload?.valid === false,
    show(badDry),
  );
  const expectations = [
    ['roomTypes', 3, '2 decimal place', 'sub-unit amount'],
    ['roomTypes', 4, 'more than once', 'duplicate category in file'],
    ['rooms', 2, 'No category "ZZNOPE"', 'unknown category'],
    ['rooms', 3, 'Moving a room to another category', 'reclassification refused'],
    ['rooms', 5, 'more than once', 'duplicate room in file'],
    ['rates', 2, 'derived', 'derived plan refused'],
    ['rates', 3, 'archived', 'archived plan refused'],
    ['rates', 5, 'Overlaps an earlier row', 'overlapping dates refused'],
    ['rates', 6, 'does not price category', 'dated rate before an assignment refused'],
    ['rates', 7, 'not a real date', '30 February refused'],
    ['rates', 8, 'Give both fromDate and toDate', 'half a range refused'],
  ];
  for (const [doc, line, needle, label] of expectations)
    h.check(
      `${doc} line ${String(line)}: ${label}`,
      hasError(doc, line, needle),
      errorText.slice(0, 400),
    );
  h.check(
    'the good rows are still previewed',
    (badDry.payload?.rows ?? []).some(
      (r) => r.document === 'roomTypes' && r.line === 2 && r.outcome === 'CREATE',
    ),
    errorText.slice(0, 200),
  );
  const badCommit = await imp(admin, bad, 'COMMIT', badDry.payload.digest);
  h.check(
    'commit refused, the errors named',
    refusedAsInvalid(badCommit) && JSON.stringify(badCommit.payload).includes('line'),
    show(badCommit),
  );
  h.check(
    'nothing written, not even the good category',
    same(preBad, await snapshot()) &&
      (await prisma.roomType.count({ where: { propertyId: P, code: `ZZG${run}` } })) === 0,
  );
  const header = await imp(admin, { rooms: 'number,roomTypeCode,flor\nX,Y,1' });
  h.check(
    'an unknown column refuses the whole document',
    header.status === 200 &&
      (header.payload?.rows ?? []).some(
        (r) => r.line === 1 && r.messages.join(' ').includes('Unknown column "flor"'),
      ),
    show(header),
  );

  /* -------------------------------------------------------------- 6 */
  console.log('6. Permissions, and another property.');
  const clerkImport = await imp(A.users.clerk.cookie, { rates: good.rates });
  h.check('front desk cannot import: 403', clerkImport.status === 403, show(clerkImport));
  const revenueRates = await imp(A.users.revenue.cookie, { rates: good.rates });
  h.check('revenue manager may import rates', revenueRates.status === 200, show(revenueRates));
  const revenueRooms = await imp(A.users.revenue.cookie, { rooms: good.rooms });
  h.check(
    'revenue manager may not import rooms: 403',
    revenueRooms.status === 403,
    show(revenueRooms),
  );
  const foreignImport = await h.call('POST', `${base}/import`, B.users.admin.cookie, {
    mode: 'DRY_RUN',
    rooms: good.rooms,
  });
  h.check(
    "another property's admin importing here: 404, not 403",
    foreignImport.status === 404,
    show(foreignImport),
  );
  const unauth = await h.call('POST', `${base}/import`, null, {
    mode: 'DRY_RUN',
    rooms: good.rooms,
  });
  h.check('no session: 401', unauth.status === 401, show(unauth));

  /* -------------------------------------------------------------- 7 */
  console.log('7. Concurrency.');
  const race = {
    roomTypes: ['code,name,maxGuests,baseRate', `ZZR${run},ZZ Race ${run},2,2500`].join('\n'),
    rooms: ['number,roomTypeCode', `ZZIEA-RC1,ZZR${run}`].join('\n'),
  };
  const raceDry = await imp(admin, race);
  const commits = await Promise.all(
    Array.from({ length: 6 }, () => imp(admin, race, 'COMMIT', raceDry.payload.digest)),
  );
  const createdCount = commits.reduce((s, r) => s + (r.payload?.counts?.roomTypes?.create ?? 0), 0);
  h.check(
    '6 identical commits in parallel: all 200',
    commits.every((r) => r.status === 200),
    commits.map((r) => r.status).join(','),
  );
  h.check(
    'exactly one of them created the category and the room',
    createdCount === 1 &&
      commits.reduce((s, r) => s + (r.payload?.counts?.rooms?.create ?? 0), 0) === 1,
    String(createdCount),
  );
  h.check(
    'one category and one room in the database',
    (await prisma.roomType.count({ where: { propertyId: P, code: `ZZR${run}` } })) === 1 &&
      (await prisma.room.count({ where: { propertyId: P, number: 'ZZIEA-RC1' } })) === 1,
  );

  const contested = 'ZZIEA-RC2';
  const viaImport = {
    rooms: ['number,roomTypeCode', `${contested},${A.categoryACode}`].join('\n'),
  };
  const contestedDry = await imp(admin, viaImport);
  const mixed = await Promise.all([
    ...Array.from({ length: 4 }, () =>
      imp(admin, viaImport, 'COMMIT', contestedDry.payload.digest),
    ),
    ...Array.from({ length: 4 }, () =>
      h.call('POST', `${base}/rooms`, admin, { roomTypeId: A.categoryA, number: contested }),
    ),
  ]);
  h.check(
    'import racing the rooms screen: no 500',
    mixed.every((r) => r.status < 500),
    mixed.map((r) => r.status).join(','),
  );
  h.check(
    'exactly one room with that number',
    (await prisma.room.count({ where: { propertyId: P, number: contested } })) === 1,
  );

  /* -------------------------------------------------------------- 8 */
  console.log('8. Export.');
  const download = async (cookie, dataset, query = '') => {
    const res = await fetch(`${h.API}${base}/export/${dataset}${query}`, {
      headers: cookie ? { cookie } : {},
    });
    const text = await res.text();
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      disposition: res.headers.get('content-disposition') ?? '',
      text,
    };
  };
  const typesCsv = await download(admin, 'room-types');
  h.check(
    'room types: 200 text/csv attachment, import header',
    typesCsv.status === 200 &&
      typesCsv.type.startsWith('text/csv') &&
      typesCsv.disposition.includes('attachment') &&
      typesCsv.text.startsWith('code,name,maxGuests,maxAdults,baseRate,sortOrder,description'),
    `${String(typesCsv.status)} ${typesCsv.type}`,
  );
  h.check(
    'amount in major units',
    typesCsv.text.includes(`${NEW},"ZZ Garden, view ${run}",3,2,4500.00,5,Imported category`),
    typesCsv.text.slice(0, 300),
  );
  const roomsCsv = await download(admin, 'rooms');
  h.check(
    'rooms: the formula-looking note is neutralised with a tab',
    roomsCsv.text.includes('"\t=HYPERLINK(""x"")"') || roomsCsv.text.includes('\t=HYPERLINK'),
    roomsCsv.text.slice(0, 300),
  );
  const ratesCsv = await download(admin, 'rates', `?fromDate=${D0}&toDate=${D9}`);
  h.check(
    'rates: 10 equal nights collapse to one row',
    ratesCsv.text.includes(`${bar.code},${NEW},${D0},${D9},5250.50`),
    ratesCsv.text.slice(0, 400),
  );
  h.check(
    'rates: the default row has empty dates',
    ratesCsv.text.includes(`${bar.code},${NEW},,,4500.00`),
  );
  h.check(
    'no other property in any export',
    ![typesCsv, roomsCsv, ratesCsv].some((f) => f.text.includes(B.categoryACode)),
  );

  const roundTrip = await imp(admin, {
    roomTypes: typesCsv.text,
    rooms: roomsCsv.text,
    rates: ratesCsv.text,
  });
  h.check(
    'the configuration export imports back as all UNCHANGED',
    roundTrip.status === 200 && roundTrip.payload?.valid === true && allUnchanged(roundTrip),
    JSON.stringify(roundTrip.payload?.counts ?? roundTrip.payload),
  );

  const resNoWindow = await download(admin, 'reservations');
  h.check(
    'reservations without a window: refused',
    resNoWindow.status === 400 || resNoWindow.status === 422,
    resNoWindow.text.slice(0, 200),
  );
  const resLong = await download(
    admin,
    'reservations',
    `?fromDate=${A.today}&toDate=${shiftDays(A.today, 400)}`,
  );
  h.check(
    'a window over 370 days: refused',
    resLong.status === 400 || resLong.status === 422,
    resLong.text.slice(0, 200),
  );
  const resCsv = await download(
    admin,
    'reservations',
    `?fromDate=${shiftDays(A.today, -30)}&toDate=${shiftDays(A.today, 30)}`,
  );
  h.check(
    'reservations: 200 with header',
    resCsv.status === 200 && resCsv.text.startsWith('confirmationCode,status,source,arrivalDate'),
    `${String(resCsv.status)} ${resCsv.text.slice(0, 120)}`,
  );
  const linesCsv = await download(
    admin,
    'folio-lines',
    `?fromDate=${shiftDays(A.today, -30)}&toDate=${A.today}`,
  );
  h.check(
    'folio lines: 200 with header',
    linesCsv.status === 200 &&
      linesCsv.text.startsWith('chargeDate,confirmationCode,folioNumber,kind'),
    String(linesCsv.status),
  );
  const guestsCsv = await download(admin, 'guests');
  h.check(
    'guests: 200 with header',
    guestsCsv.status === 200 && guestsCsv.text.startsWith('guestId,firstName,lastName,email'),
    String(guestsCsv.status),
  );

  const exportAudits = await prisma.auditLog.findMany({
    where: { propertyId: P, event: 'DATA_EXPORTED' },
    select: { after: true },
  });
  const byDataset = (d) => exportAudits.filter((a) => a.after?.dataset === d);
  h.check(
    'every successful export audited (6: room types, rooms, rates, reservations, folio lines, guests); the 3 refusals not',
    exportAudits.length === 6,
    String(exportAudits.length),
  );
  h.check(
    'reservations and guests exports flagged as personal data; rooms not',
    byDataset('reservations')[0]?.after?.personalData === true &&
      byDataset('guests')[0]?.after?.personalData === true &&
      byDataset('rooms')[0]?.after?.personalData === false,
    JSON.stringify(exportAudits.map((a) => a.after)),
  );
  h.check(
    'the audit row carries no data, only counts',
    !JSON.stringify(exportAudits).includes('@'),
  );

  const clerkExport = await download(A.users.clerk.cookie, 'guests');
  h.check(
    'front desk cannot export: 403',
    clerkExport.status === 403 && clerkExport.type.includes('json'),
    `${String(clerkExport.status)} ${clerkExport.type}`,
  );
  const revenueExport = await download(A.users.revenue.cookie, 'rates');
  h.check(
    'revenue manager cannot export either: 403',
    revenueExport.status === 403,
    String(revenueExport.status),
  );
  const foreignExport = await download(B.users.admin.cookie, 'guests');
  h.check(
    "another property's admin exporting here: 404, not 403",
    foreignExport.status === 404,
    String(foreignExport.status),
  );
  const badDataset = await download(admin, 'passwords');
  h.check(
    'an unknown dataset: refused',
    badDataset.status === 400 || badDataset.status === 422,
    String(badDataset.status),
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
