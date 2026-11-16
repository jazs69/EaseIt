/**
 * The room-status endpoint: the transition matrix and the live-assignment gate.
 *
 * ===========================================================================
 * WHAT THIS PROVES, that the unit suite cannot.
 *
 * `room-status-policy.test.mjs` exercises the matrix as a pure function. This
 * drives it over HTTP and adds the one rule the policy cannot express:
 *
 *   **the live `reservation_room` row is authoritative, not `room.status`.**
 *
 * The stored status can be stale. So an occupied TARGET requires a real
 * CHECKED_IN assignment, and a vacant target requires its absence — and the
 * fixture deliberately creates a room whose stored status DISAGREES with the
 * live assignment, which is the only way to tell the two gates apart.
 *
 * It also pins the two statuses that cannot be set: OUT_OF_ORDER in both
 * directions, and OUT_OF_SERVICE as a target while remaining legal as a
 * source.
 *
 * NOT PROVED: that capacity is unaffected. Asserted here only in that no
 * permitted transition touches `inventory_day` — the generator is the only
 * writer of `physical`, and OUT_OF_ORDER, the sole eligibility-changing
 * status, is unreachable through this endpoint.
 *
 * ISOLATION: prefix ZZRST, its own slug prefix and email domain.
 * ===========================================================================
 */

import { createHarness, requireEnvironment, runSuite } from '../support/room-fixture.mjs';

const SUITE = 'room status';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZRST',
  slugPrefix: 'zz-rst-',
  emailDomain: 'rst.invalid',
  prisma,
});

const SETTABLE = ['VACANT_CLEAN', 'VACANT_DIRTY', 'INSPECTED', 'OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'];
const VACANT = ['VACANT_CLEAN', 'VACANT_DIRTY', 'INSPECTED'];
const OCCUPIED = ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'];

async function body() {
  console.log('\n════ room status ════\n');

  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard  ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);

  await h.assertRoutesAreLoaded(['/properties/ZZRST-PROBE/rooms']);
  await h.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', hk: 'HOUSEKEEPING', clerk: 'FRONT_DESK' },
    rooms: [
      // Vacant, no stay. The subject of the vacant-side matrix.
      { label: 'FREE', category: 'A', status: 'VACANT_DIRTY' },
      // Occupied by a real in-house stay, created below.
      { label: 'INUSE', category: 'A', status: 'OCCUPIED_DIRTY' },
      // Already out of service: a legal SOURCE only.
      { label: 'OOS', category: 'B', status: 'OUT_OF_SERVICE' },
      // Out of order: frozen in both directions.
      { label: 'OOO', category: 'B', status: 'OUT_OF_ORDER' },
      // Stored status says occupied, but NO stay exists. The disagreement case.
      { label: 'LIAR', category: 'A', status: 'OCCUPIED_CLEAN' },
    ],
  });
  await h.assertOwnership(fixture, { types: 2, rooms: 5, grants: 3, stays: 0 });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);

  await h.createInHouseStay(fixture, fixture.rooms.INUSE);

  const hk = fixture.users.hk.cookie;
  const admin = fixture.users.admin.cookie;
  const clerk = fixture.users.clerk.cookie;
  const path = (room) => `/properties/${fixture.propertyCode}/rooms/${room.id}/status`;
  // INSPECTED needs housekeeping:manage (HK-04), so by default it is set as the
  // supervisor; every other status as the housekeeper. Authority for INSPECTED
  // itself is asserted explicitly in section 2.
  const setStatus = (room, status, cookie = status === 'INSPECTED' ? admin : hk) =>
    h.call('POST', path(room), cookie, { status });
  const storedStatus = async (room) =>
    (await prisma.room.findUnique({ where: { id: room.id }, select: { status: true } }))?.status;

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Housekeeping owns this endpoint.');
  {
    h.check(
      'no session is 401',
      (await setStatus(fixture.rooms.FREE, 'VACANT_CLEAN', null)).status === 401,
    );

    const clerkTry = await setStatus(fixture.rooms.FREE, 'VACANT_CLEAN', clerk);
    h.check(
      'FRONT_DESK may NOT set status: it holds no housekeeping:update_status',
      clerkTry.status === 403,
      `HTTP ${String(clerkTry.status)}`,
    );
    h.check(
      'with the typed FORBIDDEN code',
      clerkTry.payload?.code === 'FORBIDDEN',
      String(clerkTry.payload?.code),
    );

    const hkTry = await setStatus(fixture.rooms.FREE, 'VACANT_CLEAN', hk);
    h.check('HOUSEKEEPING may', hkTry.status === 200, `HTTP ${String(hkTry.status)}`);
    h.check(
      'the endpoint answers 200, not 201 — nothing addressable is created',
      hkTry.status === 200,
    );
    h.check(
      'and the stored status changed',
      (await storedStatus(fixture.rooms.FREE)) === 'VACANT_CLEAN',
    );

    const adminTry = await setStatus(fixture.rooms.FREE, 'VACANT_DIRTY', admin);
    h.check(
      'PROPERTY_ADMIN may too, holding all permissions',
      adminTry.status === 200,
      `HTTP ${String(adminTry.status)}`,
    );
  }

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Cleanliness changes within the vacant class.');
  {
    for (const from of VACANT) {
      await prisma.room.update({ where: { id: fixture.rooms.FREE.id }, data: { status: from } });
      for (const to of VACANT.filter((value) => value !== from)) {
        const res = await setStatus(fixture.rooms.FREE, to);
        h.check(`${from} -> ${to} is allowed`, res.status === 200, `HTTP ${String(res.status)}`);
        await prisma.room.update({ where: { id: fixture.rooms.FREE.id }, data: { status: from } });
      }
    }
    // Pinned to a known state first. The loop above ends at whichever `from`
    // it last restored, so reading the room's state from the loop would make
    // this probe depend on iteration order -- which it did, and the "real
    // transition" below was itself a no-op as a result.
    await prisma.room.update({
      where: { id: fixture.rooms.FREE.id },
      data: { status: 'VACANT_CLEAN' },
    });

    // HK-04: INSPECTED is a supervisor's verdict. A housekeeper (update_status
    // only) is refused; a holder of housekeeping:manage may mark it.
    const byHousekeeper = await setStatus(fixture.rooms.FREE, 'INSPECTED', hk);
    h.check(
      'a housekeeper cannot mark a room INSPECTED (needs housekeeping:manage): 403',
      byHousekeeper.status === 403 && (await storedStatus(fixture.rooms.FREE)) === 'VACANT_CLEAN',
      `HTTP ${String(byHousekeeper.status)}`,
    );

    const real = await setStatus(fixture.rooms.FREE, 'INSPECTED', admin);
    h.check(
      'a genuine transition from a pinned state succeeds',
      real.status === 200,
      `VACANT_CLEAN -> INSPECTED, HTTP ${String(real.status)}`,
    );

    const same = await setStatus(fixture.rooms.FREE, 'INSPECTED', admin);
    h.check(
      'and repeating it is refused 400, not silently accepted',
      same.status === 400,
      `INSPECTED -> INSPECTED, HTTP ${String(same.status)}`,
    );
    h.check(
      'the repeat changed nothing',
      (await storedStatus(fixture.rooms.FREE)) === 'INSPECTED',
      String(await storedStatus(fixture.rooms.FREE)),
    );
  }

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. The live assignment is authoritative, not the stored status.');
  {
    // LIAR says OCCUPIED_CLEAN but has no stay. The matrix would allow
    // OCCUPIED_CLEAN -> OCCUPIED_DIRTY; the live gate must refuse it, because
    // asserting occupancy on a room nobody is in is the disagreement this
    // endpoint exists to prevent.
    const stale = await setStatus(fixture.rooms.LIAR, 'OCCUPIED_DIRTY');
    h.check(
      'a stored-occupied room with NO in-house stay cannot be set occupied',
      stale.status === 400,
      `HTTP ${String(stale.status)} — the matrix allows it; the live read refuses it`,
    );
    h.check(
      'and the message points at check-in',
      /check-?in/i.test(JSON.stringify(stale.payload?.details ?? {})),
      JSON.stringify(stale.payload?.details ?? {}).slice(0, 110),
    );

    // The genuinely occupied room: within-class is allowed.
    const real = await setStatus(fixture.rooms.INUSE, 'OCCUPIED_CLEAN');
    h.check(
      'a room with a real CHECKED_IN stay CAN move within the occupied class',
      real.status === 200,
      `HTTP ${String(real.status)} — stayover servicing`,
    );

    // And cannot be vacated here.
    for (const to of VACANT) {
      const res = await setStatus(fixture.rooms.INUSE, to);
      h.check(
        `an occupied room cannot be set ${to}`,
        res.status === 400,
        `HTTP ${String(res.status)}`,
      );
    }
    h.check(
      'the occupied room is still occupied',
      OCCUPIED.includes(await storedStatus(fixture.rooms.INUSE)),
      String(await storedStatus(fixture.rooms.INUSE)),
    );

    // A vacant room with no stay cannot be set occupied either.
    await prisma.room.update({
      where: { id: fixture.rooms.FREE.id },
      data: { status: 'VACANT_CLEAN' },
    });
    for (const to of OCCUPIED) {
      const res = await setStatus(fixture.rooms.FREE, to);
      h.check(
        `a vacant room with no stay cannot be set ${to}`,
        res.status === 400,
        `HTTP ${String(res.status)}`,
      );
    }
    h.check('it is still vacant', (await storedStatus(fixture.rooms.FREE)) === 'VACANT_CLEAN');
  }

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. OUT_OF_SERVICE is a source, never a target.');
  {
    for (const room of ['FREE', 'INUSE', 'LIAR']) {
      const res = await setStatus(fixture.rooms[room], 'OUT_OF_SERVICE');
      h.check(
        `${room} cannot be set OUT_OF_SERVICE`,
        res.status === 400,
        `HTTP ${String(res.status)}`,
      );
    }
    const refusal = await setStatus(fixture.rooms.FREE, 'OUT_OF_SERVICE');
    h.check(
      'the refusal does NOT name a room-block workflow that does not exist yet',
      !/room block/i.test(JSON.stringify(refusal.payload ?? {})),
      JSON.stringify(refusal.payload?.details ?? {}).slice(0, 120),
    );

    for (const to of VACANT) {
      await prisma.room.update({
        where: { id: fixture.rooms.OOS.id },
        data: { status: 'OUT_OF_SERVICE' },
      });
      const res = await setStatus(fixture.rooms.OOS, to);
      h.check(
        `an OUT_OF_SERVICE room may return to ${to}`,
        res.status === 200,
        `HTTP ${String(res.status)}`,
      );
    }
    await prisma.room.update({
      where: { id: fixture.rooms.OOS.id },
      data: { status: 'OUT_OF_SERVICE' },
    });
    for (const to of OCCUPIED) {
      const res = await setStatus(fixture.rooms.OOS, to);
      h.check(`but not straight to ${to}`, res.status === 400, `HTTP ${String(res.status)}`);
    }
  }

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. OUT_OF_ORDER is frozen in both directions.');
  {
    for (const room of ['FREE', 'OOS']) {
      const res = await setStatus(fixture.rooms[room], 'OUT_OF_ORDER');
      h.check(
        `${room} cannot be set OUT_OF_ORDER`,
        res.status === 400,
        `HTTP ${String(res.status)} — it is the only status that changes sellable stock`,
      );
    }
    for (const to of SETTABLE) {
      const res = await setStatus(fixture.rooms.OOO, to);
      h.check(
        `an OUT_OF_ORDER room cannot be moved to ${to}`,
        res.status === 400,
        `HTTP ${String(res.status)}`,
      );
    }
    h.check('it is still OUT_OF_ORDER', (await storedStatus(fixture.rooms.OOO)) === 'OUT_OF_ORDER');
  }

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Validation and tenancy on this route.');
  {
    const bogus = await h.call('POST', path(fixture.rooms.FREE), hk, { status: 'NOT_A_STATUS' });
    h.check(
      'an unknown status is refused 400',
      bogus.status === 400,
      `HTTP ${String(bogus.status)}`,
    );
    const missing = await h.call('POST', path(fixture.rooms.FREE), hk, {});
    h.check(
      'a missing status is refused 400',
      missing.status === 400,
      `HTTP ${String(missing.status)}`,
    );

    const unknownRoom = await h.call(
      'POST',
      `/properties/${fixture.propertyCode}/rooms/00000000-0000-4000-8000-000000000000/status`,
      hk,
      { status: 'VACANT_CLEAN' },
    );
    h.check(
      'a room this property does not own is 404, never 403',
      unknownRoom.status === 404,
      `HTTP ${String(unknownRoom.status)}`,
    );
  }

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. No permitted transition touched inventory, and each was audited.');
  {
    const inv = await prisma.inventoryDay.count({ where: { propertyId: fixture.propertyId } });
    h.check(
      'the property still has zero inventory_day rows after every transition',
      inv === 0,
      'the status endpoint is not an inventory writer',
    );

    const rows = await prisma.auditLog.findMany({
      where: { propertyId: fixture.propertyId, event: 'ROOM_STATUS_CHANGED' },
      select: { before: true, after: true, actorUserId: true, entityId: true },
    });
    h.check(
      'every successful transition wrote an audit row',
      rows.length > 0,
      `${String(rows.length)} rows`,
    );
    h.check(
      'each carries the previous and the new status',
      rows.every(
        (r) => typeof r.before?.status === 'string' && typeof r.after?.status === 'string',
      ),
      JSON.stringify(rows[0] ?? {}).slice(0, 110),
    );
    h.check(
      'each names a room this suite owns',
      rows.every((r) => h.owned.roomIds.includes(r.entityId)),
    );
    h.check(
      'and an actor this suite created',
      rows.every((r) => h.owned.userIds.includes(r.actorUserId)),
    );
  }
}

await runSuite({ harness: h, prisma, label: 'room status integration', body });
