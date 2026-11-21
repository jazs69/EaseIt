/**
 * AU-13: permissions for unbuilt features are not grantable, and the list of
 * them stays true to the code.
 *
 * Pure: imports the rbac module's TypeScript source (Node strips the types)
 * and reads API source text. No database, API or Redis.
 *
 * The two-way check is the point. A permission listed as unavailable must be
 * enforced NOWHERE in the API (otherwise it has shipped and must be removed
 * from the list), and every permission NOT listed must be enforced SOMEWHERE
 * (otherwise it is grantable and inert -- the over-promise AU-13 exists to
 * stop). Either drift fails this suite.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  Permission,
  UNAVAILABLE_PERMISSIONS,
  isPermissionAvailable,
  permissionsForRoles,
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

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const apiRoot = new URL('../../apps/api/src', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const apiSource = sourceFiles(apiRoot)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

/** The Permission member names the API references as `Permission.X`. */
const keyByValue = Object.fromEntries(
  Object.entries(Permission).map(([name, value]) => [value, name]),
);
const enforced = (permission) =>
  new RegExp(`Permission\\.${keyByValue[permission]}\\b`).test(apiSource);

const unavailable = Object.keys(UNAVAILABLE_PERMISSIONS);

console.log('\n1. The unavailable list matches what the API enforces.');
// Empty since the channel manager shipped (CM-01..05). An empty list is a
// valid state; the two-way check below still guards every permission.
console.log(`  NOTE  unavailable today: ${unavailable.length === 0 ? 'none' : unavailable.join(', ')}`);
check(
  'the channel permissions are grantable now that the channel manager exists',
  ['channels:read', 'channels:sync', 'channels:manage'].every((p) => isPermissionAvailable(p)),
);
for (const permission of unavailable) {
  check(`${permission} is enforced nowhere in the API (feature unbuilt)`, !enforced(permission));
  check(
    `${permission} carries a reason for the role editor`,
    typeof UNAVAILABLE_PERMISSIONS[permission] === 'string' &&
      UNAVAILABLE_PERMISSIONS[permission].length > 0,
  );
}
const inert = ALL_PERMISSIONS.filter((p) => isPermissionAvailable(p) && !enforced(p));
check(
  'every grantable permission is enforced somewhere (no inert grants)',
  inert.length === 0,
  inert.length === 0 ? '' : `grantable but enforced nowhere: ${inert.join(', ')}`,
);

console.log('\n2. No role template grants an unavailable permission.');
for (const role of ALL_ROLES) {
  const granted = permissionsForRoles([role]);
  check(
    `${role} is granted none of them`,
    granted.every((p) => isPermissionAvailable(p)),
    granted.filter((p) => !isPermissionAvailable(p)).join(', '),
  );
}
check(
  'the templates still name them, so shipping a feature only deletes a list entry',
  unavailable.every((p) => ALL_ROLES.some((role) => DEFAULT_ROLE_PERMISSIONS[role].includes(p))),
);

console.log('\n3. Every path that could grant or report one filters it.');
const read = (relative) =>
  readFileSync(new URL(`../../apps/api/src/${relative}`, import.meta.url), 'utf8');
check(
  'custom-role create/update refuses them',
  /isPermissionAvailable/.test(read('modules/access-control/access-control.service.ts')),
);
check(
  'the session never reports them',
  /filter\(isPermissionAvailable\)/.test(read('modules/auth/auth.repository.ts')),
);
check(
  'the active-property context (/me, RBAC endpoints) drops them',
  /isPermissionAvailable\(permission\)/.test(read('common/guards/active-property.guard.ts')),
);
check(
  'role views never show them as granted',
  /filter\(isPermissionAvailable\)/.test(
    read('modules/access-control/access-control.repository.ts'),
  ),
);

console.log('');
if (failures > 0) {
  console.error(`${String(failures)} unavailable-permission check(s) failed.`);
  process.exit(1);
}
console.log('All unavailable-permission checks passed.');
