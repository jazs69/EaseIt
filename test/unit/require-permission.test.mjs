/**
 * Unit tests for the approved single-hotel pilot authorization policy.
 *
 * ===========================================================================
 * WHAT THIS CAN AND CANNOT PROVE.
 *
 * Nine endpoints were approved for a permission check. Seven are implemented
 * (the two provider-proxy lookups have no property context to check against --
 * see the report accompanying this change), and this suite defends them at the
 * only level reachable without a database:
 *
 *   1. BEHAVIOURAL, over the pure helper. `requirePermission` is a plain
 *      function over `DEFAULT_ROLE_PERMISSIONS`, so every role/permission pair
 *      the policy names is asserted directly against the real catalog rather
 *      than against a copy of it.
 *
 *   2. POLICY, as a role x endpoint table. This is the part that would
 *      otherwise live only in a PR description: FRONT_DESK may create a
 *      booking, NIGHT_AUDITOR may not, HOUSEKEEPING reaches none of the six
 *      broad reads. Asserted from the catalog, so changing a role template
 *      fails here instead of silently widening an endpoint.
 *
 *   3. STRUCTURAL, over the changed sources. That each service checks the
 *      permission the policy assigns it, that the grant check still runs
 *      FIRST (a permission 403 must never precede the tenancy 404, or it
 *      confirms a property exists to a caller with no grant), and that the
 *      thirteen `grantedPropertyWhere` call sites kept their `operableOnly`
 *      values.
 *
 * NOT PROVED HERE, and not claimable from a green run: that an HTTP request
 * actually receives 403, that a cross-property identifier is still 404, and
 * that a caller holding the permission but no grant at the target property is
 * refused. All three need a live API and database. They belong to the
 * integration suites and are listed as unrun in the report.
 *
 * Source assertions read a COMMENT-STRIPPED view. Every one of these files
 * explains its own policy in prose, so a naive grep matches the explanation
 * and passes for the wrong reason -- which has happened repeatedly in this
 * repository. The stripper is itself sanity-checked below.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import {
  grantsCarryPermission,
  hasPermission,
  systemRoleKeys,
} from '../../apps/api/src/common/property-scope/permission-policy.ts';
import {
  ALL_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
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
 * `requirePermission` refuses exactly when the predicate is false.
 *
 * The thrower itself is NOT imported here: it needs
 * `../errors/domain-error.js`, and Node's type stripping will not resolve a
 * `.js` specifier to the `.ts` beside it. So the refusal *condition* is
 * asserted against the pure predicate, and the thrower's shape -- that it
 * raises `ForbiddenError(required)` on exactly that condition, and nothing
 * else -- is asserted structurally over its source further down. Two cheap
 * checks instead of one loader.
 */
const refuses = (roles, permission) => !hasPermission(roles, permission);

const grantsFor = (...keys) => keys.map((key) => ({ role: { key } }));

/* ========================================================================== */
console.log('Single-hotel pilot authorization policy (pure)\n');

/* -------------------------------------------------------------------------- */
/*  1. The helper itself                                                      */
/* -------------------------------------------------------------------------- */

console.log('systemRoleKeys: unions real roles, drops custom ones.');

check(
  'a single system role survives',
  JSON.stringify(systemRoleKeys(grantsFor(Role.FRONT_DESK))) === JSON.stringify([Role.FRONT_DESK]),
);
check(
  'several roles at one property are all kept, in order',
  JSON.stringify(systemRoleKeys(grantsFor(Role.FRONT_DESK, Role.NIGHT_AUDITOR))) ===
    JSON.stringify([Role.FRONT_DESK, Role.NIGHT_AUDITOR]),
  'the dual-role clerk the seed creates',
);
check(
  'a custom role (key null) contributes nothing',
  systemRoleKeys(grantsFor(null)).length === 0,
  'inherited from the seven services that already behave this way',
);
check(
  'a custom role alongside a system role does not suppress it',
  JSON.stringify(systemRoleKeys(grantsFor(null, Role.FRONT_DESK))) ===
    JSON.stringify([Role.FRONT_DESK]),
);
check('no grants yields no roles', systemRoleKeys([]).length === 0);

console.log('\nrequirePermission: the refusal is typed, 403, and names the permission.');

check(
  'a role holding the permission is allowed',
  hasPermission([Role.FRONT_DESK], Permission.RESERVATIONS_CREATE) === true,
);
check('a role lacking it is refused', refuses([Role.HOUSEKEEPING], Permission.RESERVATIONS_READ));
check(
  'an empty role set is refused, never allowed through',
  refuses([], Permission.RESERVATIONS_READ),
  'the fail-closed direction: no roles must not mean no restriction',
);
check(
  'grantsCarryPermission composes the two steps',
  grantsCarryPermission(grantsFor(Role.FRONT_DESK), Permission.RESERVATIONS_READ) === true &&
    grantsCarryPermission(grantsFor(Role.HOUSEKEEPING), Permission.RESERVATIONS_READ) === false,
);
check(
  'a custom-role-only caller is refused even though its rows may carry the permission',
  grantsCarryPermission(grantsFor(null), Permission.RESERVATIONS_READ) === false,
  'inherited from the seven existing services; see the helper header',
);

/* -------------------------------------------------------------------------- */
/*  2. The policy, as a role x endpoint table                                 */
/* -------------------------------------------------------------------------- */

/**
 * The approved policy. `allow` is asserted exhaustively against ALL_ROLES, so
 * a role added to the catalog, or a template widened, fails here.
 */
const POLICY = [
  {
    permission: Permission.RESERVATIONS_READ,
    endpoints: [
      'GET  /properties/:hotelId/reservations/search',
      'GET  /properties/:hotelId/timeline-calendar',
      'GET  /properties/:hotelId/dashboard-summary',
      'GET  /properties/:hotelId/companies',
      'GET  /properties/:hotelId/gst/lookup',
      'GET  /properties/:hotelId/lookups/postal-code',
    ],
    allow: [
      Role.SUPER_ADMIN,
      Role.PROPERTY_ADMIN,
      Role.FRONT_DESK,
      Role.REVENUE_MANAGER,
      Role.NIGHT_AUDITOR,
      Role.POS_STAFF,
    ],
  },
  {
    permission: Permission.RESERVATIONS_CREATE,
    endpoints: [
      'POST /properties/:hotelId/reservations/quote',
      'POST /properties/:hotelId/reservations',
    ],
    allow: [Role.SUPER_ADMIN, Role.PROPERTY_ADMIN, Role.FRONT_DESK],
  },
  {
    permission: Permission.PROPERTY_SETTINGS,
    endpoints: ['POST /properties/:hotelId/companies'],
    allow: [Role.SUPER_ADMIN, Role.PROPERTY_ADMIN],
  },
];

for (const { permission, endpoints, allow } of POLICY) {
  console.log(`\n${permission} — guards ${endpoints.length} endpoint(s).`);
  for (const endpoint of endpoints) console.log(`    ${endpoint}`);

  const allowed = new Set(allow);
  for (const role of ALL_ROLES) {
    const expected = allowed.has(role);
    check(
      `${role} is ${expected ? 'allowed' : 'REFUSED'}`,
      refuses([role], permission) === !expected,
      expected ? 'holds the permission' : '403 FORBIDDEN',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  3. The named policy decisions, asserted individually                      */
/* -------------------------------------------------------------------------- */

console.log('\nThe decisions the policy states explicitly.');

check(
  'FRONT_DESK can create reservations',
  DEFAULT_ROLE_PERMISSIONS[Role.FRONT_DESK].includes(Permission.RESERVATIONS_CREATE),
);
check(
  'NIGHT_AUDITOR cannot create reservations',
  !DEFAULT_ROLE_PERMISSIONS[Role.NIGHT_AUDITOR].includes(Permission.RESERVATIONS_CREATE),
  'approved decision 4: the template was deliberately NOT widened',
);
check(
  'REVENUE_MANAGER cannot create reservations',
  !DEFAULT_ROLE_PERMISSIONS[Role.REVENUE_MANAGER].includes(Permission.RESERVATIONS_CREATE),
);
check(
  'POS_STAFF cannot create reservations',
  !DEFAULT_ROLE_PERMISSIONS[Role.POS_STAFF].includes(Permission.RESERVATIONS_CREATE),
);
check(
  'HOUSEKEEPING holds no reservations:read, so it reaches none of the broad reads',
  !DEFAULT_ROLE_PERMISSIONS[Role.HOUSEKEEPING].includes(Permission.RESERVATIONS_READ),
  'approved decision 5: no broad read access was granted',
);
check(
  'HOUSEKEEPING was not widened in any other direction either',
  JSON.stringify([...DEFAULT_ROLE_PERMISSIONS[Role.HOUSEKEEPING]].sort()) ===
    JSON.stringify([Permission.HOUSEKEEPING_READ, Permission.HOUSEKEEPING_UPDATE_STATUS].sort()),
  'still exactly the two housekeeping permissions',
);
check(
  'POST /companies needs property:settings, which FRONT_DESK does not hold',
  !DEFAULT_ROLE_PERMISSIONS[Role.FRONT_DESK].includes(Permission.PROPERTY_SETTINGS) &&
    DEFAULT_ROLE_PERMISSIONS[Role.PROPERTY_ADMIN].includes(Permission.PROPERTY_SETTINGS),
  'approved decision 3',
);
check(
  'the dual-role clerk CAN create, through the union of their two roles',
  hasPermission([Role.FRONT_DESK, Role.NIGHT_AUDITOR], Permission.RESERVATIONS_CREATE) &&
    refuses([Role.NIGHT_AUDITOR], Permission.RESERVATIONS_CREATE),
  'night-audit alone could not; front-desk carries it',
);

/* -------------------------------------------------------------------------- */
/*  4. Structural: the sources enforce what the policy says                   */
/* -------------------------------------------------------------------------- */

const ROOT = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, ROOT), 'utf8');

/** Code only: these files document their own policy in prose. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

console.log('\nThe comment stripper itself.');
{
  const probe = '/* RESERVATIONS_READ */\nconst a = 1;\n// RESERVATIONS_READ\nconst b = "KEEP";';
  const out = stripComments(probe);
  check(
    'it removes prose and keeps code',
    !out.includes('RESERVATIONS_READ') && out.includes('KEEP') && out.includes('const a = 1;'),
  );
  {
    // A multi-line block comment must leave its newlines behind, or every
    // line number after it shifts and an ordering assertion compares the
    // wrong two offsets.
    const multiline = '/* a\nb\nc */\nx';
    check(
      'it preserves line numbering',
      stripComments(multiline).split('\n').length === multiline.split('\n').length,
      `${String(stripComments(multiline).split('\n').length)} lines in, ${String(
        multiline.split('\n').length,
      )} out`,
    );
  }
}

console.log('\nThe throwing wrapper raises the typed 403 on exactly that condition.');
{
  const thrower = stripComments(read('apps/api/src/common/property-scope/require-permission.ts'));
  check(
    'it throws ForbiddenError, not a bare Error or an HttpException',
    /throw new ForbiddenError\(required\)/.test(thrower) &&
      (thrower.match(/throw new/g) ?? []).length ===
        (thrower.match(/throw new ForbiddenError\(required\)/g) ?? []).length,
    'every throw in the file is that one',
  );
  check(
    'it refuses on the negation of the pure predicate, nothing else',
    /if \(!hasPermission\(roles, required\)\)/.test(thrower) &&
      /if \(!grantsCarryPermission\(grants, required\)\)/.test(thrower),
  );
  check(
    'ForbiddenError maps to HTTP 403 and the typed FORBIDDEN code',
    (() => {
      const errors = read('apps/api/src/common/errors/domain-error.ts');
      const start = errors.indexOf('export class ForbiddenError extends DomainError');
      if (start === -1) return false;
      const block = errors.slice(start, start + 600);
      return block.includes('HttpStatus.FORBIDDEN');
    })(),
    'so the 403 claim above is the real status, not an assumption',
  );
  check(
    'the pure policy module has no relative imports, so it stays testable',
    (() => {
      const policy = stripComments(read('apps/api/src/common/property-scope/permission-policy.ts'));
      const specifiers = [...policy.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      return specifiers.length > 0 && specifiers.every((spec) => !spec.startsWith('.'));
    })(),
    'the convention outbox.prefix.ts and property-identifier.ts already follow',
  );
}

const SERVICES = [
  {
    file: 'apps/api/src/modules/reservations/reservation-search.service.ts',
    endpoint: 'GET reservations/search',
    permission: 'Permission.RESERVATIONS_READ',
  },
  {
    file: 'apps/api/src/modules/timeline/timeline.service.ts',
    endpoint: 'GET timeline-calendar',
    permission: 'Permission.RESERVATIONS_READ',
  },
  {
    file: 'apps/api/src/modules/property-dashboard/property-dashboard.service.ts',
    endpoint: 'GET dashboard-summary',
    permission: 'Permission.RESERVATIONS_READ',
  },
];

console.log('\nEach service checks the permission the policy assigns it.');
for (const { file, endpoint, permission } of SERVICES) {
  const code = stripComments(read(file));
  const call = `requirePermissionFromGrants(granted.grants, ${permission})`;
  check(`${endpoint} checks ${permission}`, code.includes(call), file.split('/').pop());
  check(
    `${endpoint} raises the tenancy 404 BEFORE the permission 403`,
    code.indexOf('TenantScopeViolationError') < code.indexOf('requirePermissionFromGrants') &&
      code.indexOf('TenantScopeViolationError') !== -1,
    'otherwise a 403 confirms the property exists to a caller with no grant',
  );
}

console.log('\ncompanies and create-reservation check inside their own resolver.');
{
  const code = stripComments(read('apps/api/src/modules/companies/companies.service.ts'));
  check(
    'GET companies checks RESERVATIONS_READ',
    /this\.resolveProperty\(\s*userId,\s*hotelId,\s*Permission\.RESERVATIONS_READ,?\s*\)/.test(
      code,
    ),
  );
  check(
    'POST companies checks PROPERTY_SETTINGS',
    /this\.resolveProperty\(\s*userId,\s*hotelId,\s*Permission\.PROPERTY_SETTINGS,?\s*\)/.test(
      code,
    ),
  );
  check(
    'its resolver refuses a missing grant before checking the permission',
    code.indexOf('TenantScopeViolationError') < code.indexOf('requirePermissionFromGrants'),
  );
  check(
    'it unions roles (findMany), so a second role cannot be ignored',
    code.includes('userPropertyRole.findMany') && !code.includes('userPropertyRole.findFirst'),
  );
}

/* -------------------------------------------------------------------------- */
/*  The two provider-proxy lookups                                           */
/* -------------------------------------------------------------------------- */

/**
 * These two were the gap: nested under `:hotelId`, but the parameter was never
 * bound and no grant was ever resolved, so any authenticated caller could
 * reach either provider against any property's path.
 *
 * What is asserted here is ORDER, by byte offset: authorisation is reached
 * before the outbound call. That is not a runtime spy -- these services carry
 * Nest decorators, which Node's type stripping cannot erase, so they are not
 * importable from a `.mjs` suite and no call can be intercepted here. The
 * refusal itself cannot be observed at this level either; what can be proved
 * is that no code path reaches the provider without passing the await first.
 */
console.log('\nThe GSTIN and postal-code lookups authorise before calling out.');
{
  const controller = stripComments(read('apps/api/src/modules/companies/companies.controller.ts'));
  const service = stripComments(read('apps/api/src/modules/companies/companies.service.ts'));

  for (const [label, handler, param] of [
    ['gst/lookup', 'lookupGstin', "@Query('gstin')"],
    ['lookups/postal-code', 'lookupPostalCode', "@Query('postalCode')"],
  ]) {
    const start = controller.indexOf(`  ${handler}(`);
    // To `): Promise<` -- the end of the parameter list. Not the first `)`,
    // which belongs to `@Req()` and truncated the slice before the params.
    const end = start === -1 ? -1 : controller.indexOf('): Promise<', start);
    const signature = start === -1 || end === -1 ? '' : controller.slice(start, end);
    check(
      `${label}: the handler binds the :hotelId route parameter`,
      signature.includes("@Param('hotelId') hotelId: string"),
      'it used to ignore the path segment entirely',
    );
    check(
      `${label}: the handler keeps its original query parameter`,
      signature.includes(param),
      param,
    );
    check(
      `${label}: userId comes from the authenticated request, not the body`,
      controller.includes(`this.companies.${handler}(this.userId(request), hotelId,`),
      'this.userId(request) throws UnauthenticatedError when no user is attached',
    );
  }

  // Ordering, per method body.
  for (const [label, handler, provider] of [
    ['gst/lookup', 'lookupGstin', 'this.gst.lookup('],
    ['lookups/postal-code', 'lookupPostalCode', 'fetch('],
  ]) {
    const start = service.indexOf(`async ${handler}(`);
    const body = start === -1 ? '' : service.slice(start, start + 2000);
    const authAt = body.indexOf('await this.resolveProperty(');
    const providerAt = body.indexOf(provider);
    check(
      `${label}: the service resolves and authorises the property`,
      /await this\.resolveProperty\(\s*userId,\s*hotelId,\s*Permission\.RESERVATIONS_READ,?\s*\)/.test(
        body,
      ),
      'RESERVATIONS_READ',
    );
    check(
      `${label}: the provider is reached ONLY after authorisation`,
      authAt !== -1 && providerAt !== -1 && authAt < providerAt,
      authAt === -1 || providerAt === -1
        ? 'anchor not found'
        : `auth@${authAt} < call@${providerAt}`,
    );
    check(
      `${label}: there is exactly one provider call site in the method`,
      (
        body.slice(0, body.indexOf('\n  }')).match(new RegExp(provider.replace('(', '\\('), 'g')) ??
        []
      ).length <= 1,
      'so the ordering above covers every path to it',
    );
  }

  check(
    'postal-code authorises before the format check, not after',
    (() => {
      const start = service.indexOf('async lookupPostalCode(');
      const body = service.slice(start, start + 1200);
      return (
        body.indexOf('await this.resolveProperty(') !== -1 &&
        body.indexOf('await this.resolveProperty(') < body.indexOf('postalCode.trim()')
      );
    })(),
    'an unauthorised caller must not get a shaped found:false either',
  );
}

/* -------------------------------------------------------------------------- */
/*  The corrected client path                                                */
/* -------------------------------------------------------------------------- */

console.log('\nThe admin client calls the route the API actually maps.');
{
  const controller = stripComments(read('apps/api/src/modules/companies/companies.controller.ts'));
  const client = stripComments(read('apps/web-admin/src/lib/properties-client.ts'));

  // Route literals the API declares, read rather than hard-coded.
  const routes = [...controller.matchAll(/@Get\('(:hotelId\/[^']+)'\)/g)].map((m) => m[1]);
  check(
    "the API maps ':hotelId/gst/lookup'",
    routes.includes(':hotelId/gst/lookup'),
    routes.join(', '),
  );
  check(
    'the client now requests gst/lookup',
    client.includes('/gst/lookup?gstin='),
    'was /lookups/gstin?gstin=, which matched no route and 404d',
  );
  check(
    'the stale client path is gone',
    !client.includes('lookups/gstin'),
    'regression guard for the mismatch',
  );
  check(
    'the gstin query parameter is unchanged',
    client.includes('gst/lookup?gstin=${encodeURIComponent(gstin)}'),
    'contract preserved: only the path segment moved',
  );
  check(
    'the postal-code client path still matches its route',
    client.includes('/lookups/postal-code?postalCode=') &&
      routes.includes(':hotelId/lookups/postal-code'),
    'it was already correct and must stay so',
  );
}
{
  const code = stripComments(
    read('apps/api/src/modules/reservations/create-reservation.service.ts'),
  );
  const calls = code.match(/Permission\.RESERVATIONS_CREATE/g) ?? [];
  check(
    'quote and create both check RESERVATIONS_CREATE',
    calls.length === 2,
    `${calls.length} call site(s)`,
  );
  check(
    'its resolver refuses a missing grant before checking the permission',
    code.indexOf('TenantScopeViolationError') < code.indexOf('requirePermissionFromGrants'),
  );
  check(
    'it unions roles (findMany)',
    code.includes('userPropertyRole.findMany') && !code.includes('userPropertyRole.findFirst'),
  );
}

/* -------------------------------------------------------------------------- */
/*  5. What this change must NOT have touched                                 */
/* -------------------------------------------------------------------------- */

console.log('\nUnchanged by this policy, asserted rather than assumed.');

{
  // operableOnly across all thirteen consolidated call sites.
  const EXPECTED = {
    'apps/api/src/modules/companies/companies.service.ts': ['false'],
    'apps/api/src/modules/folios/folios.service.ts': ['false'],
    'apps/api/src/modules/properties/property-setup.service.ts': ['false'],
    'apps/api/src/modules/property-dashboard/property-dashboard.repository.ts': ['false'],
    'apps/api/src/modules/reports/reports.repository.ts': ['true'],
    'apps/api/src/modules/reservations/cancel-reservation.service.ts': ['false'],
    'apps/api/src/modules/reservations/check-in.service.ts': ['false'],
    'apps/api/src/modules/reservations/check-out.service.ts': ['false'],
    'apps/api/src/modules/reservations/create-reservation.service.ts': ['false'],
    'apps/api/src/modules/reservations/reservation-detail.service.ts': ['false'],
    'apps/api/src/modules/reservations/reservation-search.repository.ts': ['true'],
    'apps/api/src/modules/reservations/room-move.service.ts': ['false'],
    'apps/api/src/modules/timeline/timeline.repository.ts': ['true'],
  };
  let total = 0;
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const code = stripComments(read(file));
    const found = [...code.matchAll(/grantedPropertyWhere\(\{[^}]*operableOnly:\s*(\w+)/g)].map(
      (m) => m[1],
    );
    total += found.length;
    check(
      `${file.split('/').pop()} keeps operableOnly: ${expected.join(', ')}`,
      JSON.stringify(found) === JSON.stringify(expected),
      found.length === 0 ? 'NO CALL SITE FOUND' : found.join(', '),
    );
  }
  check('all thirteen call sites still present', total === 13, `${total} found`);
}

{
  const seed = read('packages/database/prisma/seed.ts');
  check(
    'the seed was not given any new permission grant',
    !/RESERVATIONS_CREATE|RESERVATIONS_READ/.test(stripComments(seed)),
    'role templates and seeds are untouched',
  );
  const rbac = stripComments(read('packages/types/src/rbac.ts'));
  check(
    'NIGHT_AUDITOR_PERMISSIONS does not contain RESERVATIONS_CREATE',
    !/NIGHT_AUDITOR_PERMISSIONS[\s\S]*?\];/.exec(rbac)?.[0]?.includes('RESERVATIONS_CREATE'),
  );
  check(
    'the permission catalog gained no new constant',
    !/COMPANIES_|DASHBOARD_|TIMELINE_/.test(rbac),
    'only existing constants were used',
  );
}

{
  const rbacController = read('apps/api/src/modules/rbac/rbac.controller.ts');
  check(
    'GET /rbac/roles is still unguarded, as approved',
    !rbacController.includes('UseGuards'),
    'approved decision 6: left unchanged',
  );
}

/* ========================================================================== */
console.log('');
if (failures === 0) {
  console.log('All authorization policy checks passed.');
} else {
  console.error(`${String(failures)} check(s) FAILED.`);
  process.exit(1);
}
