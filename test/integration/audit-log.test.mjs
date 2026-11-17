/**
 * The audit log viewer (AD-03) against the running API.
 *
 * ===========================================================================
 * Asserts, in order:
 *   1. A real audited write (a room status change) appears at the top of the
 *      log with its actor's name and its before/after.
 *   2. `audit_log:read` is required: a front-desk clerk is 403 naming it.
 *   3. Tenant isolation (CLAUDE.md section 3.2): another property's log and
 *      facets are 404, never 403; filtering by another property's record id
 *      returns nothing; a cursor naming another property's entry is refused.
 *   4. Filters: actor, `system`, entity type, entity id, event.
 *   5. Dates are the HOTEL's calendar: entries one second either side of
 *      Kolkata midnight fall on the right day.
 *   6. Paging walks every row exactly once, newest first, including rows that
 *      share a timestamp and rows a microsecond apart inside one millisecond
 *      -- the case a JavaScript-encoded cursor gets wrong.
 *   7. Facets list only this property's actors, entity types and events.
 *   8. Malformed queries are 400s.
 *
 * ISOLATION: two suite-owned properties (prefixes ZZAUA / ZZAUB), created and
 * torn down here. Audit rows are seeded directly into those properties only;
 * they cascade away with the property.
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import { WHOLLY_DISPOSABLE } from '../support/isolation-guard.mjs';
import { createHarness, requireEnvironment, runSuite } from '../support/room-fixture.mjs';

const SUITE = 'audit log viewer';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZAUA',
  slugPrefix: 'zz-aua-',
  emailDomain: 'aua.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (B)`,
  prefix: 'ZZAUB',
  slugPrefix: 'zz-aub-',
  emailDomain: 'aub.invalid',
  prisma,
});

const show = (res) => `HTTP ${String(res.status)} ${res.payload?.code ?? ''}`;

/** Inserts an audit row at an exact instant (microsecond text, so precision survives). */
async function seed(
  propertyId,
  {
    at,
    actor = null,
    event = 'TEST_EVENT',
    entityType = 'probe',
    entityId = randomUUID(),
    before = null,
    after = null,
    reason = null,
  },
) {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "audit_log" ("id", "propertyId", "actorUserId", "event", "entityType", "entityId", "before", "after", "reason", "createdAt")
    VALUES (${id}::uuid, ${propertyId}::uuid, ${actor}::uuid, ${event}, ${entityType}, ${entityId}::uuid,
            ${before === null ? null : JSON.stringify(before)}::jsonb, ${after === null ? null : JSON.stringify(after)}::jsonb,
            ${reason}, ${at}::timestamptz)`;
  return id;
}

async function body() {
  console.log('\n════ audit log viewer (AD-03) ════\n');
  const liveDb = await h.guardDatabase();
  // Asked of the SERVER, like the harness's own check, but this suite also
  // accepts a wholly disposable database: it touches nothing it did not create.
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
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK' },
    rooms: [{ label: 'R1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);
  await h.assertRoutesAreLoaded([`/properties/${A.propertyCode}/audit-log`]);

  const admin = A.users.admin.cookie;
  const base = `/properties/${A.propertyCode}/audit-log`;
  const list = (query = '') => h.call('GET', `${base}${query}`, admin);

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. A real audited write appears, with its actor and before/after.');
  const room = A.rooms.R1;
  const write = await h.call(
    'POST',
    `/properties/${A.propertyCode}/rooms/${room.id}/status`,
    admin,
    { status: 'VACANT_DIRTY' },
  );
  h.check('room status change: 2xx', write.status >= 200 && write.status < 300, show(write));
  const top = await list('?limit=5');
  h.check('list: 200', top.status === 200, show(top));
  const entry = top.payload?.items?.[0];
  h.check(
    'newest entry is that change',
    entry?.event === 'ROOM_STATUS_CHANGED' && entry?.entityId === room.id,
    `${String(entry?.event)} ${String(entry?.entityId)}`,
  );
  h.check(
    'with the actor named',
    entry?.actor?.id === A.users.admin.id && entry.actor.name === 'Harness admin',
    JSON.stringify(entry?.actor),
  );
  h.check(
    'and before/after as written',
    entry?.before?.status === 'VACANT_CLEAN' && entry?.after?.status === 'VACANT_DIRTY',
    JSON.stringify({ b: entry?.before, a: entry?.after }),
  );
  h.check(
    'and the hotel timezone on the page',
    top.payload?.timeZone === 'Asia/Kolkata',
    String(top.payload?.timeZone),
  );

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. audit_log:read is required.');
  const clerk = await h.call('GET', base, A.users.clerk.cookie);
  h.check(
    'front desk: 403 naming audit_log:read',
    clerk.status === 403 && JSON.stringify(clerk.payload ?? {}).includes('audit_log:read'),
    show(clerk),
  );
  const clerkFacets = await h.call('GET', `${base}/facets`, A.users.clerk.cookie);
  h.check('front desk facets: 403', clerkFacets.status === 403, show(clerkFacets));

  /* -------------------------------------------------------------- 3 */
  console.log('\n3. Another property is not found, never forbidden.');
  const bEntity = randomUUID();
  const bEntry = await seed(B.propertyId, {
    at: '2026-06-01T10:00:00Z',
    entityType: 'probe',
    entityId: bEntity,
    actor: B.users.admin.id,
    event: 'B_ONLY_EVENT',
  });
  for (const path of [
    `/properties/${B.propertyCode}/audit-log`,
    `/properties/${B.propertyId}/audit-log`,
    `/properties/${B.propertyCode}/audit-log/facets`,
  ]) {
    const res = await h.call('GET', path, admin);
    h.check(
      `${path.replace(B.propertyCode, 'B').replace(B.propertyId, 'B-id')}: 404`,
      res.status === 404,
      show(res),
    );
  }
  const byForeignId = await list(`?entityId=${bEntity}`);
  h.check(
    "filtering by B's record id from A: 200 and empty",
    byForeignId.status === 200 && byForeignId.payload?.items?.length === 0,
    show(byForeignId),
  );
  const foreignCursor = await list(`?cursor=${bEntry}`);
  h.check(
    "a cursor naming B's entry: 400 on cursor",
    foreignCursor.status === 400 && JSON.stringify(foreignCursor.payload ?? {}).includes('cursor'),
    show(foreignCursor),
  );
  const junkCursor = await list('?cursor=not-a-cursor');
  h.check('a junk cursor: 400', junkCursor.status === 400, show(junkCursor));

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Filters.');
  const folioId = randomUUID();
  const actorEntry = await seed(A.propertyId, {
    at: '2026-06-02T10:00:00Z',
    actor: A.users.clerk.id,
    event: 'FOLIO_PAYMENT_POSTED',
    entityType: 'folio',
    entityId: folioId,
    after: { amountMinor: 150000, currency: 'INR' },
    reason: 'deposit',
  });
  const systemEntry = await seed(A.propertyId, {
    at: '2026-06-02T11:00:00Z',
    actor: null,
    event: 'NIGHT_AUDIT_ROOM_CHARGE',
    entityType: 'folio',
    entityId: folioId,
  });
  const byActor = await list(`?actor=${A.users.clerk.id}`);
  h.check(
    'actor = clerk: only the clerk',
    byActor.status === 200 &&
      byActor.payload.items.length === 1 &&
      byActor.payload.items[0].id === actorEntry,
    show(byActor),
  );
  h.check(
    'reason and money come back as stored',
    byActor.payload?.items?.[0]?.reason === 'deposit' &&
      byActor.payload.items[0].after?.amountMinor === 150000,
  );
  const bySystem = await list('?actor=system');
  h.check(
    'actor = system: entries with no human actor',
    bySystem.status === 200 &&
      bySystem.payload.items.some((i) => i.id === systemEntry) &&
      bySystem.payload.items.every((i) => i.actor === null),
    show(bySystem),
  );
  const byEntity = await list(`?entityType=folio&entityId=${folioId}`);
  h.check(
    'entity type + id: both folio entries',
    byEntity.status === 200 && byEntity.payload.items.length === 2,
    `${String(byEntity.payload?.items?.length)}`,
  );
  const byEvent = await list('?event=NIGHT_AUDIT_ROOM_CHARGE');
  h.check(
    'event: exactly that event',
    byEvent.status === 200 &&
      byEvent.payload.items.length === 1 &&
      byEvent.payload.items[0].id === systemEntry,
    show(byEvent),
  );
  const byB = await list('?event=B_ONLY_EVENT');
  h.check("B's event name from A: empty", byB.status === 200 && byB.payload.items.length === 0);

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. Dates are the hotel’s calendar (Asia/Kolkata, UTC+05:30).');
  const day = 'probe-day';
  const justBefore = await seed(A.propertyId, { at: '2026-06-09T18:29:59Z', entityType: day }); // 9 Jun 23:59:59 IST
  const firstSecond = await seed(A.propertyId, { at: '2026-06-09T18:30:00Z', entityType: day }); // 10 Jun 00:00:00 IST
  const lastSecond = await seed(A.propertyId, { at: '2026-06-10T18:29:59Z', entityType: day }); // 10 Jun 23:59:59 IST
  const nextDay = await seed(A.propertyId, { at: '2026-06-10T18:30:00Z', entityType: day }); // 11 Jun 00:00:00 IST
  const tenth = await list(`?entityType=${day}&from=2026-06-10&to=2026-06-10`);
  const tenthIds = (tenth.payload?.items ?? []).map((i) => i.id);
  h.check(
    '10 June (IST) holds exactly its own first and last second',
    tenth.status === 200 &&
      tenthIds.length === 2 &&
      tenthIds.includes(firstSecond) &&
      tenthIds.includes(lastSecond),
    `${show(tenth)} ${String(tenthIds.length)}`,
  );
  h.check(
    'not 23:59:59 the day before, nor 00:00 the day after',
    !tenthIds.includes(justBefore) && !tenthIds.includes(nextDay),
  );
  const fromOnly = await list(`?entityType=${day}&from=2026-06-11`);
  h.check(
    'from 11 June: only the next-day entry',
    fromOnly.payload?.items?.length === 1 && fromOnly.payload.items[0].id === nextDay,
  );
  const toOnly = await list(`?entityType=${day}&to=2026-06-09`);
  h.check(
    'to 9 June: only the day-before entry',
    toOnly.payload?.items?.length === 1 && toOnly.payload.items[0].id === justBefore,
  );

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Paging: every row once, newest first, at microsecond precision.');
  const pageType = 'probe-page';
  const expected = [];
  // Five sharing one exact instant, three a microsecond apart inside one millisecond, four spread out.
  for (let i = 0; i < 5; i += 1)
    expected.push(
      await seed(A.propertyId, { at: '2026-06-12T10:00:00.000500Z', entityType: pageType }),
    );
  for (const micro of ['100', '200', '300'])
    expected.push(
      await seed(A.propertyId, { at: `2026-06-12T09:00:00.000${micro}Z`, entityType: pageType }),
    );
  for (const hour of ['05', '06', '07', '08'])
    expected.push(
      await seed(A.propertyId, { at: `2026-06-12T${hour}:00:00Z`, entityType: pageType }),
    );
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await list(
      `?entityType=${pageType}&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`,
    );
    if (res.status !== 200) {
      h.check('page: 200', false, show(res));
      break;
    }
    seen.push(...res.payload.items);
    cursor = res.payload.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < 20);
  const ids = seen.map((i) => i.id);
  h.check(
    '12 rows over 4 pages of 3',
    ids.length === 12 && pages === 4,
    `${String(ids.length)} rows, ${String(pages)} pages`,
  );
  h.check('no row twice', new Set(ids).size === ids.length);
  h.check(
    'no row missed',
    expected.every((id) => ids.includes(id)),
    `${String(expected.filter((id) => !ids.includes(id)).length)} missing`,
  );
  const times = seen.map((i) => Date.parse(i.at));
  h.check(
    'newest first',
    times.every((t, i) => i === 0 || t <= times[i - 1]),
  );
  const last = seen.length > 0 ? await list(`?entityType=${pageType}&limit=12`) : null;
  h.check('one page of 12 has no next cursor', last?.payload?.nextCursor === null);

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. Facets are this property’s only.');
  const facets = await h.call('GET', `${base}/facets`, admin);
  h.check('facets: 200', facets.status === 200, show(facets));
  const actorIds = (facets.payload?.actors ?? []).map((a) => a.id);
  h.check(
    'actors: admin and clerk, named',
    actorIds.includes(A.users.admin.id) &&
      actorIds.includes(A.users.clerk.id) &&
      facets.payload.actors.every((a) => a.name.length > 0),
  );
  h.check("not B's admin", !actorIds.includes(B.users.admin.id));
  h.check(
    'entity types include folio and room',
    facets.payload?.entityTypes?.includes('folio') && facets.payload.entityTypes.includes('room'),
  );
  h.check(
    "events exclude B's",
    facets.payload?.events?.includes('ROOM_STATUS_CHANGED') &&
      !facets.payload.events.includes('B_ONLY_EVENT'),
  );

  /* -------------------------------------------------------------- 8 */
  console.log('\n8. Malformed queries are 400s.');
  for (const [query, label] of [
    ['?from=2026-06-11&to=2026-06-10', 'from after to'],
    ['?from=2026-02-30', 'impossible date'],
    ['?actor=someone', 'actor neither a uuid nor system'],
    ['?entityId=123', 'entity id not a uuid'],
    ['?limit=1000', 'limit over 100'],
    ['?event=DROP%20TABLE', 'event with a space'],
  ]) {
    const res = await list(query);
    h.check(`${label}: 400`, res.status === 400, show(res));
  }
}

await runSuite({
  harness: h,
  prisma,
  label: 'audit log viewer integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
