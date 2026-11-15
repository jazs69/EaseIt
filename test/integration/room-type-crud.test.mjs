/**
 * Room-type CRUD, validation and permissions, over HTTP.
 *
 * ===========================================================================
 * WHAT THIS PROVES, that the unit suites cannot.
 *
 * `room-permissions.test.mjs` asserts that the service *names* the right
 * permission; this asserts that an HTTP request actually receives 403. It also
 * exercises the parts that only exist in the database: the two per-property
 * unique constraints, the `P2002` translation into a typed 409, and that money
 * survives the round trip as integer minor units.
 *
 * WHAT IT DOES NOT PROVE: anything about room blocks (no endpoints exist), or
 * about `inventory_day` — creating a category writes no counter row, which is
 * asserted here precisely because it is easy to assume otherwise.
 *
 * ISOLATION: its own prefix ZZRTC, its own slug prefix and its own email
 * domain, so it can neither see nor sweep another suite's fixtures.
 * ===========================================================================
 */

import { createHarness, requireEnvironment, runSuite } from '../support/room-fixture.mjs';

const SUITE = 'room-type CRUD';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRTC',
  slugPrefix: 'zz-rtc-',
  emailDomain: 'rtc.invalid',
  prisma,
});

async function body() {
  console.log('\n════ room-type CRUD ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard  ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded(['/properties/ZZRTC-PROBE/room-types']);
  await h.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', hk: 'HOUSEKEEPING' },
    rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertOwnership(fixture, { types: 2, rooms: 1, grants: 3, stays: 0 });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);

  const base = `/properties/${fixture.propertyCode}/room-types`;
  const admin = fixture.users.admin.cookie;
  const clerk = fixture.users.clerk.cookie;
  const hk = fixture.users.hk.cookie;

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Reading the fixture categories.');
  {
    const res = await h.call('GET', base, admin);
    h.check('GET answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    h.check(
      'both fixture categories are listed',
      res.payload?.items?.length === 2,
      String(res.payload?.items?.length),
    );
    h.check(
      'ordered by sortOrder then code',
      res.payload?.items?.[0]?.code === fixture.categoryACode,
      `${String(res.payload?.items?.[0]?.code)} first`,
    );
    const a = res.payload?.items?.find((item) => item.id === fixture.categoryA);
    h.check(
      'rack rate is reported as integer minor units + currency',
      a?.baseRate?.amountMinor === 500000 && a?.baseRate?.currency === 'INR',
      JSON.stringify(a?.baseRate),
    );
    h.check(
      'roomCount is the live count from the room table',
      a?.roomCount === 1,
      String(a?.roomCount),
    );
    h.check(
      'no server-owned or unread field leaks',
      a !== undefined &&
        !('propertyId' in a) &&
        !('overbookingAllowance' in a) &&
        !('createdAt' in a),
      Object.keys(a ?? {}).join(','),
    );
  }

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Creating a category.');
  let createdId = null;
  {
    const res = await h.call('POST', base, admin, {
      code: 'ZZRTCNEW',
      name: `ZZ Created ${fixture.runId}`,
      description: 'Made by the room-type CRUD suite.',
      maxGuests: 3,
      maxAdults: 2,
      baseRate: { amountMinor: 777700, currency: 'INR' },
      sortOrder: 9,
    });
    h.check('POST answers 201', res.status === 201, `HTTP ${String(res.status)}`);
    createdId = res.payload?.id ?? null;
    h.check('it comes back with an id', typeof createdId === 'string');
    h.check(
      'and the money it was given',
      res.payload?.baseRate?.amountMinor === 777700,
      JSON.stringify(res.payload?.baseRate),
    );
    h.check('with no rooms yet', res.payload?.roomCount === 0, String(res.payload?.roomCount));

    const row =
      createdId === null
        ? null
        : await prisma.roomType.findFirst({
            where: { id: createdId, propertyId: fixture.propertyId },
            select: {
              code: true,
              baseRateMinor: true,
              currency: true,
              maxAdults: true,
              overbookingAllowance: true,
            },
          });
    h.check('the row exists under THIS property', row !== null);
    h.check(
      'baseRateMinor is stored as an integer',
      row?.baseRateMinor === 777700,
      String(row?.baseRateMinor),
    );
    h.check('maxAdults was honoured', row?.maxAdults === 2, String(row?.maxAdults));
    h.check(
      'overbookingAllowance stays 0 — it is not settable here',
      row?.overbookingAllowance === 0,
      String(row?.overbookingAllowance),
    );
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. Creating a category writes no inventory.');
  {
    const rows = await prisma.inventoryDay.count({ where: { propertyId: fixture.propertyId } });
    h.check(
      'the property still has zero inventory_day rows',
      rows === 0,
      'generation is operator-triggered and separate',
    );
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Per-property uniqueness.');
  {
    const dupCode = await h.call('POST', base, admin, {
      code: 'ZZRTCNEW',
      name: `ZZ Different Name ${fixture.runId}`,
      maxGuests: 2,
      baseRate: { amountMinor: 100000, currency: 'INR' },
    });
    h.check(
      'a duplicate code is refused 409',
      dupCode.status === 409,
      `HTTP ${String(dupCode.status)}`,
    );
    h.check(
      'with the typed CONFLICT code',
      dupCode.payload?.code === 'CONFLICT',
      String(dupCode.payload?.code),
    );
    h.check(
      'and no Prisma driver code leaks',
      !/P2002|PrismaClient|Unique constraint/i.test(JSON.stringify(dupCode.payload ?? {})),
      JSON.stringify(dupCode.payload ?? {}).slice(0, 90),
    );

    const dupName = await h.call('POST', base, admin, {
      code: 'ZZRTCOTH',
      name: `ZZ Created ${fixture.runId}`,
      maxGuests: 2,
      baseRate: { amountMinor: 100000, currency: 'INR' },
    });
    h.check(
      'a duplicate name is refused 409 too',
      dupName.status === 409,
      `HTTP ${String(dupName.status)}`,
    );

    const after = await prisma.roomType.count({ where: { propertyId: fixture.propertyId } });
    h.check('neither refusal created a row', after === 3, `${String(after)} categories`);
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Validation.');
  {
    const cases = [
      [
        'a lowercase code',
        { code: 'lower', name: 'x', maxGuests: 2, baseRate: { amountMinor: 1, currency: 'INR' } },
      ],
      [
        'a missing name',
        { code: 'ZZRTCX1', maxGuests: 2, baseRate: { amountMinor: 1, currency: 'INR' } },
      ],
      [
        'maxGuests of 0',
        { code: 'ZZRTCX2', name: 'x', maxGuests: 0, baseRate: { amountMinor: 1, currency: 'INR' } },
      ],
      [
        'maxAdults above maxGuests',
        {
          code: 'ZZRTCX3',
          name: 'x',
          maxGuests: 2,
          maxAdults: 3,
          baseRate: { amountMinor: 1, currency: 'INR' },
        },
      ],
      [
        'a float amount',
        {
          code: 'ZZRTCX5',
          name: 'x',
          maxGuests: 2,
          baseRate: { amountMinor: 1.5, currency: 'INR' },
        },
      ],
      [
        'a bogus currency',
        { code: 'ZZRTCX6', name: 'x', maxGuests: 2, baseRate: { amountMinor: 1, currency: 'XX' } },
      ],
    ];
    for (const [label, payload] of cases) {
      const res = await h.call('POST', base, admin, payload);
      h.check(`${label} is refused 400`, res.status === 400, `HTTP ${String(res.status)}`);
    }

    const count = await prisma.roomType.count({ where: { propertyId: fixture.propertyId } });
    h.check('no invalid payload created anything', count === 3, `${String(count)} categories`);
  }

  /* ------------------------------------------------------------ 5b */
  console.log('\n5b. DEFECT-1 regression: a negative rack rate is a 400, not a 500.');
  {
    /**
     * `rackRateSchema` constrains the rack rate to be non-negative at the
     * boundary. `moneySchema` itself stays signed, because a folio line, a
     * refund and a reversal are all legitimately negative.
     *
     * Before the fix this answered 500: validation accepted -1 and
     * `room_type_rate_and_occupancy_sane` refused it, which is a CHECK
     * violation rather than a `P2002` and so was never translated.
     */
    const negative = await h.call('POST', base, admin, {
      code: 'ZZRTCNEG',
      name: `ZZ Negative ${fixture.runId}`,
      maxGuests: 2,
      baseRate: { amountMinor: -1, currency: 'INR' },
    });

    h.check(
      'a negative rack rate is refused 400, not 500',
      negative.status === 400,
      `HTTP ${String(negative.status)} — 500 would mean the DB CHECK is doing the refusing`,
    );
    h.check(
      'with the typed VALIDATION_FAILED code',
      negative.payload?.code === 'VALIDATION_FAILED',
      String(negative.payload?.code),
    );
    h.check(
      'naming the amount so a form can mark the field',
      typeof negative.payload?.details?.issues?.['baseRate.amountMinor'] === 'string',
      JSON.stringify(negative.payload?.details ?? {}).slice(0, 130),
    );
    h.check(
      'no SQL text, constraint name or driver code leaks',
      !/baseRateMinor|CHECK|constraint|P20\d\d|prisma/i.test(
        JSON.stringify(negative.payload ?? {}),
      ),
      JSON.stringify(negative.payload ?? {}).slice(0, 110),
    );
    h.check(
      'and no row with a negative rate exists',
      (await prisma.roomType.count({
        where: { propertyId: fixture.propertyId, baseRateMinor: { lt: 0 } },
      })) === 0,
    );

    // The constraint is a floor, not a ban: zero is a real configuration.
    const zero = await h.call('POST', base, admin, {
      code: 'ZZRTCZRO',
      name: `ZZ Zero Rate ${fixture.runId}`,
      maxGuests: 2,
      baseRate: { amountMinor: 0, currency: 'INR' },
    });
    h.check(
      'a ZERO rack rate is still accepted',
      zero.status === 201,
      `HTTP ${String(zero.status)} — a complimentary category is legitimate`,
    );
    h.check(
      'and stored as 0',
      zero.payload?.baseRate?.amountMinor === 0,
      JSON.stringify(zero.payload?.baseRate),
    );

    // PATCH is constrained by the same schema.
    const patchNegative = await h.call('PATCH', `${base}/${zero.payload?.id}`, admin, {
      baseRate: { amountMinor: -500, currency: 'INR' },
    });
    h.check(
      'PATCH rejects a negative rate too, with 400',
      patchNegative.status === 400,
      `HTTP ${String(patchNegative.status)}`,
    );
    h.check(
      'and the stored rate is untouched',
      (
        await prisma.roomType.findUnique({
          where: { id: zero.payload?.id },
          select: { baseRateMinor: true },
        })
      )?.baseRateMinor === 0,
    );

    // moneySchema itself must NOT have been constrained: money stays signed
    // wherever it is genuinely signed.
    const { moneySchema } = await import('../../packages/types/dist/money.js');
    h.check(
      'moneySchema is still signed — the fix did not widen to all money',
      moneySchema.safeParse({ amountMinor: -250, currency: 'INR' }).success === true,
      'refunds and reversals stay representable',
    );
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Updating a category.');
  {
    const res = await h.call('PATCH', `${base}/${createdId}`, admin, {
      name: `ZZ Renamed ${fixture.runId}`,
      baseRate: { amountMinor: 888800, currency: 'INR' },
    });
    h.check('PATCH answers 200', res.status === 200, `HTTP ${String(res.status)}`);
    h.check(
      'the new name is returned',
      res.payload?.name === `ZZ Renamed ${fixture.runId}`,
      String(res.payload?.name),
    );
    h.check(
      'and the new rate',
      res.payload?.baseRate?.amountMinor === 888800,
      JSON.stringify(res.payload?.baseRate),
    );
    h.check('the code is unchanged', res.payload?.code === 'ZZRTCNEW', String(res.payload?.code));

    const codeAttempt = await h.call('PATCH', `${base}/${createdId}`, admin, { code: 'ZZRTCMOD' });
    h.check(
      'code is not accepted as an editable field',
      codeAttempt.status === 400,
      `HTTP ${String(codeAttempt.status)} — zod rejects an object with no settable field`,
    );
    const stillCode = await prisma.roomType.findUnique({
      where: { id: createdId },
      select: { code: true },
    });
    h.check(
      'and the stored code did not change',
      stillCode?.code === 'ZZRTCNEW',
      String(stillCode?.code),
    );

    const empty = await h.call('PATCH', `${base}/${createdId}`, admin, {});
    h.check('an empty patch is refused 400', empty.status === 400, `HTTP ${String(empty.status)}`);

    const merged = await h.call('PATCH', `${base}/${createdId}`, admin, { maxGuests: 1 });
    h.check(
      'lowering maxGuests below a stored maxAdults is refused',
      merged.status === 400,
      `HTTP ${String(merged.status)} — validated against the MERGED state, not the request`,
    );
  }

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. An audit row per mutation.');
  {
    const rows = await prisma.auditLog.findMany({
      where: { propertyId: fixture.propertyId, entityType: 'room_type' },
      select: { event: true, actorUserId: true, entityId: true, before: true, after: true },
      orderBy: { createdAt: 'asc' },
    });
    h.check(
      'a created and an updated event were written',
      rows.length >= 2,
      rows.map((r) => r.event).join(','),
    );
    h.check(
      'the create has no before-state',
      rows.find((r) => r.event === 'ROOM_TYPE_CREATED')?.before === null,
    );
    h.check(
      'the update carries both before and after',
      rows.some((r) => r.event === 'ROOM_TYPE_UPDATED' && r.before !== null && r.after !== null),
    );
    h.check(
      'every row names the acting admin',
      rows.every((r) => r.actorUserId === fixture.users.admin.id),
    );
    h.check(
      'and this property only',
      (await prisma.auditLog.count({
        where: { propertyId: fixture.propertyId, entityType: 'room_type' },
      })) === rows.length,
    );
  }

  /* -------------------------------------------------------------- 8 */
  console.log('\n8. Permission enforcement over HTTP.');
  {
    // Snapshotted rather than hard-coded. An earlier hard-coded 3 went stale
    // the moment section 5b legitimately created a fourth category, which is
    // a test that fails for the wrong reason.
    const before = await prisma.roomType.count({ where: { propertyId: fixture.propertyId } });

    h.check('no session is 401', (await h.call('GET', base, null)).status === 401);

    const clerkRead = await h.call('GET', base, clerk);
    h.check(
      'FRONT_DESK may read: it holds reservations:read',
      clerkRead.status === 200,
      `HTTP ${String(clerkRead.status)}`,
    );

    const clerkWrite = await h.call('POST', base, clerk, {
      code: 'ZZRTCFD',
      name: 'x',
      maxGuests: 2,
      baseRate: { amountMinor: 1, currency: 'INR' },
    });
    h.check(
      'FRONT_DESK may NOT create: it lacks rooms:manage',
      clerkWrite.status === 403,
      `HTTP ${String(clerkWrite.status)}`,
    );
    h.check(
      'with the typed FORBIDDEN code',
      clerkWrite.payload?.code === 'FORBIDDEN',
      String(clerkWrite.payload?.code),
    );

    const clerkPatch = await h.call('PATCH', `${base}/${createdId}`, clerk, { name: 'nope' });
    h.check('nor update', clerkPatch.status === 403, `HTTP ${String(clerkPatch.status)}`);

    const hkRead = await h.call('GET', base, hk);
    h.check(
      'HOUSEKEEPING may not even read: it holds no reservations:read',
      hkRead.status === 403,
      `HTTP ${String(hkRead.status)} — rack rates are financial`,
    );

    const after = await prisma.roomType.count({ where: { propertyId: fixture.propertyId } });
    h.check(
      'no refused request created anything',
      after === before,
      `${String(after)} categories, unchanged from ${String(before)}`,
    );
  }
}

await runSuite({ harness: h, prisma, label: 'room-type CRUD integration', body });
