/**
 * Tenant isolation: the request context, the Prisma extension and PostgreSQL
 * row-level security (CLAUDE.md section 3.2; MT-02, MT-03, MT-04, MT-05, MT-08).
 *
 * ===========================================================================
 * Each layer is tested on its own, because each exists to catch what the
 * others miss:
 *
 *   A. The catalog: every table with a NOT NULL "propertyId" has RLS enabled,
 *      forced and a policy, and the extension's model list agrees with it --
 *      so a new tenant table cannot ship unprotected without failing here.
 *   B. The database alone, through the API's own login (easeit_app): no
 *      setting sees nothing; a property setting sees only that property; a
 *      write for another property is refused; bypass sees everything.
 *   C. The extension alone: a tenant query with no scope throws; a scoped
 *      query is narrowed even with no where-clause; creates are stamped;
 *      another property's write is refused; raw SQL and relation includes
 *      are confined; withoutTenantScope widens, deliberately.
 *   D. The API: another property's records are not found -- never 403 --
 *      across modules.
 *
 * Needs the app login for the test database: APP_DATABASE_URL, or derived
 * from apps/api/.env's easeit_app DATABASE_URL with this database's name.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createHarness, requireEnvironment, runSuite, shiftDays, utcMidnight } from '../support/room-fixture.mjs';

const SUITE = 'tenant isolation';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const db = databaseModule.default ?? databaseModule;
const { createPrismaClient, createTenantClient, runInPropertyScope, withoutTenantScope, TENANT_SCOPED_MODELS, Prisma } = db;

const owner = createPrismaClient();

function appUrl(databaseName) {
  if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
  const env = readFileSync(new URL('../../apps/api/.env', import.meta.url), 'utf8');
  const raw = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m.exec(env)?.[1];
  if (!raw) throw new Error('No DATABASE_URL in apps/api/.env to derive the app login from.');
  const url = new URL(raw);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const h = createHarness({ suiteName: SUITE, prefix: 'ZZTIA', slugPrefix: 'zz-tia-', emailDomain: 'tia.invalid', prisma: owner });
const other = createHarness({ suiteName: `${SUITE} (B)`, prefix: 'ZZTIB', slugPrefix: 'zz-tib-', emailDomain: 'tib.invalid', prisma: owner });

const show = (res) => `HTTP ${String(res.status)} ${res.payload?.code ?? ''}`;

async function body() {
  console.log('\n════ tenant isolation (MT-02 .. MT-05, MT-08) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const A = await h.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }] });
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);
  for (const f of [A, B]) {
    await owner.inventoryDay.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({ propertyId: f.propertyId, roomTypeId: f.categoryA, stayDate: utcMidnight(shiftDays(f.today, i)), physical: 3 })),
    });
  }
  const book = async (f) => {
    const res = await h.call('POST', `/properties/${f.propertyCode}/reservations`, f.users.admin.cookie, {
      roomTypeId: f.categoryA, roomId: null, arrivalDate: shiftDays(f.today, 1), departureDate: shiftDays(f.today, 2),
      adults: 1, mealPlan: 'EP', source: 'WALK_IN', guests: [{ firstName: 'Tenant', lastName: f.propertyCode }], isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking failed: ${show(res)}`);
    const pay = await h.call('POST', `/properties/${f.propertyCode}/folios/by-booking/${res.payload.bookingCode}/payment`, f.users.admin.cookie, {
      method: 'CASH', amountMinor: 10000, remark: null, idempotencyKey: randomUUID(),
    });
    return { ...res.payload, folioId: pay.payload?.folioId };
  };
  const stayA = await book(A);
  const stayB = await book(B);

  /* ------------------------------------------------------------------ A */
  console.log('A. Every tenant table is protected, and the extension agrees.');
  const tables = await owner.$queryRaw`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy
      FROM information_schema.columns col
      JOIN pg_class c ON c.relname = col.table_name AND c.relnamespace = 'public'::regnamespace
     WHERE col.table_schema = 'public' AND col.column_name = 'propertyId' AND col.is_nullable = 'NO'
     ORDER BY 1`;
  const unprotected = tables.filter((t) => !t.rls || !t.forced || !t.policy).map((t) => t.name);
  h.check(`all ${String(tables.length)} tables with a NOT NULL propertyId have forced RLS and a policy`, tables.length >= 36 && unprotected.length === 0, unprotected.join(', '));
  const tableOf = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m.dbName ?? m.name]));
  const modelTables = [...TENANT_SCOPED_MODELS].map((m) => tableOf.get(m)).sort();
  const rlsTables = tables.map((t) => t.name).sort();
  h.check('the extension scopes exactly the RLS tables', JSON.stringify(modelTables) === JSON.stringify(rlsTables), `extension-only: ${modelTables.filter((t) => !rlsTables.includes(t)).join(',')} rls-only: ${rlsTables.filter((t) => !modelTables.includes(t)).join(',')}`);

  // The app login, raw (no extension): what the database alone enforces.
  // createPrismaClient reads DATABASE_URL when called, so it is pointed at the
  // app login for exactly this one client and restored straight after.
  const ownerUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = appUrl(serverDb);
  const rawApp = createPrismaClient();
  process.env.DATABASE_URL = ownerUrl;
  const role = await rawApp.$queryRaw`SELECT current_user AS who, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`;
  h.check('the API login is not a superuser and cannot bypass RLS', role[0].rolsuper === false && role[0].rolbypassrls === false, JSON.stringify(role[0]));
  let migrationsHidden = false;
  try {
    await rawApp.$queryRaw`SELECT 1 FROM _prisma_migrations LIMIT 1`;
  } catch {
    migrationsHidden = true;
  }
  h.check('and cannot read the migration history', migrationsHidden);

  /* ------------------------------------------------------------------ B */
  console.log('\nB. The database alone (the API login, no extension).');
  const count = async (setting) =>
    rawApp.$transaction(async (tx) => {
      if (setting?.property) await tx.$executeRaw`SELECT set_config('app.current_property_id', ${setting.property}, true)`;
      if (setting?.bypass) await tx.$executeRaw`SELECT set_config('app.tenant_bypass', 'on', true)`;
      const rows = await tx.$queryRaw`
        SELECT (SELECT count(*) FROM reservation)::int AS reservations,
               (SELECT count(*) FROM folio_line)::int AS lines,
               (SELECT count(*) FROM user_property_role)::int AS grants,
               (SELECT count(*) FROM reservation WHERE "propertyId" = ${B.propertyId}::uuid)::int AS foreign_b`;
      return rows[0];
    });
  const none = await count(null);
  h.check('no setting: zero rows in every tenant table', none.reservations === 0 && none.lines === 0 && none.grants === 0, JSON.stringify(none));
  const asA = await count({ property: A.propertyId });
  const ownerA = await owner.reservation.count({ where: { propertyId: A.propertyId } });
  h.check("property A's setting: exactly A's rows, none of B's", asA.reservations === ownerA && asA.foreign_b === 0 && asA.lines > 0, JSON.stringify(asA));
  const bypass = await count({ bypass: true });
  h.check('bypass: both properties', bypass.foreign_b > 0 && bypass.reservations >= ownerA + 1, JSON.stringify(bypass));
  let refused = null;
  try {
    await rawApp.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${A.propertyId}, true)`;
      await tx.$executeRaw`INSERT INTO reservation_note ("id","propertyId","reservationId","authorName","body") VALUES (${randomUUID()}::uuid, ${B.propertyId}::uuid, ${stayB.id}::uuid, 'suite', 'x')`;
    });
  } catch (error) {
    refused = String(error.message);
  }
  h.check("writing a row for B under A's setting is refused by the policy", refused !== null && /row-level security|42501|violates/i.test(refused), refused?.slice(0, 160));
  const touched = await rawApp.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_property_id', ${A.propertyId}, true)`;
    return tx.$executeRaw`UPDATE reservation SET "adults" = "adults" WHERE "id" = ${stayB.id}::uuid`;
  });
  h.check("updating B's row under A's setting touches nothing", touched === 0, String(touched));

  /* ------------------------------------------------------------------ C */
  console.log('\nC. The extension alone.');
  const scoped = createTenantClient(rawApp);
  let unscoped = null;
  try {
    await scoped.reservation.findMany({ take: 1 });
  } catch (error) {
    unscoped = error;
  }
  h.check('a tenant query with no scope throws TenantScopeError', unscoped?.name === 'TenantScopeError', String(unscoped?.message).slice(0, 120));
  h.check('a global model needs no scope', (await scoped.property.count({ where: { id: A.propertyId } })) === 1);
  await runInPropertyScope(A.propertyId, async () => {
    const all = await scoped.reservation.findMany({ select: { propertyId: true } });
    h.check('in A, findMany with no where returns only A', all.length === ownerA && all.every((r) => r.propertyId === A.propertyId), String(all.length));
    h.check("in A, B's reservation by id is not found", (await scoped.reservation.findUnique({ where: { id: stayB.id } })) === null);
    const updated = await scoped.reservation.updateMany({ where: { id: stayB.id }, data: { adults: 1 } });
    h.check("in A, updateMany cannot reach B's row", updated.count === 0);
    const note = await scoped.reservationNote.create({ data: { reservationId: stayA.id, authorName: 'suite', body: 'stamped' }, select: { propertyId: true } });
    h.check('in A, a create without propertyId is stamped with A', note.propertyId === A.propertyId);
    let crossWrite = null;
    try {
      await scoped.reservationNote.create({ data: { propertyId: B.propertyId, reservationId: stayB.id, authorName: 'suite', body: 'x' } });
    } catch (error) {
      crossWrite = error;
    }
    h.check("in A, a create naming B's property is refused", crossWrite?.name === 'TenantScopeError');
    const raw = await scoped.$queryRaw`SELECT count(*)::int AS n FROM reservation`;
    h.check('in A, raw SQL is confined by RLS', raw[0].n === ownerA, String(raw[0].n));
    const viaInclude = await scoped.property.findMany({ where: { id: { in: [A.propertyId, B.propertyId] } }, select: { id: true, reservations: { select: { id: true } } } });
    const leaked = viaInclude.find((p) => p.id === B.propertyId)?.reservations.length ?? 0;
    h.check("in A, a relation include from a global model shows none of B's rows", leaked === 0, String(leaked));
    const inTx = await scoped.$transaction(async (tx) => tx.reservation.count());
    h.check('in A, an interactive transaction is scoped too', inTx === ownerA, String(inTx));
    let batch = null;
    try {
      await scoped.$transaction([scoped.reservation.count()]);
    } catch (error) {
      batch = error;
    }
    h.check('array-form $transaction is refused (it cannot carry the scope)', batch?.name === 'TenantScopeError');
  });
  await withoutTenantScope('tenant-isolation suite: proving the bypass', async () => {
    const both = await scoped.reservation.count({ where: { id: { in: [stayA.id, stayB.id] } } });
    h.check('withoutTenantScope sees both properties', both === 2, String(both));
  });
  await rawApp.$disconnect();

  /* ------------------------------------------------------------------ D */
  console.log("\nD. The API: another property's records are not found, never forbidden.");
  const aBase = `/properties/${A.propertyCode}`;
  const aCookie = A.users.admin.cookie;
  const probes = [
    ['GET', `${aBase}/reservations/${stayB.id}`, undefined, 'reservation detail'],
    ['GET', `${aBase}/folios/by-booking/${stayB.bookingCode}`, undefined, 'folio by booking code'],
    ['POST', `${aBase}/folios/${stayB.folioId}/charge`, { description: 'x', netAmountMinor: 100 }, 'post a charge to its folio'],
    ['POST', `${aBase}/reservations/${stayB.id}/cancel`, { reason: 'x' }, 'cancel it'],
    ['POST', `${aBase}/reservations/${stayB.id}/no-show`, { reason: 'x' }, 'mark it a no-show'],
    ['PATCH', `${aBase}/room-types/${B.categoryA}`, { name: 'Renamed' }, 'rename its room type'],
  ];
  for (const [method, path, payload, label] of probes) {
    const res = await h.call(method, path, aCookie, payload);
    h.check(`${label}: 404`, res.status === 404, show(res));
  }
  const bStill = await owner.reservation.findFirst({ where: { id: stayB.id }, select: { status: true } });
  const bLines = await owner.folioLine.count({ where: { folioId: stayB.folioId } });
  h.check("B's stay and folio are untouched", bStill.status === 'CONFIRMED' && bLines === 1, `${bStill.status} ${String(bLines)}`);
  const otherHotel = await h.call('GET', `/properties/${B.propertyCode}/reservations/${stayB.id}`, aCookie);
  h.check("naming B's hotel without a grant there: 404", otherHotel.status === 404, show(otherHotel));

  /* ------------------------------------------------------------------ E */
  console.log('\nE. Cross-property routes still work under RLS, through their declared bypass.');
  const today = A.today;
  const portfolio = [
    ['GET', '/auth/session', undefined, 'session'],
    ['GET', '/properties/my-group', undefined, 'my properties'],
    ['GET', `/properties/group-calendar?startDate=${today}&endDate=${shiftDays(today, 6)}`, undefined, 'group calendar'],
    ['GET', `/properties/group-performance?startDate=${today}&endDate=${shiftDays(today, 6)}`, undefined, 'group performance'],
    ['GET', '/rbac/roles', undefined, 'role templates'],
    ['GET', '/health/outbox', undefined, 'outbox gauge'],
    ['POST', '/properties/select-context', { propertyId: A.propertyId }, 'switch property'],
    ['GET', `/properties/${A.propertyId}/me`, undefined, 'my permissions here (active-property guard)'],
    ['GET', `/properties/${A.propertyCode}/dashboard-summary`, undefined, 'property dashboard (counts in one transaction)'],
  ];
  for (const [method, path, payload, label] of portfolio) {
    const res = await h.call(method, path, aCookie, payload);
    h.check(`${label}: 200`, res.status === 200, `${show(res)} ${res.status >= 400 ? JSON.stringify(res.payload?.details ?? res.payload?.message ?? '') : ''}`);
  }
  const mine = await h.call('GET', '/properties/my-group', aCookie);
  const listed = JSON.stringify(mine.payload ?? {});
  h.check('my properties lists A and not B', listed.includes(A.propertyId) && !listed.includes(B.propertyId), show(mine));
}

await runSuite({
  harness: h,
  prisma: owner,
  label: 'tenant isolation integration',
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
