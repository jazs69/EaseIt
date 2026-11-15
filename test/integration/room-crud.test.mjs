/**
 * Physical-room CRUD, duplicate identifiers and the rejected-field contract.
 *
 * ===========================================================================
 * WHAT THIS PROVES, that nothing else does.
 *
 *   * `(propertyId, number)` uniqueness, translated into a typed 409 rather
 *     than a Prisma code.
 *   * That `PATCH /rooms/:roomId` REFUSES `status` and `roomTypeId` instead of
 *     silently dropping them. Zod strips unknown keys by default, so a caller
 *     that believed it had set a status would otherwise get a 200 and no
 *     change — the worst possible answer.
 *   * **Limitation L1, asserted as a limitation:** adding a room does NOT
 *     change `physical` on `inventory_day` rows that already exist. That is
 *     the documented consequence of deferring the forward-only recompute, and
 *     it is asserted here so the day it silently changes, this fails.
 *   * Cursor pagination across pages, keyed on room number.
 *
 * ISOLATION: prefix ZZRMC, its own slug prefix and email domain.
 * ===========================================================================
 */

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'room CRUD';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRMC',
  slugPrefix: 'zz-rmc-',
  emailDomain: 'rmc.invalid',
  prisma,
});

async function body() {
  console.log('\n════ room CRUD ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard  ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded(['/properties/ZZRMC-PROBE/rooms']);
  await h.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'OUT_OF_SERVICE' },
      { label: 'B1', category: 'B', status: 'VACANT_DIRTY' },
    ],
  });
  await h.assertOwnership(fixture, { types: 2, rooms: 3, grants: 2, stays: 0 });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);

  const base = `/properties/${fixture.propertyCode}/rooms`;
  const admin = fixture.users.admin.cookie;
  const clerk = fixture.users.clerk.cookie;

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Reading rooms.');
  {
    const res = await h.call('GET', base, admin);
    h.check('GET answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    h.check(
      'all three fixture rooms are listed',
      res.payload?.items?.length === 3,
      String(res.payload?.items?.length),
    );
    h.check(
      'ordered by number ascending',
      res.payload?.items?.map((r) => r.number).join(',') ===
        [`${h.prefix}-A1`, `${h.prefix}-A2`, `${h.prefix}-B1`].join(','),
      res.payload?.items?.map((r) => r.number).join(','),
    );

    const first = res.payload?.items?.[0];
    h.check(
      'each room carries its category code and name',
      typeof first?.roomTypeCode === 'string' && typeof first?.roomTypeName === 'string',
      `${String(first?.roomTypeCode)} / ${String(first?.roomTypeName)}`,
    );
    h.check('and its housekeeping status', first?.status === 'VACANT_CLEAN', String(first?.status));
    h.check(
      'NO availability field is reported — room blocks have no read endpoint',
      first !== undefined &&
        !('isBlocked' in first) &&
        !('isAvailable' in first) &&
        !('isBookable' in first),
      Object.keys(first ?? {}).join(','),
    );
    h.check('no propertyId leaks', first !== undefined && !('propertyId' in first));
    h.check(
      'nextCursor is null when one page covers everything',
      res.payload?.nextCursor === null,
      String(res.payload?.nextCursor),
    );
  }

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Filters and cursor pagination.');
  {
    const byType = await h.call('GET', `${base}?roomTypeId=${fixture.categoryB}`, admin);
    h.check(
      'filtering by roomTypeId narrows the page',
      byType.payload?.items?.length === 1,
      String(byType.payload?.items?.length),
    );
    h.check(
      'and returns the right room',
      byType.payload?.items?.[0]?.number === `${h.prefix}-B1`,
      String(byType.payload?.items?.[0]?.number),
    );

    const byStatus = await h.call('GET', `${base}?status=OUT_OF_SERVICE`, admin);
    h.check(
      'filtering by status works',
      byStatus.payload?.items?.length === 1,
      String(byStatus.payload?.items?.length),
    );

    const page1 = await h.call('GET', `${base}?limit=2`, admin);
    h.check(
      'limit=2 returns two rooms',
      page1.payload?.items?.length === 2,
      String(page1.payload?.items?.length),
    );
    h.check(
      'and a cursor, because more remain',
      page1.payload?.nextCursor === `${h.prefix}-A2`,
      String(page1.payload?.nextCursor),
    );

    const page2 = await h.call(
      'GET',
      `${base}?limit=2&cursor=${encodeURIComponent(String(page1.payload?.nextCursor))}`,
      admin,
    );
    h.check(
      'the next page continues after the cursor',
      page2.payload?.items?.length === 1 && page2.payload?.items?.[0]?.number === `${h.prefix}-B1`,
      String(page2.payload?.items?.[0]?.number),
    );
    h.check('and reports no further cursor', page2.payload?.nextCursor === null);
    h.check(
      'the two pages together cover every room exactly once',
      new Set([...page1.payload.items, ...page2.payload.items].map((r) => r.id)).size === 3,
    );

    const bad = await h.call('GET', `${base}?limit=999`, admin);
    h.check('an over-large limit is refused 400', bad.status === 400, `HTTP ${String(bad.status)}`);
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. Creating a room.');
  let createdId = null;
  {
    const res = await h.call('POST', base, admin, {
      roomTypeId: fixture.categoryA,
      number: `${h.prefix}-NEW`,
      floor: '3',
      notes: 'Created by the room CRUD suite.',
    });
    h.check('POST answers 201', res.status === 201, `HTTP ${String(res.status)}`);
    createdId = res.payload?.id ?? null;
    h.check(
      'a new room starts VACANT_CLEAN, the schema default',
      res.payload?.status === 'VACANT_CLEAN',
      String(res.payload?.status),
    );
    h.check(
      'floor and notes round-trip',
      res.payload?.floor === '3' && typeof res.payload?.notes === 'string',
    );

    const row =
      createdId === null
        ? null
        : await prisma.room.findFirst({
            where: { id: createdId, propertyId: fixture.propertyId },
            select: { number: true, roomTypeId: true },
          });
    h.check('the row exists under THIS property', row !== null);
    h.check('with the requested category', row?.roomTypeId === fixture.categoryA);

    const foreign = await h.call('POST', base, admin, {
      roomTypeId: '00000000-0000-4000-8000-000000000000',
      number: `${h.prefix}-BAD`,
    });
    h.check(
      'a roomTypeId this property does not own is refused 400',
      foreign.status === 400,
      `HTTP ${String(foreign.status)}`,
    );
    h.check(
      'naming the field',
      foreign.payload?.details?.issues?.roomTypeId !== undefined,
      JSON.stringify(foreign.payload?.details ?? {}).slice(0, 80),
    );
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Duplicate room number.');
  {
    const dup = await h.call('POST', base, admin, {
      roomTypeId: fixture.categoryB,
      number: `${h.prefix}-NEW`,
    });
    h.check('a duplicate number is refused 409', dup.status === 409, `HTTP ${String(dup.status)}`);
    h.check(
      'with the typed CONFLICT code',
      dup.payload?.code === 'CONFLICT',
      String(dup.payload?.code),
    );
    h.check(
      'and no driver code leaks',
      !/P2002|Unique constraint|PrismaClient/i.test(JSON.stringify(dup.payload ?? {})),
      JSON.stringify(dup.payload ?? {}).slice(0, 90),
    );

    const count = await prisma.room.count({ where: { propertyId: fixture.propertyId } });
    h.check('the refusal created nothing', count === 4, `${String(count)} rooms`);
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. PATCH refuses status and roomTypeId rather than dropping them.');
  {
    const withStatus = await h.call('PATCH', `${base}/${createdId}`, admin, {
      floor: '4',
      status: 'OCCUPIED_CLEAN',
    });
    h.check(
      'a body carrying status is refused 400',
      withStatus.status === 400,
      `HTTP ${String(withStatus.status)}`,
    );
    h.check(
      'naming status as the offending field',
      withStatus.payload?.details?.issues?.status !== undefined,
      JSON.stringify(withStatus.payload?.details ?? {}).slice(0, 110),
    );

    const withType = await h.call('PATCH', `${base}/${createdId}`, admin, {
      roomTypeId: fixture.categoryB,
    });
    h.check(
      'a body carrying roomTypeId is refused 400',
      withType.status === 400,
      `HTTP ${String(withType.status)}`,
    );

    const unchanged = await prisma.room.findUnique({
      where: { id: createdId },
      select: { status: true, roomTypeId: true, floor: true },
    });
    h.check(
      'the status did not change',
      unchanged?.status === 'VACANT_CLEAN',
      String(unchanged?.status),
    );
    h.check('the category did not change', unchanged?.roomTypeId === fixture.categoryA);
    h.check(
      'and the legitimate field in the same refused body was NOT applied',
      unchanged?.floor === '3',
      `floor=${String(unchanged?.floor)} — the whole request is refused, not partially applied`,
    );
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. A legitimate update.');
  {
    const res = await h.call('PATCH', `${base}/${createdId}`, admin, {
      floor: '5',
      notes: null,
    });
    h.check('PATCH answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    h.check('the floor changed', res.payload?.floor === '5', String(res.payload?.floor));
    h.check('and notes were cleared', res.payload?.notes === null, String(res.payload?.notes));

    const renumber = await h.call('PATCH', `${base}/${createdId}`, admin, {
      number: `${h.prefix}-A1`,
    });
    h.check(
      'renumbering onto an existing number is refused 409',
      renumber.status === 409,
      `HTTP ${String(renumber.status)}`,
    );

    /**
     * DEFECT-2 regression.
     *
     * This route cannot use `@Body(new ZodValidationPipe(...))`, because the
     * rejected-key check needs the RAW body before zod strips unknown keys.
     * It used to call `schema.parse()` instead, so a plain `ZodError` escaped
     * and EVERY validation failure here came back 500 — while the sibling
     * `PATCH /room-types/:roomTypeId`, which does use the pipe, returned 400.
     *
     * So this asserts more than the empty body: several distinct zod failures,
     * because the defect was never specific to one of them.
     */
    const zodFailures = [
      ['an empty patch', {}],
      ['a too-long floor', { floor: 'F'.repeat(40) }],
      ['a non-string number', { number: 12345 }],
      ['an over-long note', { notes: 'x'.repeat(600) }],
      ['an empty room number', { number: '' }],
    ];
    for (const [label, payload] of zodFailures) {
      const res = await h.call('PATCH', `${base}/${createdId}`, admin, payload);
      h.check(`${label} is refused 400, not 500`, res.status === 400, `HTTP ${String(res.status)}`);
      h.check(
        `  and carries the typed VALIDATION_FAILED code`,
        res.payload?.code === 'VALIDATION_FAILED',
        String(res.payload?.code),
      );
      h.check(
        `  with a field-keyed issue, not a stack or schema dump`,
        typeof res.payload?.details?.issues === 'object' &&
          res.payload.details.issues !== null &&
          Object.keys(res.payload.details.issues).length > 0 &&
          !/ZodError|at Object\.|\.ts:\d+/.test(JSON.stringify(res.payload)),
        JSON.stringify(res.payload?.details?.issues ?? {}).slice(0, 90),
      );
    }

    const untouched = await prisma.room.findUnique({
      where: { id: createdId },
      select: { number: true, floor: true, notes: true },
    });
    h.check(
      'no zod failure applied anything',
      untouched?.floor === '5' && untouched?.notes === null,
      JSON.stringify(untouched),
    );
    h.check(
      'and the rejected-field behaviour still works alongside it',
      (await h.call('PATCH', `${base}/${createdId}`, admin, { status: 'VACANT_DIRTY' })).payload
        ?.details?.issues?.status !== undefined,
      'status is still refused by name, not stripped',
    );
  }

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. Limitation L1 — a new room does not change existing inventory.');
  {
    // One inventory night, created directly so this suite depends on no
    // generator. `physical` is set to the count of eligible rooms AT THIS
    // MOMENT, which is what the generator would have written.
    const night = utcMidnight(shiftDays(fixture.today, 5));
    const eligible = await prisma.room.count({
      where: {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryA,
        status: { not: 'OUT_OF_ORDER' },
      },
    });
    const row = await prisma.inventoryDay.create({
      data: {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryA,
        stayDate: night,
        physical: eligible,
        sold: 0,
        blocked: 0,
        overbookingAllowance: 0,
      },
      select: { id: true, physical: true },
    });
    h.note(
      `inventory night created with physical=${String(row.physical)} (eligible=${String(eligible)})`,
    );

    const added = await h.call('POST', base, admin, {
      roomTypeId: fixture.categoryA,
      number: `${h.prefix}-L1`,
    });
    h.check('the extra room was created', added.status === 201, `HTTP ${String(added.status)}`);

    const after = await prisma.inventoryDay.findUnique({
      where: { id: row.id },
      select: { physical: true, sold: true, blocked: true, overbookingAllowance: true },
    });
    h.check(
      'physical on the EXISTING night is unchanged — limitation L1',
      after?.physical === row.physical,
      `${String(after?.physical)} (was ${String(row.physical)}); understated, which cannot oversell`,
    );
    h.check(
      'and no counter moved at all',
      after?.sold === 0 && after?.blocked === 0 && after?.overbookingAllowance === 0,
      JSON.stringify(after),
    );

    const liveEligible = await prisma.room.count({
      where: {
        propertyId: fixture.propertyId,
        roomTypeId: fixture.categoryA,
        status: { not: 'OUT_OF_ORDER' },
      },
    });
    h.check(
      'so the live room count now EXCEEDS the configured physical, as documented',
      liveEligible === after?.physical + 1,
      `live=${String(liveEligible)} configured=${String(after?.physical)}`,
    );

    // Cleaned by id, not by range: this is the only inventory row the suite
    // made, and naming it means no predicate can widen.
    await prisma.inventoryDay.delete({ where: { id: row.id } });
    h.check(
      'the suite removed its own inventory row by id',
      (await prisma.inventoryDay.count({ where: { propertyId: fixture.propertyId } })) === 0,
    );
  }

  /* -------------------------------------------------------------- 8 */
  console.log('\n8. Audit rows and permissions.');
  {
    const rows = await prisma.auditLog.findMany({
      where: { propertyId: fixture.propertyId, entityType: 'room' },
      select: { event: true, actorUserId: true },
    });
    h.check('room mutations were audited', rows.length >= 3, rows.map((r) => r.event).join(','));
    h.check(
      'ROOM_CREATED and ROOM_UPDATED both appear',
      rows.some((r) => r.event === 'ROOM_CREATED') && rows.some((r) => r.event === 'ROOM_UPDATED'),
    );
    h.check(
      'every row names the acting admin',
      rows.every((r) => r.actorUserId === fixture.users.admin.id),
    );

    h.check('no session is 401', (await h.call('GET', base, null)).status === 401);
    h.check('FRONT_DESK may read', (await h.call('GET', base, clerk)).status === 200);

    const clerkWrite = await h.call('POST', base, clerk, {
      roomTypeId: fixture.categoryA,
      number: `${h.prefix}-FD`,
    });
    h.check(
      'FRONT_DESK may NOT create a room',
      clerkWrite.status === 403,
      `HTTP ${String(clerkWrite.status)}`,
    );
    const clerkPatch = await h.call('PATCH', `${base}/${createdId}`, clerk, { floor: '9' });
    h.check('nor update one', clerkPatch.status === 403, `HTTP ${String(clerkPatch.status)}`);

    const count = await prisma.room.count({ where: { propertyId: fixture.propertyId } });
    h.check('no refused request created a room', count === 5, `${String(count)} rooms`);
  }
}

await runSuite({ harness: h, prisma, label: 'room CRUD integration', body });
