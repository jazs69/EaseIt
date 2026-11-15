/**
 * Cross-property isolation on every room and room-type endpoint.
 *
 * ===========================================================================
 * THE RULE BEING TESTED (CLAUDE.md section 3.2): another property's record
 * must answer **404, never 403**. A 403 confirms the record exists to a caller
 * who holds no grant at it, which is an information leak even when the write
 * is refused.
 *
 * There is NO Prisma tenancy extension and NO row-level security in this
 * repository — section 3.2 describes both and neither is implemented — so the
 * explicit `propertyId` predicate in each repository IS the control. That
 * makes this suite the compensating evidence, not a formality.
 *
 * TWO PROPERTIES, each with its own admin, and neither admin holding a grant
 * at the other. Every endpoint is then attacked three ways:
 *
 *   1. by the other property's CODE in the path          -> 404
 *   2. by the other property's UUID in the path          -> 404
 *   3. by this property's code with the other's RECORD id -> 404 (IDOR)
 *
 * The third is the one a `propertyId`-less `findUnique` would get wrong, and
 * it is where a cross-property write would actually land.
 *
 * ISOLATION: prefix ZZTEN, its own slug prefix and email domain. Both
 * properties carry the prefix, so teardown removes both — and a second
 * `owned` registry is kept for the second property, because the shared harness
 * records only one.
 * ===========================================================================
 */

import {
  createHarness,
  requireEnvironment,
  runSuite,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'inventory tenancy';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZTEN',
  slugPrefix: 'zz-ten-',
  emailDomain: 'ten.invalid',
  prisma,
});

/**
 * The SECOND property, recorded separately.
 *
 * The shared harness owns one property. This suite needs two, so the second is
 * tracked here with the same discipline: ids recorded the instant each row
 * exists, never discovered by lookup, and teardown drives off this object.
 */
const ownedB = {
  propertyId: null,
  propertyCode: null,
  userIds: [],
  roomTypeId: null,
  roomId: null,
};

async function buildSecondProperty(runId) {
  const roleRow = await prisma.role.findFirst({
    where: { key: 'PROPERTY_ADMIN', propertyId: null },
    select: { id: true },
  });
  if (roleRow === null) throw new Error('global PROPERTY_ADMIN role template is missing.');

  const property = await prisma.property.create({
    data: {
      slug: `zz-ten-b-${runId.toLowerCase()}`,
      code: `ZZTENB${runId}`,
      name: `ZZ Tenancy B ${runId}`,
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      businessDate: utcMidnight(new Date().toISOString().slice(0, 10)),
      status: 'ACTIVE',
    },
    select: { id: true, code: true },
  });
  ownedB.propertyId = property.id;
  ownedB.propertyCode = property.code;

  const user = await prisma.user.create({
    data: {
      email: `admin-b-${runId.toLowerCase()}@ten.invalid`,
      passwordHash: 'not-a-usable-hash',
      firstName: 'Harness',
      lastName: 'AdminB',
      isActive: true,
      isTwoFactorEnabled: false,
    },
    select: { id: true, email: true },
  });
  ownedB.userIds.push(user.id);
  await prisma.userPropertyRole.create({
    data: { userId: user.id, propertyId: property.id, roleId: roleRow.id },
  });

  const roomType = await prisma.roomType.create({
    data: {
      propertyId: property.id,
      code: 'ZZTENBA',
      name: `ZZ B Category ${runId}`,
      baseRateMinor: 600000,
      currency: 'INR',
      maxGuests: 2,
      sortOrder: 1,
    },
    select: { id: true },
  });
  ownedB.roomTypeId = roomType.id;

  const room = await prisma.room.create({
    data: {
      propertyId: property.id,
      roomTypeId: roomType.id,
      number: 'ZZTENB-1',
      status: 'VACANT_CLEAN',
    },
    select: { id: true, number: true },
  });
  ownedB.roomId = room.id;

  return { ...property, user, cookie: h.mintSession(user.id, user.email), roomType, room };
}

/** Remove the second property by recorded id, with the same prefix guard. */
async function teardownSecondProperty() {
  if (ownedB.propertyId === null) return;

  const row = await prisma.property.findUnique({
    where: { id: ownedB.propertyId },
    select: { id: true, code: true },
  });
  if (row !== null) {
    if (!row.code.startsWith('ZZTEN')) {
      throw new Error(
        `REFUSING to clean up property B: ${ownedB.propertyId} has code "${row.code}", ` +
          'which is not a ZZTEN fixture. Nothing was deleted.',
      );
    }
    await h.dropProperty(ownedB.propertyId);
    console.log(`  removed second fixture property ${row.code}`);
  }

  for (const userId of ownedB.userIds) {
    await prisma.user.deleteMany({ where: { id: userId, propertyRoles: { none: {} } } });
  }
}

async function body() {
  console.log('\n════ inventory tenancy ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard  ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded([
    '/properties/ZZTEN-PROBE/room-types',
    '/properties/ZZTEN-PROBE/rooms',
  ]);
  await h.sweepLeftovers();

  const a = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', hk: 'HOUSEKEEPING' },
    rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertOwnership(a, { types: 2, rooms: 1, grants: 2, stays: 0 });

  const b = await buildSecondProperty(a.runId);
  h.note(`second property ${b.code}=${b.id}; its category=${b.roomType.id} room=${b.room.id}`);

  h.check(
    'the two properties are distinct and neither admin is granted at the other',
    a.propertyId !== b.id &&
      (await prisma.userPropertyRole.count({
        where: { userId: a.users.admin.id, propertyId: b.id },
      })) === 0 &&
      (await prisma.userPropertyRole.count({
        where: { userId: b.user.id, propertyId: a.propertyId },
      })) === 0,
  );

  await h.assertApiSharesDatabase(a, a.users.admin.cookie, liveDb);

  const adminA = a.users.admin.cookie;
  const adminB = b.cookie;

  /* -------------------------------------------------------------- 1 */
  console.log("\n1. A's admin cannot reach B by code or by uuid.");
  {
    for (const [label, identifier] of [
      ['code', b.code],
      ['uuid', b.id],
    ]) {
      for (const [verb, path, payload] of [
        ['GET', `/properties/${identifier}/room-types`, undefined],
        ['GET', `/properties/${identifier}/rooms`, undefined],
        [
          'POST',
          `/properties/${identifier}/room-types`,
          {
            code: 'ZZTENX',
            name: 'intrusion',
            maxGuests: 2,
            baseRate: { amountMinor: 1, currency: 'INR' },
          },
        ],
        [
          'POST',
          `/properties/${identifier}/rooms`,
          {
            roomTypeId: b.roomType.id,
            number: 'ZZTENX-1',
          },
        ],
      ]) {
        const res = await h.call(verb, path, adminA, payload);
        h.check(
          `${verb} ${path.replace(identifier, `<B-${label}>`)} is 404`,
          res.status === 404,
          `HTTP ${String(res.status)}${res.status === 403 ? ' — a 403 would confirm B exists' : ''}`,
        );
      }
    }
  }

  /* -------------------------------------------------------------- 2 */
  console.log("\n2. IDOR: A's own code in the path, B's record id in the route.");
  {
    const cases = [
      ['PATCH', `/properties/${a.propertyCode}/room-types/${b.roomType.id}`, { name: 'stolen' }],
      ['PATCH', `/properties/${a.propertyCode}/rooms/${b.room.id}`, { floor: 'stolen' }],
      [
        'POST',
        `/properties/${a.propertyCode}/rooms/${b.room.id}/status`,
        { status: 'VACANT_DIRTY' },
      ],
    ];
    for (const [verb, path, payload] of cases) {
      const res = await h.call(verb, path, adminA, payload);
      h.check(
        `${verb} on B's record through A's property is 404`,
        res.status === 404,
        `HTTP ${String(res.status)} — this is where a propertyId-less lookup would land`,
      );
    }

    // And nothing of B's moved.
    const bType = await prisma.roomType.findUnique({
      where: { id: b.roomType.id },
      select: { name: true },
    });
    const bRoom = await prisma.room.findUnique({
      where: { id: b.room.id },
      select: { floor: true, status: true },
    });
    h.check("B's category name is untouched", bType?.name !== 'stolen', String(bType?.name));
    h.check("B's room floor is untouched", bRoom?.floor === null, String(bRoom?.floor));
    h.check(
      "B's room status is untouched",
      bRoom?.status === 'VACANT_CLEAN',
      String(bRoom?.status),
    );
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. The reverse direction, so neither is a one-way accident.');
  {
    const cases = [
      ['GET', `/properties/${a.propertyCode}/room-types`, undefined],
      ['GET', `/properties/${a.propertyCode}/rooms`, undefined],
      ['PATCH', `/properties/${b.code}/room-types/${a.categoryA}`, { name: 'stolen' }],
      ['PATCH', `/properties/${b.code}/rooms/${a.rooms.A1.id}`, { floor: 'stolen' }],
      ['POST', `/properties/${b.code}/rooms/${a.rooms.A1.id}/status`, { status: 'VACANT_DIRTY' }],
    ];
    for (const [verb, path, payload] of cases) {
      const res = await h.call(verb, path, adminB, payload);
      h.check(
        `B's admin: ${verb} ${path} is 404`,
        res.status === 404,
        `HTTP ${String(res.status)}`,
      );
    }

    const aType = await prisma.roomType.findUnique({
      where: { id: a.categoryA },
      select: { name: true },
    });
    h.check("A's category name is untouched", aType?.name !== 'stolen', String(aType?.name));
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. A 404 is returned for a property that simply does not exist, too.');
  {
    // So 404 cannot be read as "exists but forbidden" in one case and
    // "does not exist" in another: both are indistinguishable, by design.
    const nowhere = await h.call('GET', '/properties/ZZTEN-NOPE/room-types', adminA);
    h.check(
      'an unknown property code is 404',
      nowhere.status === 404,
      `HTTP ${String(nowhere.status)}`,
    );
    const nowhereUuid = await h.call(
      'GET',
      '/properties/00000000-0000-4000-8000-000000000000/room-types',
      adminA,
    );
    h.check(
      'an unknown property uuid is 404',
      nowhereUuid.status === 404,
      `HTTP ${String(nowhereUuid.status)}`,
    );

    const real = await h.call('GET', `/properties/${b.code}/room-types`, adminA);
    h.check(
      'a REAL property the caller has no grant at is also 404 — indistinguishable',
      real.status === nowhere.status,
      `${String(real.status)} vs ${String(nowhere.status)}`,
    );
    h.check(
      'and the bodies are indistinguishable too',
      real.payload?.code === nowhere.payload?.code,
      `${String(real.payload?.code)} vs ${String(nowhere.payload?.code)}`,
    );
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Each admin CAN reach their own property, so 404 is not blanket.');
  {
    const ownA = await h.call('GET', `/properties/${a.propertyCode}/room-types`, adminA);
    h.check("A's admin reads A", ownA.status === 200, `HTTP ${String(ownA.status)}`);
    const ownB = await h.call('GET', `/properties/${b.code}/room-types`, adminB);
    h.check("B's admin reads B", ownB.status === 200, `HTTP ${String(ownB.status)}`);
    h.check(
      "and sees only B's category",
      ownB.payload?.items?.length === 1 && ownB.payload?.items?.[0]?.id === b.roomType.id,
      `${String(ownB.payload?.items?.length)} item(s)`,
    );
    h.check(
      "A's list does not contain any of B's records",
      !ownA.payload?.items?.some((item) => item.id === b.roomType.id),
    );
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Permission refusal never precedes the tenancy refusal.');
  {
    // A's housekeeper holds no reservations:read, so a GET at their OWN
    // property is 403. The same GET at B must still be 404: the grant check
    // has to run first, or the 403 would leak B's existence to someone who
    // cannot even read their own.
    const ownRead = await h.call(
      'GET',
      `/properties/${a.propertyCode}/room-types`,
      a.users.hk.cookie,
    );
    h.check(
      "A's housekeeper gets 403 at their own property",
      ownRead.status === 403,
      `HTTP ${String(ownRead.status)}`,
    );

    const foreignRead = await h.call('GET', `/properties/${b.code}/room-types`, a.users.hk.cookie);
    h.check(
      "but 404 at B's — the grant check runs BEFORE the permission check",
      foreignRead.status === 404,
      `HTTP ${String(foreignRead.status)} — a 403 here would confirm B exists`,
    );
  }

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. No audit row crossed a property boundary.');
  {
    const crossA = await prisma.auditLog.count({
      where: { propertyId: a.propertyId, actorUserId: b.user.id },
    });
    const crossB = await prisma.auditLog.count({
      where: { propertyId: b.id, actorUserId: a.users.admin.id },
    });
    h.check("no audit row at A names B's admin", crossA === 0, String(crossA));
    h.check("no audit row at B names A's admin", crossB === 0, String(crossB));
    h.check(
      'B has no audit rows at all — every intrusion was refused before any write',
      (await prisma.auditLog.count({ where: { propertyId: b.id } })) === 0,
    );
  }
}

try {
  await runSuite({
    harness: h,
    prisma,
    label: 'inventory tenancy integration',
    body: async () => {
      try {
        await body();
      } finally {
        // Property B is this suite's own, so it is removed here regardless of
        // how `body` ended — before the shared teardown closes the client.
        await teardownSecondProperty();
      }
    },
  });
} finally {
  if (ownedB.propertyId !== null) {
    console.log(`  second property id for recovery if needed: ${ownedB.propertyId}`);
  }
}
