/**
 * Unit tests for the pure room-block policy.
 *
 * ===========================================================================
 * WHAT THIS CAN AND CANNOT PROVE.
 *
 * `room-block.policy.ts` ships ahead of its endpoints, so these tests are the
 * only thing standing between its arithmetic and the first writer that
 * consumes it. They cover what the module actually owns:
 *
 *   * the inclusive/exclusive conversion, in BOTH directions and round-trip.
 *     The API accepts an inclusive `throughDate`, the database stores an
 *     exclusive one, and this is the single place that knows both -- the
 *     easiest place in the whole feature to lose or gain a night;
 *   * night enumeration, including single-night and month-boundary ranges;
 *   * the contribution rule: a specific-room block is 1, a category block is
 *     its count, and both contribute;
 *   * range refusals, and specifically that NO date floor is applied.
 *
 * NOT PROVED HERE: that a block transaction locks inventory in canonical
 * order, that capacity is refused by `inventory_day_not_oversold`, that the
 * posted-revenue guard runs, or that any of the block endpoints exist -- they
 * do not. All of that belongs to the later increment.
 * ===========================================================================
 */

import {
  MAX_BLOCK_DAYS,
  POSTED_REVENUE_GUARD_COVERS_ARRIVAL_NIGHT_ONLY,
  TRANSACTED_NIGHT_LINE_KIND,
  contributionPerNight,
  enumerateNights,
  evaluateRange,
  nightCountInclusive,
  toExclusiveEnd,
  toInclusiveEnd,
} from '../../apps/api/src/modules/inventory/room-block.policy.ts';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n════ room block policy ════\n');

/* ------------------------------------------------------------------ 1 */
console.log('1. Inclusive night counting.');
{
  check('a single night counts 1', nightCountInclusive('2026-11-10', '2026-11-10') === 1);
  check(
    '10th..15th is SIX nights, not five',
    nightCountInclusive('2026-11-10', '2026-11-15') === 6,
    String(nightCountInclusive('2026-11-10', '2026-11-15')),
  );
  check(
    'it crosses a month boundary correctly',
    nightCountInclusive('2026-11-29', '2026-12-02') === 4,
    String(nightCountInclusive('2026-11-29', '2026-12-02')),
  );
  check(
    'and a leap day',
    nightCountInclusive('2028-02-28', '2028-03-01') === 3,
    String(nightCountInclusive('2028-02-28', '2028-03-01')),
  );
}

/* ------------------------------------------------------------------ 2 */
console.log('\n2. The inclusive/exclusive conversion.');
{
  check(
    'the stored end is the day AFTER the last blocked night',
    toExclusiveEnd('2026-11-15') === '2026-11-16',
    toExclusiveEnd('2026-11-15'),
  );
  check(
    'and reading it back gives the inclusive end again',
    toInclusiveEnd('2026-11-16') === '2026-11-15',
    toInclusiveEnd('2026-11-16'),
  );
  check(
    'the round trip is lossless across a month boundary',
    toInclusiveEnd(toExclusiveEnd('2026-11-30')) === '2026-11-30',
  );
  check(
    'and across a year boundary',
    toInclusiveEnd(toExclusiveEnd('2026-12-31')) === '2026-12-31',
  );
  check(
    'a single-night block stores from and through one day apart',
    toExclusiveEnd('2026-11-10') === '2026-11-11',
    `from=2026-11-10 through=${toExclusiveEnd('2026-11-10')}`,
  );
  check(
    'so daterange(from, through) is never empty — which would overlap nothing',
    toExclusiveEnd('2026-11-10') > '2026-11-10',
  );
}

/* ------------------------------------------------------------------ 3 */
console.log('\n3. Night enumeration.');
{
  const nights = enumerateNights('2026-11-10', '2026-11-15');
  check('six nights for 10th..15th', nights.length === 6, nights.join(','));
  check('ascending, starting at fromDate', nights[0] === '2026-11-10');
  check('and ending at the INCLUSIVE throughDate', nights[5] === '2026-11-15');
  check(
    'the count always equals nightCountInclusive',
    enumerateNights('2026-11-29', '2026-12-02').length ===
      nightCountInclusive('2026-11-29', '2026-12-02'),
  );
  check(
    'the exclusive stored end is NOT among the enumerated nights',
    !enumerateNights('2026-11-10', '2026-11-15').includes(toExclusiveEnd('2026-11-15')),
  );

  const one = enumerateNights('2026-11-10', '2026-11-10');
  check(
    'a single-night range enumerates exactly that one night',
    one.length === 1 && one[0] === '2026-11-10',
    one.join(','),
  );
}

/* ------------------------------------------------------------------ 4 */
console.log('\n4. Contribution to inventory_day.blocked.');
{
  check(
    'a specific-room block contributes exactly 1',
    contributionPerNight({ kind: 'SPECIFIC_ROOM', roomId: 'r1' }) === 1,
  );
  check(
    'a category block contributes its count',
    contributionPerNight({ kind: 'CATEGORY', rooms: 3 }) === 3,
  );
  check(
    'a one-unit category block and a specific-room block contribute the same',
    contributionPerNight({ kind: 'CATEGORY', rooms: 1 }) ===
      contributionPerNight({ kind: 'SPECIFIC_ROOM', roomId: 'r1' }),
    'both reduce category capacity — that is what stops double-counting',
  );
  check(
    'no shape contributes zero — every active block withholds something',
    contributionPerNight({ kind: 'SPECIFIC_ROOM', roomId: 'r1' }) > 0 &&
      contributionPerNight({ kind: 'CATEGORY', rooms: 1 }) > 0,
  );
}

/* ------------------------------------------------------------------ 5 */
console.log('\n5. Range validation — and what it deliberately does NOT check.');
{
  const ok = evaluateRange('2026-11-10', '2026-11-15');
  check('a well-formed range is accepted', ok.ok === true);
  check('and carries its enumerated nights', ok.ok === true && ok.nights.length === 6);

  const inverted = evaluateRange('2026-11-15', '2026-11-10');
  check(
    'an inverted range is refused',
    inverted.ok === false && inverted.refusal.kind === 'INVERTED',
  );

  const malformed = evaluateRange('not-a-date', '2026-11-10');
  check(
    'a malformed fromDate is refused, naming the field',
    malformed.ok === false &&
      malformed.refusal.kind === 'MALFORMED' &&
      malformed.refusal.field === 'fromDate',
  );

  const sameDay = evaluateRange('2026-11-10', '2026-11-10');
  check('a single-night range is accepted, not treated as empty', sameDay.ok === true);

  check(
    `the cap is ${String(MAX_BLOCK_DAYS)} days, matching the horizon`,
    MAX_BLOCK_DAYS === 730,
    String(MAX_BLOCK_DAYS),
  );
  const atCap = evaluateRange('2026-11-10', toInclusiveEnd(addDays('2026-11-10', 730)));
  check(
    'exactly 730 nights is accepted — the cap is inclusive',
    atCap.ok === true && atCap.nights.length === 730,
    atCap.ok === true ? String(atCap.nights.length) : 'refused',
  );
  const overCap = evaluateRange('2026-11-10', toInclusiveEnd(addDays('2026-11-10', 731)));
  check('731 nights is refused', overCap.ok === false && overCap.refusal.kind === 'TOO_LONG');

  // C1. This is the limitation, asserted as a limitation: the policy applies
  // no date floor because no authoritative business date exists. It is NOT a
  // test that creating a backdated block succeeds -- no block can be created
  // at all yet -- it asserts that this module refuses nothing on date grounds.
  const past = evaluateRange('2020-01-01', '2020-01-05');
  check(
    'a past range is NOT refused here: no authoritative business date exists (C1)',
    past.ok === true,
    'the policy has no date floor, and may not claim one',
  );
}

/* ------------------------------------------------------------------ 6 */
console.log('\n6. The posted-revenue guard’s documented scope.');
{
  check(
    'ROOM_CHARGE is the only transaction signal',
    TRANSACTED_NIGHT_LINE_KIND === 'ROOM_CHARGE',
    TRANSACTED_NIGHT_LINE_KIND,
  );
  check(
    'the module records that the guard covers the arrival night only',
    POSTED_REVENUE_GUARD_COVERS_ARRIVAL_NIGHT_ONLY === true,
    'nights 2..n of an in-house stay carry no ROOM_CHARGE until night audit exists',
  );
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

console.log('');
if (failures > 0) {
  console.error(`${String(failures)} room block policy check(s) failed.`);
  process.exit(1);
}
console.log('All room block policy checks passed.');
