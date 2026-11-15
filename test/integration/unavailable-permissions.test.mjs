/**
 * AU-13 against the running API: a custom role cannot be granted a permission
 * whose feature is unbuilt, and no role view or session reports one.
 *
 * ISOLATION: suite-owned fixture (prefix ZZPRM), torn down here. Custom roles
 * created by the suite are removed with the property.
 */

import { createHarness, requireEnvironment, runSuite } from '../support/room-fixture.mjs';

const SUITE = 'unavailable permissions';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZPRM',
  slugPrefix: 'zz-prm-',
  emailDomain: 'prm.invalid',
  prisma,
});

const UNAVAILABLE = [
  'night_audit:read',
  'night_audit:execute',
  'housekeeping:read',
  'folio:refund',
  'channels:read',
  'channels:sync',
];

let fixture;

async function body() {
  console.log('\n════ unavailable permissions (AU-13) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();

  fixture = await h.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await h.assertOwnership(fixture, { types: 2, rooms: 0, grants: 1, stays: 0 });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);

  const base = `/properties/${fixture.propertyId}`;
  const admin = fixture.users.admin.cookie;

  console.log('\n1. A custom role cannot grant them.');
  for (const permission of UNAVAILABLE) {
    const res = await h.call('POST', `${base}/roles`, admin, {
      name: `Role ${permission}`,
      permissions: ['reservations:read', permission],
    });
    h.check(
      `${permission}: 400 naming why`,
      res.status === 400 && JSON.stringify(res.payload?.details ?? {}).includes('not'),
      `HTTP ${String(res.status)} ${JSON.stringify(res.payload?.details ?? '')}`,
    );
  }
  const custom = await prisma.role.count({ where: { propertyId: fixture.propertyId } });
  h.check('no refused role was created', custom === 0, `${String(custom)} roles`);

  const ok = await h.call('POST', `${base}/roles`, admin, {
    name: 'Front office lead',
    permissions: ['reservations:read', 'reservations:create'],
  });
  h.check(
    'a role of built features is still created: 201',
    ok.status === 201,
    `HTTP ${String(ok.status)} ${JSON.stringify(ok.payload?.details ?? ok.payload?.message ?? '')}`,
  );

  const patch = await h.call('PATCH', `${base}/roles/${ok.payload?.id}`, admin, {
    permissions: ['reservations:read', 'night_audit:execute'],
  });
  h.check('nor can an edit add one: 400', patch.status === 400, `HTTP ${String(patch.status)}`);

  console.log('\n2. Nothing reports them as granted.');
  const roles = await h.call('GET', `${base}/roles`, admin);
  h.check('roles: 200', roles.status === 200, `HTTP ${String(roles.status)}`);
  const shown = (roles.payload ?? []).flatMap((role) => role.permissions ?? []);
  h.check(
    'no role, system or custom, shows an unavailable permission',
    shown.length > 0 && shown.every((permission) => !UNAVAILABLE.includes(permission)),
    shown.filter((permission) => UNAVAILABLE.includes(permission)).join(', '),
  );

  const me = await h.call('GET', `${base}/me`, admin);
  const mine = me.payload?.permissions ?? me.payload?.session?.permissions ?? [];
  h.check(
    'my session permissions: 200 and none unavailable',
    me.status === 200 && mine.every((p) => !UNAVAILABLE.includes(p)),
    `HTTP ${String(me.status)}`,
  );
}

await runSuite({ harness: h, prisma, label: 'unavailable permission integration', body });
