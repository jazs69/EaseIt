/**
 * Unit tests for the inventory-horizon policy. No database.
 *
 * ===========================================================================
 * WHAT THIS DEFENDS.
 *
 * `inventory_day` decides what can be sold: `create-reservation` locks one row
 * per night and refuses when the count comes back short, so a night with no
 * row is unsellable however many rooms stand empty. Day 2 adds the first
 * runtime writer that *inserts* those rows, and two decisions in it are easy
 * to get quietly wrong:
 *
 *   1. THE WINDOW. Off-by-one at either end silently leaves a night
 *      unsellable, or extends a day past what the operator asked for. The cap
 *      and the past-date refusal are the only things between a typo and a
 *      multi-million-row insert.
 *
 *   2. WHAT COUNTS AS "CONFIGURED". `MAX(stayDate)` is not proof that every
 *      earlier date exists, and -- the subtler trap -- neither is a COUNT. A
 *      room type with a row for today plus rows for today+10..today+20 has
 *      twelve rows; inferring "twelve contiguous days" puts the first hole at
 *      today+12 when it is really at today+1. The policy must therefore take
 *      the first missing date as MEASURED input and never derive it from a
 *      count. These tests feed it exactly that shape, including the gapped
 *      case, so a future "optimisation" back to count-arithmetic fails here.
 *
 * NOT PROVED HERE, and not claimable from a green run: that the SQL inserts
 * the right rows, that `ON CONFLICT DO NOTHING` is idempotent against a real
 * unique index, that `physical` matches the room table, or that the endpoints
 * return 403/404. Those need a database and are listed in the integration
 * plan.
 *
 * Source assertions read a COMMENT-STRIPPED view: these files explain their
 * own policy in prose, so a naive grep matches the explanation and passes for
 * the wrong reason. The stripper is sanity-checked below.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import {
  MAX_CHUNK_DAYS,
  MAX_HORIZON_DAYS,
  addCalendarDays,
  chunkRange,
  daysBetween,
  enumerateDates,
  parseCalendarDate,
  planHorizon,
  summariseCoverage,
  toCalendarDate,
} from '../../apps/api/src/modules/inventory/inventory-horizon.policy.ts';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const TODAY = new Date('2026-11-07T00:00:00.000Z');
const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

/* ========================================================================== */
console.log('Inventory horizon policy (pure)\n');

/* -------------------------------------------------------------------------- */
/*  Date parsing: strict, because a rolled-over date is a silent wrong answer */
/* -------------------------------------------------------------------------- */

console.log('Calendar-date parsing is strict.');

for (const good of ['2026-11-07', '2026-01-01', '2026-12-31', '2028-02-29']) {
  check(`${good} parses`, toCalendarDate(parseCalendarDate(good)) === good);
}
for (const bad of [
  '2026-02-30',
  '2026-13-01',
  '2026-11-32',
  '2026-11-7',
  '26-11-07',
  '2026/11/07',
  '',
  '   ',
  '2026-11-07T00:00:00Z',
  'tomorrow',
]) {
  check(`${JSON.stringify(bad)} is refused`, parseCalendarDate(bad) === null);
}
check(
  '2027-02-29 is refused (not a leap year), not rolled to 03-01',
  parseCalendarDate('2027-02-29') === null,
  'new Date would have accepted it',
);

console.log('\nDate arithmetic.');
check('daysBetween is inclusive-exclusive', daysBetween(d('2026-11-07'), d('2026-11-08')) === 1);
check('daysBetween is 0 for the same day', daysBetween(d('2026-11-07'), d('2026-11-07')) === 0);
check('daysBetween is negative backwards', daysBetween(d('2026-11-08'), d('2026-11-07')) === -1);
check('daysBetween crosses a month boundary', daysBetween(d('2026-11-30'), d('2026-12-01')) === 1);
check(
  'daysBetween crosses a leap day',
  daysBetween(d('2028-02-28'), d('2028-03-01')) === 2,
  '2028 is a leap year',
);
check(
  'addCalendarDays moves forward',
  toCalendarDate(addCalendarDays(d('2026-12-31'), 1)) === '2027-01-01',
);
check(
  'addCalendarDays moves back',
  toCalendarDate(addCalendarDays(d('2027-01-01'), -1)) === '2026-12-31',
);

console.log('\nDate enumeration is inclusive at BOTH ends.');
check(
  'a single day yields one date',
  JSON.stringify(enumerateDates(d('2026-11-07'), d('2026-11-07'))) ===
    JSON.stringify(['2026-11-07']),
);
check(
  'two days yield both',
  JSON.stringify(enumerateDates(d('2026-11-07'), d('2026-11-08'))) ===
    JSON.stringify(['2026-11-07', '2026-11-08']),
);
check(
  'a reversed range is empty, not an error',
  enumerateDates(d('2026-11-08'), d('2026-11-07')).length === 0,
);
check(
  'a month boundary is continuous',
  JSON.stringify(enumerateDates(d('2026-11-30'), d('2026-12-01'))) ===
    JSON.stringify(['2026-11-30', '2026-12-01']),
);
check(
  'February 2028 includes the leap day',
  enumerateDates(d('2028-02-01'), d('2028-02-29')).length === 29,
);

/* -------------------------------------------------------------------------- */
/*  planHorizon: the refusals are the safety rail                            */
/* -------------------------------------------------------------------------- */

console.log('\nplanHorizon refusals.');

{
  const r = planHorizon({ throughDate: 'nonsense', today: TODAY });
  check('a malformed date is refused', r.kind === 'malformed', r.kind);
  check('the refusal names the field', r.field === 'throughDate');
}
{
  const r = planHorizon({ throughDate: '2026-11-06', today: TODAY });
  check('yesterday is refused', r.kind === 'past', r.kind);
}
{
  const r = planHorizon({ throughDate: '2026-11-07', today: TODAY });
  check(
    'TODAY is accepted, not treated as past',
    !('kind' in r) && r.dayCount === 1,
    'the boundary, and the one most likely to be coded as `<=`',
  );
}
{
  const atCap = toCalendarDate(addCalendarDays(TODAY, MAX_HORIZON_DAYS));
  const r = planHorizon({ throughDate: atCap, today: TODAY });
  check(
    `exactly ${String(MAX_HORIZON_DAYS)} days ahead is accepted`,
    !('kind' in r) && r.dayCount === MAX_HORIZON_DAYS + 1,
    atCap,
  );
}
{
  const overCap = toCalendarDate(addCalendarDays(TODAY, MAX_HORIZON_DAYS + 1));
  const r = planHorizon({ throughDate: overCap, today: TODAY });
  check(`${String(MAX_HORIZON_DAYS + 1)} days ahead is refused`, r.kind === 'beyond-cap', overCap);
  check(
    'the cap refusal states the span',
    /731 days ahead/.test(r.message),
    r.message.slice(0, 60),
  );
}
{
  const r = planHorizon({ throughDate: '2927-06-30', today: TODAY });
  check(
    'a year typo is refused rather than generating ~330k rows per room type',
    r.kind === 'beyond-cap',
  );
}

console.log('\nplanHorizon always starts at today, never at a stored maximum.');
{
  const r = planHorizon({ throughDate: '2026-12-31', today: TODAY });
  check('from is today', toCalendarDate(r.from) === '2026-11-07');
  check('to is throughDate, inclusive', toCalendarDate(r.to) === '2026-12-31');
  check(
    'dayCount counts both ends',
    r.dayCount === daysBetween(TODAY, d('2026-12-31')) + 1,
    String(r.dayCount),
  );
  check(
    're-walking from today is what lets a repeat fill an internal gap',
    toCalendarDate(r.from) === toCalendarDate(TODAY),
    'a resume-from-MAX design could not',
  );
}
{
  // The clock may hand back any instant; the calendar day is what matters.
  const r = planHorizon({ throughDate: '2026-11-20', today: new Date('2026-11-07T23:59:59.999Z') });
  check(
    'a late-in-day clock still starts at that calendar date',
    toCalendarDate(r.from) === '2026-11-07',
  );
}

/* -------------------------------------------------------------------------- */
/*  Chunking: bounded statements, complete and non-overlapping coverage      */
/* -------------------------------------------------------------------------- */

console.log('\nChunking is bounded, contiguous and gap-free.');

for (const span of [
  0,
  1,
  MAX_CHUNK_DAYS - 2,
  MAX_CHUNK_DAYS - 1,
  MAX_CHUNK_DAYS,
  MAX_CHUNK_DAYS + 1,
  364,
  MAX_HORIZON_DAYS,
]) {
  const from = TODAY;
  const to = addCalendarDays(TODAY, span);
  const chunks = chunkRange(from, to);
  const totalDays = chunks.reduce((sum, c) => sum + c.days, 0);
  const allBounded = chunks.every((c) => c.days >= 1 && c.days <= MAX_CHUNK_DAYS);

  let contiguous = chunks.length > 0 && chunks[0].from.getTime() === from.getTime();
  for (let i = 1; i < chunks.length; i += 1) {
    if (daysBetween(chunks[i - 1].to, chunks[i].from) !== 1) contiguous = false;
  }
  const endsRight = chunks.length > 0 && chunks[chunks.length - 1].to.getTime() === to.getTime();

  check(
    `span ${String(span)}: ${String(chunks.length)} chunk(s) cover exactly ${String(span + 1)} day(s)`,
    totalDays === span + 1 && allBounded && contiguous && endsRight,
    `bounded=${String(allBounded)} contiguous=${String(contiguous)} endsRight=${String(endsRight)}`,
  );
}
check(
  `the widest allowed range needs at most ${String(Math.ceil((MAX_HORIZON_DAYS + 1) / MAX_CHUNK_DAYS))} chunks`,
  chunkRange(TODAY, addCalendarDays(TODAY, MAX_HORIZON_DAYS)).length <=
    Math.ceil((MAX_HORIZON_DAYS + 1) / MAX_CHUNK_DAYS),
  `${String(chunkRange(TODAY, addCalendarDays(TODAY, MAX_HORIZON_DAYS)).length)} chunks`,
);
check(
  'a reversed range produces no statements',
  chunkRange(d('2026-11-08'), d('2026-11-07')).length === 0,
);

/* -------------------------------------------------------------------------- */
/*  summariseCoverage: the part that must not infer contiguity from a count  */
/* -------------------------------------------------------------------------- */

console.log('\nsummariseCoverage: a count never stands in for a measured gap.');

const rt = (id, code, configuredDays, lastConfiguredDate, firstMissingDate) => ({
  roomTypeId: id,
  code,
  name: `${code} rooms`,
  configuredDays,
  lastConfiguredDate,
  firstMissingDate,
});

{
  const s = summariseCoverage([], TODAY);
  check(
    'no room types means no horizon, not an infinite one',
    s.fullyConfiguredThrough === null && s.daysRemaining === 0 && s.gaps.length === 0,
  );
}
{
  // Two types, both solid through 2026-12-31.
  const s = summariseCoverage(
    [rt('a', 'DLX', 55, '2026-12-31', null), rt('b', 'STD', 55, '2026-12-31', null)],
    TODAY,
  );
  check('a solid calendar reports no gaps', s.gaps.length === 0);
  check(
    'the headline is the common end date',
    s.fullyConfiguredThrough === '2026-12-31',
    String(s.fullyConfiguredThrough),
  );
  check(
    'daysRemaining counts forward from today',
    s.daysRemaining === daysBetween(TODAY, d('2026-12-31')),
    String(s.daysRemaining),
  );
}
{
  // THE TRAP. Type B has a row today and rows at today+10..today+20: a count
  // of 12, but its first hole is tomorrow. Count-arithmetic would report
  // configuredThrough = today+11.
  const s = summariseCoverage(
    [rt('a', 'DLX', 22, '2026-11-28', null), rt('b', 'STD', 12, '2026-11-27', '2026-11-08')],
    TODAY,
  );
  const gap = s.gaps.find((g) => g.code === 'STD');
  check('the gapped type is reported', gap !== undefined);
  check(
    'its first missing date is the MEASURED one, not today+count',
    gap.firstMissingDate === '2026-11-08',
    'count-arithmetic would have said 2026-11-19',
  );
  check(
    'its contiguous end is the day before the hole',
    gap.configuredThrough === '2026-11-07',
    String(gap.configuredThrough),
  );
  check(
    'the headline collapses to the gapped type, not the healthy one',
    s.fullyConfiguredThrough === '2026-11-07',
    String(s.fullyConfiguredThrough),
  );
  check(
    'missingDates is a total over the measured window',
    gap.missingDates === 22 - 12,
    String(gap.missingDates),
  );
  check(
    'the solid type is NOT listed as a gap',
    s.gaps.every((g) => g.code !== 'DLX'),
  );
}
{
  // A room type with nothing at all: unsellable from today.
  const s = summariseCoverage(
    [rt('a', 'DLX', 30, '2026-12-06', null), rt('b', 'NEW', 0, null, '2026-11-07')],
    TODAY,
  );
  const gap = s.gaps.find((g) => g.code === 'NEW');
  check('a brand-new room type is reported as a gap', gap !== undefined);
  check('with no contiguous end at all', gap.configuredThrough === null);
  check('and its first missing date is today', gap.firstMissingDate === '2026-11-07');
  check(
    'the headline is null: nothing is fully sellable',
    s.fullyConfiguredThrough === null,
    'one unsellable category must not be hidden behind a healthy one',
  );
  check('daysRemaining is 0 when the headline is null', s.daysRemaining === 0);
}
{
  // The headline is the EARLIEST contiguous end, not the latest or the mean.
  const s = summariseCoverage(
    [
      rt('a', 'AAA', 100, '2027-02-14', null),
      rt('b', 'BBB', 30, '2026-12-06', '2026-12-07'),
      rt('c', 'CCC', 60, '2027-01-05', '2027-01-06'),
    ],
    TODAY,
  );
  check(
    'the horizon is the earliest end across room types',
    s.fullyConfiguredThrough === '2026-12-06',
    String(s.fullyConfiguredThrough),
  );
  check('every gapped type is listed', s.gaps.length === 2, `${String(s.gaps.length)} gap(s)`);
}

/* -------------------------------------------------------------------------- */
/*  Worked examples, stated as a table so the contract is readable            */
/* -------------------------------------------------------------------------- */

/**
 * Each row is a concrete scenario with its expected output. Today is
 * 2026-11-07 throughout. `window` is today..max(lastConfiguredDate), which is
 * the span `missingDates` is measured over.
 */
console.log('\nWorked examples (today = 2026-11-07).');

const EXAMPLES = [
  {
    label: 'solid: one type, today..today',
    coverage: [rt('a', 'DLX', 1, '2026-11-07', null)],
    through: '2026-11-07',
    daysRemaining: 0,
    gapCodes: [],
  },
  {
    label: 'solid: one type, today..+9 (10 rows)',
    coverage: [rt('a', 'DLX', 10, '2026-11-16', null)],
    through: '2026-11-16',
    daysRemaining: 9,
    gapCodes: [],
  },
  {
    label: 'no inventory at all: 1 type, 0 rows',
    coverage: [rt('a', 'DLX', 0, null, '2026-11-07')],
    through: null,
    daysRemaining: 0,
    gapCodes: ['DLX'],
  },
  {
    label: 'FIRST date missing, later dates present',
    coverage: [rt('a', 'DLX', 5, '2026-11-12', '2026-11-07')],
    through: null,
    daysRemaining: 0,
    gapCodes: ['DLX'],
  },
  {
    label: 'INTERNAL gap: today ok, hole at +1, resumes +10..+20',
    coverage: [rt('a', 'DLX', 12, '2026-11-27', '2026-11-08')],
    through: '2026-11-07',
    daysRemaining: 0,
    gapCodes: ['DLX'],
  },
  {
    label: 'TRAILING gap only: solid today..+29, window reaches +99',
    coverage: [
      rt('a', 'DLX', 100, '2027-02-14', null),
      rt('b', 'STD', 30, '2026-12-06', '2026-12-07'),
    ],
    through: '2026-12-06',
    daysRemaining: 29,
    gapCodes: ['STD'],
  },
  {
    label: 'one healthy type cannot mask an unsellable one',
    coverage: [rt('a', 'DLX', 100, '2027-02-14', null), rt('b', 'NEW', 0, null, '2026-11-07')],
    through: null,
    daysRemaining: 0,
    gapCodes: ['NEW'],
  },
  {
    // 2026-11-07..2028-03-01 inclusive is 481 dates, which includes 2028-02-29.
    // A 365-day assumption, or an off-by-one on the leap day, lands on 480 and
    // reports a phantom gap.
    label: 'leap day inside the window is just another date',
    coverage: [rt('a', 'DLX', 481, '2028-03-01', null)],
    through: '2028-03-01',
    daysRemaining: 480,
    gapCodes: [],
  },
];

for (const example of EXAMPLES) {
  const s = summariseCoverage(example.coverage, TODAY);
  const codes = s.gaps.map((g) => g.code).sort();
  const ok =
    s.fullyConfiguredThrough === example.through &&
    s.daysRemaining === example.daysRemaining &&
    JSON.stringify(codes) === JSON.stringify([...example.gapCodes].sort());
  check(
    example.label,
    ok,
    `through=${String(s.fullyConfiguredThrough)} daysRemaining=${String(
      s.daysRemaining,
    )} gaps=[${codes.join(',')}]`,
  );
}

check(
  'the leap-spanning window is 481 dates, not 480: the leap day is counted',
  enumerateDates(TODAY, d('2028-03-01')).length === 481 &&
    enumerateDates(TODAY, d('2028-03-01')).includes('2028-02-29'),
  `${String(enumerateDates(TODAY, d('2028-03-01')).length)} dates`,
);
check(
  'daysRemaining agrees with daysBetween across the leap day',
  summariseCoverage([rt('a', 'DLX', 481, '2028-03-01', null)], TODAY).daysRemaining ===
    daysBetween(TODAY, d('2028-03-01')),
  String(daysBetween(TODAY, d('2028-03-01'))),
);

console.log('\nUTC handling: no local-timezone leakage.');
check(
  'toCalendarDate reads the UTC date, not the host local date',
  toCalendarDate(new Date('2026-11-07T23:30:00.000Z')) === '2026-11-07' &&
    toCalendarDate(new Date('2026-11-07T00:30:00.000Z')) === '2026-11-07',
  'both ends of the UTC day map to the same calendar date',
);
check(
  'a positive-offset instant still maps by UTC',
  toCalendarDate(new Date('2026-11-07T18:30:00.000Z')) === '2026-11-07',
  'in Asia/Kolkata that instant is already 2026-11-08 local',
);
check(
  'planHorizon normalises a mid-day clock to UTC midnight',
  planHorizon({
    throughDate: '2026-11-20',
    today: new Date('2026-11-07T18:30:00.000Z'),
  }).from.toISOString() === '2026-11-07T00:00:00.000Z',
);
check(
  'every generated date is UTC midnight, so @db.Date cannot shift',
  enumerateDates(d('2026-11-07'), d('2026-11-09')).every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) &&
    chunkRange(TODAY, addCalendarDays(TODAY, 5)).every(
      (c) =>
        c.from.toISOString().endsWith('T00:00:00.000Z') &&
        c.to.toISOString().endsWith('T00:00:00.000Z'),
    ),
);

/* -------------------------------------------------------------------------- */
/*  Static: the generator cannot update or delete                            */
/* -------------------------------------------------------------------------- */

const ROOT = new URL('../../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, ROOT), 'utf8');

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

console.log('\nThe comment stripper itself.');
{
  const probe = '/* DO UPDATE */\nconst a = 1;\n// DO UPDATE\nconst b = "KEEP";';
  const out = stripComments(probe);
  check(
    'it removes prose and keeps code',
    !out.includes('DO UPDATE') && out.includes('KEEP') && out.includes('const a = 1;'),
  );
  const multi = '/* a\nb\nc */\nx';
  check(
    'it preserves line numbering',
    stripComments(multi).split('\n').length === multi.split('\n').length,
  );
}

console.log('\nThe repository is strictly additive.');
{
  const repo = stripComments(
    read('apps/api/src/modules/inventory/inventory-horizon.repository.ts'),
  );

  check('it uses ON CONFLICT ... DO NOTHING', /ON CONFLICT[\s\S]{0,80}DO NOTHING/.test(repo));
  check(
    'it NEVER uses DO UPDATE',
    !/DO UPDATE/i.test(repo),
    'an existing row carries live sold/blocked/overbooking state',
  );
  check(
    'the conflict target is the schema unique key',
    /"propertyId",\s*"roomTypeId",\s*"stayDate"/.test(repo),
    'inventory_day_unique_per_date',
  );
  check('it issues no DELETE on inventory_day', !/DELETE\s+FROM\s+inventory_day/i.test(repo));
  check(
    'it issues no UPDATE on inventory_day',
    !/UPDATE\s+inventory_day/i.test(repo) && !repo.includes('inventoryDay.update'),
    'cancellation refuses when a night is missing, so rows must never be removed either',
  );
  check(
    'new rows start at sold=0, blocked=0, overbookingAllowance=0',
    /0,\s*0,\s*0,/.test(repo),
    'approved decision 6',
  );
  check(
    'physical excludes OUT_OF_ORDER and nothing else',
    repo.includes(`"status" <> 'OUT_OF_ORDER'`) && !repo.includes('OUT_OF_SERVICE'),
    'approved decision 8: OUT_OF_SERVICE stays counted',
  );
  check(
    'the room count is constrained to the same property too',
    /r\."propertyId"\s*=\s*rt\."propertyId"/.test(repo),
    'redundant under the composite FK, kept deliberately',
  );
  check(
    'it takes no FOR UPDATE on inventory_day',
    !/FOR UPDATE/i.test(repo),
    'so it adds no edge to the reservation lock graph',
  );
  check(
    'every interpolation is a tagged-template binding, not string concatenation',
    !/\$\{[^}]*\}\s*\+/.test(repo) && !/executeRawUnsafe|queryRawUnsafe/.test(repo),
  );
}

console.log('\nThe policy module stays unit-testable.');
{
  const policy = stripComments(read('apps/api/src/modules/inventory/inventory-horizon.policy.ts'));
  const specifiers = [...policy.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  check(
    'it has no relative imports',
    specifiers.every((s) => !s.startsWith('.')),
    specifiers.length === 0 ? 'no imports at all' : specifiers.join(', '),
  );
  check('it throws nothing: refusals are results', !/throw new/.test(policy));
}

console.log('\nAuthorization and the booking-error distinction.');
{
  const service = stripComments(
    read('apps/api/src/modules/inventory/inventory-horizon.service.ts'),
  );
  check(
    'GET requires RESERVATIONS_READ',
    /authorise\(userId, hotelId, Permission\.RESERVATIONS_READ\)/.test(service),
  );
  check(
    'POST requires PROPERTY_SETTINGS',
    /authorise\(userId, hotelId, Permission\.PROPERTY_SETTINGS\)/.test(service),
  );
  check(
    'it resolves the property through the shared grant predicate',
    service.includes('grantedPropertyWhere({ userId, codeOrId, operableOnly: false })'),
    'operableOnly unchanged, per approved decision 12',
  );
  check(
    'a missing grant is 404 BEFORE any permission 403',
    service.indexOf('TenantScopeViolationError') < service.indexOf('requirePermissionFromGrants') &&
      service.includes('TenantScopeViolationError'),
  );
  check(
    'it unions roles (findMany), so a second role is not ignored',
    service.includes('userPropertyRole.findMany') &&
      !service.includes('userPropertyRole.findFirst'),
  );
  check(
    'today is the current UTC calendar date, from the injected clock',
    service.includes('toCalendarDate(this.clock.now())') && !/new Date\(\)/.test(service),
    'the approved contract; no new Date() in domain code',
  );
  check(
    'the property timezone is NOT substituted',
    !service.includes('currentDateInTimeZone('),
    'an earlier draft used it; an administrative cap must mean the same everywhere',
  );
  check(
    'the extension writes an audit_log row via the existing mechanism',
    service.includes('tx.auditLog.create(') &&
      service.includes("event: 'INVENTORY_HORIZON_EXTENDED'"),
    'same table and call as property-setup; no new audit framework',
  );
  check(
    'the audit row is written inside the same transaction as the inserts',
    service.indexOf('insertRange(') < service.indexOf('tx.auditLog.create(') &&
      service.indexOf('tx.auditLog.create(') < service.indexOf('return { created: total'),
    'a rolled-back extension leaves no trail claiming it happened',
  );
  check(
    'no non-null cast stands in for a narrowed local',
    !/ as Date\b/.test(
      stripComments(read('apps/api/src/modules/inventory/inventory-horizon.policy.ts')),
    ),
    'the policy narrows explicitly instead',
  );
  check(
    'all chunks run inside ONE transaction, so the extension is atomic',
    /inTransaction\(/.test(service) && /for \(const chunk of plan\.chunks\)/.test(service),
    'no partial-completion state to document',
  );

  const booking = stripComments(
    read('apps/api/src/modules/reservations/create-reservation.service.ts'),
  );
  check(
    'a calendar gap now raises InventoryNotConfiguredError',
    booking.includes('throw new InventoryNotConfiguredError('),
  );
  check(
    'the genuine sold-out case still raises RoomUnavailableError',
    (booking.match(/throw new RoomUnavailableError\(/g) ?? []).length >= 2,
    'the two cases stay distinct',
  );
  check(
    'the inventory-gap branch no longer reports "no rooms"',
    !/RoomUnavailableError\(\{[\s\S]{0,120}nightsConfigured/.test(booking),
  );
}

console.log('\nThe seed was not touched.');
{
  const seed = read('packages/database/prisma/seed.ts');
  check('INVENTORY_DAYS_FORWARD is still 60', seed.includes('const INVENTORY_DAYS_FORWARD = 60;'));
  check(
    'the seed still uses createMany, not the new generator',
    seed.includes('inventoryDay.createMany'),
  );
  check('the seed does not import the new module', !seed.includes('inventory-horizon'));
}

/* ========================================================================== */
console.log('');
if (failures === 0) {
  console.log('All inventory horizon checks passed.');
} else {
  console.error(`${String(failures)} check(s) FAILED.`);
  process.exit(1);
}
