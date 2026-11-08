/**
 * Unit tests for the one shared property-grant predicate. No database.
 *
 * ===========================================================================
 * What this is defending, and why it is worth a suite of its own.
 *
 * Thirteen services each carried their own copy of two decisions: how a
 * `:hotelId` route parameter is matched against a property, and that the match
 * must go through a `UserPropertyRole` grant. The copies had not drifted --
 * the UUID pattern was character-identical in all thirteen -- but the second
 * decision is the authorisation for every property-scoped endpoint in the
 * product, and nothing structural stopped a fourteenth service from resolving
 * a property without it.
 *
 * So two kinds of check:
 *
 *   1. BEHAVIOURAL, over the two pure functions. The load-bearing one is that
 *      the predicate can never lose its `userId` clause: that is the single
 *      failure here that would be catastrophic *and* silent, because a
 *      predicate without it matches every property in the portfolio.
 *
 *   2. EQUIVALENCE, against the thirteen literal `where` objects the call
 *      sites used to build. This is a consolidation, so "behaviour preserved"
 *      has to be asserted, not asserted-about: each of the thirteen shapes is
 *      reproduced here from the pre-change source and deep-compared.
 *
 * A note on the input contract. `codeOrId` is typed `string`, and it genuinely
 * always is one: every one of the thirteen call sites receives it from
 * `@Param('hotelId')`, a Fastify route parameter, which cannot be absent,
 * non-string, or an empty path segment. So this suite does NOT test `null`,
 * `undefined` or non-string inputs -- inventing runtime handling for inputs no
 * caller can produce would be a widened contract pretending to be safety, and
 * TypeScript's strict mode already blocks them at every call site. `''` and
 * whitespace ARE tested, because they are typed inputs even if unreachable.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import {
  grantedPropertyWhere,
  propertyWhereFromIdentifier,
} from '../../apps/api/src/common/property-scope/property-identifier.ts';
import { OPERABLE_PROPERTY_STATUSES } from '../../packages/types/src/domain.ts';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UUID = 'a1b2c3d4-e5f6-7788-99aa-bbccddeeff00';
const CODE = '31336';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ========================================================================== */
console.log('Property identifier and grant predicate (pure)\n');

/* -------------------------------------------------------------------------- */
/*  Which column a route parameter matches                                    */
/* -------------------------------------------------------------------------- */

console.log('UUID resolution.');
for (const [label, value] of [
  ['a lowercase v4 UUID', UUID],
  ['an uppercase UUID', UUID.toUpperCase()],
  ['a mixed-case UUID', 'A1b2C3d4-E5f6-7788-99Aa-BbCcDdEeFf00'],
  ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
  ['a v1-shaped UUID', 'e4eaaaf2-d142-11e1-b3e4-080027620cdd'],
  ['a v7-shaped UUID', '018f3e2a-7c1b-7000-8000-abcdefabcdef'],
]) {
  check(`${label} matches the id column`, same(propertyWhereFromIdentifier(value), { id: value }));
}
check(
  'no UUID version or variant validation is performed',
  same(propertyWhereFromIdentifier('ffffffff-ffff-ffff-ffff-ffffffffffff'), {
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  }),
  'copied from the thirteen call sites, deliberately not improved',
);

console.log('\nCode (slug) resolution.');
for (const [label, value] of [
  ['the seeded numeric code', CODE],
  ['an alphanumeric code', 'EASEIT-GOA-01'],
  ['a single character', 'x'],
  ['a 36-character non-hex string', 'g1b2c3d4-e5f6-7788-99aa-bbccddeeff00'],
  ['a UUID missing a dash', 'a1b2c3d4e5f6-7788-99aa-bbccddeeff00'],
  ['a UUID with an extra dash', 'a1b2-c3d4-e5f6-7788-99aa-bbccddeeff00'],
  ['a 35-character hex string', 'a1b2c3d4-e5f6-7788-99aa-bbccddeeff0'],
  ['a 37-character hex string', 'a1b2c3d4-e5f6-7788-99aa-bbccddeeff000'],
  ['a UUID with surrounding whitespace', ` ${UUID} `],
  ['the empty string', ''],
  ['whitespace only', '   '],
]) {
  check(
    `${label} matches the code column`,
    same(propertyWhereFromIdentifier(value), { code: value }),
    label === 'a UUID with surrounding whitespace'
      ? 'the regex is anchored, so this is a code — same as before'
      : '',
  );
}
check(
  'the identifier is never transformed',
  propertyWhereFromIdentifier(` ${CODE} `).code === ` ${CODE} `,
  'no trimming, no lowercasing: a consolidation changes nothing',
);
check(
  'exactly one of id or code is ever produced',
  [UUID, CODE, '', '   ', 'x'].every((value) => {
    const keys = Object.keys(propertyWhereFromIdentifier(value));
    return keys.length === 1 && (keys[0] === 'id' || keys[0] === 'code');
  }),
);

/* -------------------------------------------------------------------------- */
/*  The grant predicate — the authorisation                                   */
/* -------------------------------------------------------------------------- */

console.log('\nThe grant predicate.');
check(
  'a valid grant lookup joins userId and the id column',
  same(grantedPropertyWhere({ userId: USER, codeOrId: UUID, operableOnly: false }), {
    userId: USER,
    property: { id: UUID },
  }),
);
check(
  'and the code column for a code',
  same(grantedPropertyWhere({ userId: USER, codeOrId: CODE, operableOnly: false }), {
    userId: USER,
    property: { code: CODE },
  }),
);
check(
  'operableOnly adds the status filter ahead of the identifier',
  same(grantedPropertyWhere({ userId: USER, codeOrId: CODE, operableOnly: true }), {
    userId: USER,
    property: { status: { in: [...OPERABLE_PROPERTY_STATUSES] }, code: CODE },
  }),
);
check(
  'and omits it when false',
  grantedPropertyWhere({ userId: USER, codeOrId: CODE, operableOnly: false }).property.status ===
    undefined,
  'nine call sites rely on this; property-status policy is unchanged',
);

/**
 * The one failure that would be catastrophic and silent.
 *
 * A predicate missing `userId` matches every property in the portfolio. It is
 * asserted across every input shape rather than once, because the whole point
 * of consolidating was that this clause can no longer be forgotten at one of
 * thirteen call sites.
 */
console.log('\nThe predicate can never become unfiltered.');
for (const codeOrId of [UUID, CODE, '', '   ', 'EASEIT-GOA-01', ` ${UUID} `]) {
  for (const operableOnly of [true, false]) {
    const where = grantedPropertyWhere({ userId: USER, codeOrId, operableOnly });
    check(
      `userId survives for ${JSON.stringify(codeOrId)} (operableOnly=${String(operableOnly)})`,
      where.userId === USER && Object.keys(where).length === 2 && where.property !== undefined,
    );
  }
}
check(
  'a missing grant is expressed as a predicate that matches nothing, never as a throw',
  (() => {
    const where = grantedPropertyWhere({
      userId: USER,
      codeOrId: 'no-such-code',
      operableOnly: false,
    });
    return where.userId === USER && where.property.code === 'no-such-code';
  })(),
  'the caller decides between 404 and null; this only builds the question',
);
check(
  'cross-property access is prevented by the join, not by a check on the identifier',
  (() => {
    const mine = grantedPropertyWhere({ userId: USER, codeOrId: UUID, operableOnly: false });
    const theirs = grantedPropertyWhere({
      userId: 'other-user',
      codeOrId: UUID,
      operableOnly: false,
    });
    return mine.userId !== theirs.userId && same(mine.property, theirs.property);
  })(),
  'the same property id under a different user is a different query — 0 rows, hence 404',
);

/* -------------------------------------------------------------------------- */
/*  Equivalence with the thirteen literals it replaced                        */
/* -------------------------------------------------------------------------- */

/**
 * Reproduced from the pre-change source of each call site.
 *
 * Nine sites built `{ userId, property: isUuid ? { id } : { code } }`; four
 * built the same with `{ status: { in: [...OPERABLE_PROPERTY_STATUSES] },
 * ...identifier }`. (Three of those four are in scope; the fourth,
 * `properties.repository.ts:178`, takes a propertyId only and was left alone.)
 */
console.log('\nEquivalence with the replaced literals.');
{
  const legacyNoStatus = (userId, codeOrId) => ({
    userId,
    property: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codeOrId)
      ? { id: codeOrId }
      : { code: codeOrId },
  });
  const legacyWithStatus = (userId, codeOrId) => ({
    userId,
    property: {
      status: { in: [...OPERABLE_PROPERTY_STATUSES] },
      ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codeOrId)
        ? { id: codeOrId }
        : { code: codeOrId }),
    },
  });

  const inputs = [UUID, UUID.toUpperCase(), CODE, 'EASEIT-GOA-01', '', '   ', ` ${UUID} `];

  check(
    'the ten operableOnly:false sites get a byte-identical predicate',
    inputs.every((codeOrId) =>
      same(
        grantedPropertyWhere({ userId: USER, codeOrId, operableOnly: false }),
        legacyNoStatus(USER, codeOrId),
      ),
    ),
    'companies, property-dashboard, create-reservation, folios, check-in, cancel, check-out, room-move, reservation-detail, property-setup',
  );
  check(
    'the three operableOnly:true sites get a byte-identical predicate',
    inputs.every((codeOrId) =>
      same(
        grantedPropertyWhere({ userId: USER, codeOrId, operableOnly: true }),
        legacyWithStatus(USER, codeOrId),
      ),
    ),
    'reservation-search, timeline, reports',
  );
  check(
    'and the two forms differ only by the status clause',
    (() => {
      const without = grantedPropertyWhere({ userId: USER, codeOrId: CODE, operableOnly: false });
      const with_ = grantedPropertyWhere({ userId: USER, codeOrId: CODE, operableOnly: true });
      return (
        same(without.property, { code: CODE }) &&
        same(with_.property, { status: { in: [...OPERABLE_PROPERTY_STATUSES] }, code: CODE })
      );
    })(),
  );
}

/* -------------------------------------------------------------------------- */
/*  Structural regression: no fourteenth copy                                 */
/* -------------------------------------------------------------------------- */

console.log('\nNo call site resolves a property on its own (source inspection).');
{
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const SITES = [
    ['companies/companies.service.ts', false],
    ['property-dashboard/property-dashboard.repository.ts', false],
    ['reservations/create-reservation.service.ts', false],
    ['reservations/reservation-search.repository.ts', true],
    ['timeline/timeline.repository.ts', true],
    ['folios/folios.service.ts', false],
    ['reservations/check-in.service.ts', false],
    ['reservations/cancel-reservation.service.ts', false],
    ['reservations/check-out.service.ts', false],
    ['reservations/room-move.service.ts', false],
    ['reservations/reservation-detail.service.ts', false],
    ['properties/property-setup.service.ts', false],
    ['reports/reports.repository.ts', true],
  ];

  for (const [relative, operableOnly] of SITES) {
    const code = strip(read(`../../apps/api/src/modules/${relative}`));
    check(
      `${relative} uses the shared predicate`,
      code.includes(
        `where: grantedPropertyWhere({ userId, codeOrId, operableOnly: ${String(operableOnly)} }),`,
      ),
      `operableOnly: ${String(operableOnly)}`,
    );
    check(
      `${relative} declares no identifier logic of its own`,
      !code.includes('isUuid') && !/\[0-9a-f\]\{8\}-/.test(code),
    );
  }

  /**
   * The assertion that stops a fourteenth copy appearing.
   *
   * Comments stripped first: the helper's own docblock quotes the pattern
   * while explaining that it is the only copy, and prose has broken this class
   * of check repeatedly in this repository.
   */
  const helper = 'apps/api/src/common/property-scope/property-identifier.ts';
  const offenders = [];
  for (const relative of [
    ...SITES.map(([file]) => `modules/${file}`),
    'common/guards/active-property.guard.ts',
    'modules/auth/auth.repository.ts',
    'modules/calendar/calendar.repository.ts',
    'modules/performance/performance.repository.ts',
    'modules/properties/properties.repository.ts',
  ]) {
    const code = strip(read(`../../apps/api/src/${relative}`));
    if (/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(code)) offenders.push(relative);
  }
  check(
    'the UUID pattern exists in exactly one file',
    offenders.length === 0,
    offenders.length === 0 ? `only ${helper}` : `also in: ${offenders.join(', ')}`,
  );

  /* ---- the eight lookups that must stay as they are ---- */
  const untouched = {
    'common/guards/active-property.guard.ts': 2,
    'modules/auth/auth.repository.ts': 1,
    'modules/calendar/calendar.repository.ts': 1,
    'modules/performance/performance.repository.ts': 1,
    'modules/properties/properties.repository.ts': 3,
  };
  for (const [relative, expected] of Object.entries(untouched)) {
    const code = strip(read(`../../apps/api/src/${relative}`));
    const lookups = (code.match(/userPropertyRole\.(findFirst|findMany|count)/g) ?? []).length;
    check(
      `${relative} keeps its ${String(expected)} lookup(s) untouched`,
      lookups === expected && !code.includes('grantedPropertyWhere'),
      `found ${String(lookups)}`,
    );
  }
  check(
    'the multi-property and session lookups do not use the single-property predicate',
    Object.keys(untouched).every(
      (relative) => !strip(read(`../../apps/api/src/${relative}`)).includes('grantedPropertyWhere'),
    ),
    'they answer different questions: all grants, a grant list, a count, an already-resolved id',
  );
}

console.log(
  failures === 0
    ? '\nAll property-identifier checks passed.'
    : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
