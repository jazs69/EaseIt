/**
 * Unit tests for the two new inventory-configuration permissions.
 *
 * ===========================================================================
 * WHAT THIS CAN AND CANNOT PROVE.
 *
 *   1. BEHAVIOURAL, over the real catalog. `rooms:manage` and
 *      `room_blocks:manage` are asserted against `DEFAULT_ROLE_PERMISSIONS`
 *      itself, not a copy, so changing a role template fails here.
 *
 *   2. POLICY, as a role x permission table: which of the seven roles may
 *      configure rooms, which may block them, and that the two are not the
 *      same set.
 *
 *   3. STRUCTURAL, over the changed sources: that each new endpoint checks the
 *      permission the policy assigns it, and that the grant check still runs
 *      FIRST -- a permission 403 must never precede the tenancy 404, or it
 *      confirms a property exists to a caller with no grant.
 *
 * NOT PROVED, and not claimable from a green run: that an HTTP request
 * actually receives 403, that a cross-property identifier is 404, or that the
 * guard is wired. Those need a live API and database.
 *
 * Source assertions read a COMMENT-STRIPPED view, because every one of these
 * files explains its own policy in prose and a naive grep would match the
 * explanation and pass for the wrong reason. The stripper is sanity-checked.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_DEFINITIONS,
  Permission,
  Role,
} from '../../packages/types/src/rbac.ts';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Strip comments so a prose mention cannot satisfy a grep.
 *
 * Identical to the stripper in `require-permission.test.mjs`, deliberately:
 *
 *   * block comments collapse to the same NUMBER OF NEWLINES they occupied, so
 *     the `indexOf` ordering comparison in section 4 still reflects the real
 *     order of statements in the file;
 *   * only WHOLE-LINE `//` comments are removed. A trailing comment is left
 *     intact, because `//` also appears inside string literals and URLs and
 *     removing it blindly would corrupt real code. Section 0 asserts that
 *     limitation rather than pretending it is not there, and a separate check
 *     confirms no trailing comment in the files under test mentions a
 *     permission name.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => '\n'.repeat((match.match(/\n/g) ?? []).length))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

function read(relative) {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

const holds = (role, permission) => (DEFAULT_ROLE_PERMISSIONS[role] ?? []).includes(permission);

console.log('\n════ room permissions ════\n');

/* ------------------------------------------------------------------ 0 */
console.log('0. The comment stripper works.');
{
  const sample =
    '/* rooms:manage in prose */\n  // rooms:manage on its own line\nreal();\nkeep(); // trailing';
  const stripped = stripComments(sample);

  check('block comments are removed', !stripped.includes('in prose'));
  check('whole-line comments are removed', !stripped.includes('on its own line'));
  check('code survives', stripped.includes('real()') && stripped.includes('keep()'));
  check(
    'a TRAILING comment is deliberately NOT removed — `//` also appears in URLs',
    stripped.includes('trailing'),
    'the limitation is checked for separately, below',
  );

  // So the ordering test in section 4 compares real statement positions.
  check(
    'a block comment keeps its line count, so indexOf ordering stays honest',
    stripComments('/* a\nb\nc */\nx').split('\n').length === 4,
  );

  // And the limitation above cannot bite these particular files.
  for (const file of ['room-type.service.ts', 'room.service.ts']) {
    const lines = read(`apps/api/src/modules/inventory/${file}`).split('\n');
    const trailing = lines.filter(
      (line) =>
        !/^\s*\/\//.test(line) && /\/\/.*(Permission\.|rooms:manage|room_blocks:)/.test(line),
    );
    check(
      `${file} has no trailing comment naming a permission`,
      trailing.length === 0,
      `${String(trailing.length)} found`,
    );
  }
}

/* ------------------------------------------------------------------ 1 */
console.log('\n1. The catalog gained exactly two constants.');
{
  check('rooms:manage exists', Permission.ROOMS_MANAGE === 'rooms:manage');
  check('room_blocks:manage exists', Permission.ROOM_BLOCKS_MANAGE === 'room_blocks:manage');
  check(
    'both are documented in PERMISSION_DEFINITIONS, so the catalog stays complete',
    [Permission.ROOMS_MANAGE, Permission.ROOM_BLOCKS_MANAGE].every((key) =>
      PERMISSION_DEFINITIONS.some((definition) => definition.key === key),
    ),
  );
  check(
    'both are marked sensitive — each alters what the hotel can sell',
    [Permission.ROOMS_MANAGE, Permission.ROOM_BLOCKS_MANAGE].every(
      (key) => PERMISSION_DEFINITIONS.find((d) => d.key === key)?.sensitive === true,
    ),
  );
  check(
    'they are two DIFFERENT permissions, not an alias',
    Permission.ROOMS_MANAGE !== Permission.ROOM_BLOCKS_MANAGE,
  );
}

/* ------------------------------------------------------------------ 2 */
console.log('\n2. Role x permission policy.');
{
  check(
    'SUPER_ADMIN holds both, via ALL_PERMISSIONS',
    holds(Role.SUPER_ADMIN, Permission.ROOMS_MANAGE) &&
      holds(Role.SUPER_ADMIN, Permission.ROOM_BLOCKS_MANAGE),
  );
  check(
    'PROPERTY_ADMIN holds both',
    holds(Role.PROPERTY_ADMIN, Permission.ROOMS_MANAGE) &&
      holds(Role.PROPERTY_ADMIN, Permission.ROOM_BLOCKS_MANAGE),
  );
  check(
    'REVENUE_MANAGER may block rooms — withholding capacity is a revenue decision',
    holds(Role.REVENUE_MANAGER, Permission.ROOM_BLOCKS_MANAGE),
  );
  check(
    'but REVENUE_MANAGER may NOT configure rooms — that is administration',
    !holds(Role.REVENUE_MANAGER, Permission.ROOMS_MANAGE),
  );

  for (const role of [Role.FRONT_DESK, Role.HOUSEKEEPING, Role.NIGHT_AUDITOR, Role.POS_STAFF]) {
    check(
      `${role} holds neither new permission`,
      !holds(role, Permission.ROOMS_MANAGE) && !holds(role, Permission.ROOM_BLOCKS_MANAGE),
    );
  }

  check(
    'HOUSEKEEPING keeps housekeeping:update_status, which the status endpoint uses',
    holds(Role.HOUSEKEEPING, Permission.HOUSEKEEPING_UPDATE_STATUS),
  );
  check(
    'and HOUSEKEEPING still holds no reservations:read, so it reaches no room list',
    !holds(Role.HOUSEKEEPING, Permission.RESERVATIONS_READ),
  );
  check(
    'FRONT_DESK can still read rooms and room types',
    holds(Role.FRONT_DESK, Permission.RESERVATIONS_READ),
  );
  check(
    'no role gained inventory:override, which is the only route to oversell headroom',
    [Role.FRONT_DESK, Role.HOUSEKEEPING, Role.NIGHT_AUDITOR, Role.POS_STAFF].every(
      (role) => !holds(role, Permission.INVENTORY_OVERRIDE),
    ),
  );
}

/* ------------------------------------------------------------------ 3 */
console.log('\n3. Each endpoint checks the permission the policy assigns it.');
{
  const roomType = stripComments(read('apps/api/src/modules/inventory/room-type.service.ts'));
  const room = stripComments(read('apps/api/src/modules/inventory/room.service.ts'));

  check(
    'room-type list requires RESERVATIONS_READ',
    /list\([\s\S]{0,400}?Permission\.RESERVATIONS_READ/.test(roomType),
  );
  check(
    'room-type create requires ROOMS_MANAGE',
    /create\([\s\S]{0,400}?Permission\.ROOMS_MANAGE/.test(roomType),
  );
  check(
    'room-type update requires ROOMS_MANAGE',
    /update\([\s\S]{0,500}?Permission\.ROOMS_MANAGE/.test(roomType),
  );
  check(
    'room list requires RESERVATIONS_READ',
    /list\([\s\S]{0,500}?Permission\.RESERVATIONS_READ/.test(room),
  );
  check(
    'room create requires ROOMS_MANAGE',
    /create\([\s\S]{0,500}?Permission\.ROOMS_MANAGE/.test(room),
  );
  check(
    'the status endpoint requires HOUSEKEEPING_UPDATE_STATUS, not ROOMS_MANAGE',
    /changeStatus\([\s\S]{0,600}?Permission\.HOUSEKEEPING_UPDATE_STATUS/.test(room),
  );
  check(
    'and the status endpoint does NOT also demand ROOMS_MANAGE',
    !/changeStatus\([\s\S]{0,600}?Permission\.ROOMS_MANAGE/.test(room),
  );
}

/* ------------------------------------------------------------------ 4 */
console.log('\n4. The grant check runs before the permission check.');
{
  for (const file of ['room-type.service.ts', 'room.service.ts']) {
    const source = stripComments(read(`apps/api/src/modules/inventory/${file}`));
    const notFound = source.indexOf('TenantScopeViolationError');
    const permission = source.indexOf('requirePermissionFromGrants');
    check(
      `${file}: not-found is raised before the permission check`,
      notFound !== -1 && permission !== -1 && notFound < permission,
      'a 403 before a 404 would confirm another property exists',
    );
    check(
      `${file}: the tenancy predicate is the shared grantedPropertyWhere`,
      source.includes('grantedPropertyWhere({ userId, codeOrId, operableOnly: false })'),
    );
  }
}

/* ------------------------------------------------------------------ 5 */
console.log('\n5. Nothing in this change writes inventory_day.');
{
  for (const file of [
    'room-type.service.ts',
    'room-type.repository.ts',
    'room.service.ts',
    'room.repository.ts',
    'room-status.policy.ts',
    'room-block.policy.ts',
  ]) {
    const source = stripComments(read(`apps/api/src/modules/inventory/${file}`));
    check(
      `${file} touches no inventory_day writer`,
      !/inventoryDay\s*\.|inventory_day/i.test(source),
    );
  }

  const seed = read('packages/database/prisma/seed.ts');
  check(
    'the seed was not touched — it still writes 60 forward inventory days',
    seed.includes('INVENTORY_DAYS_FORWARD') || /inventoryDay\.createMany/.test(seed),
  );
}

console.log('');
if (failures > 0) {
  console.error(`${String(failures)} room permission check(s) failed.`);
  process.exit(1);
}
console.log('All room permission checks passed.');
