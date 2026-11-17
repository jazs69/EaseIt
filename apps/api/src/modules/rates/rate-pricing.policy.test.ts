/**
 * Nightly rate resolution: override > seasonal > weekday > weekend > default,
 * priority within a tier, and a tie is reported, never decided by row order.
 */

import { describe, expect, it } from 'vitest';

import {
  dayOfWeek,
  resolveRate,
  ruleMatches,
  withinSeason,
  type PricingRuleCandidate,
  type ResolveInput,
} from './rate-pricing.policy.js';

const SAT = 6;
const SUN = 0;

const seasonal = (
  id: string,
  startDate: string,
  endDate: string,
  amountMinor: number,
  priority = 0,
): PricingRuleCandidate => ({
  id,
  name: id,
  kind: 'SEASONAL',
  startDate,
  endDate,
  daysOfWeek: [],
  priority,
  amountMinor,
});
const weekday = (
  id: string,
  daysOfWeek: number[],
  amountMinor: number,
  priority = 0,
): PricingRuleCandidate => ({
  id,
  name: id,
  kind: 'WEEKDAY',
  startDate: null,
  endDate: null,
  daysOfWeek,
  priority,
  amountMinor,
});
const weekend = (id: string, amountMinor: number, priority = 0): PricingRuleCandidate => ({
  id,
  name: id,
  kind: 'WEEKEND',
  startDate: null,
  endDate: null,
  daysOfWeek: [],
  priority,
  amountMinor,
});

// 2026-12-26 is a Saturday.
const input = (rules: PricingRuleCandidate[], extra: Partial<ResolveInput> = {}): ResolveInput => ({
  stayDate: '2026-12-26',
  defaultRateMinor: 300_000,
  overrideRateMinor: null,
  rules,
  weekendDays: [SAT, SUN],
  ...extra,
});

describe('date helpers', () => {
  it('dayOfWeek reads the calendar date, whatever the host zone', () => {
    expect(dayOfWeek('2026-11-17')).toBe(2); // Tuesday
    expect(dayOfWeek('2026-12-26')).toBe(SAT);
    expect(dayOfWeek('2027-01-03')).toBe(SUN);
  });

  it('a season is inclusive at both ends and may cross New Year', () => {
    expect(withinSeason('2026-12-20', '2026-12-20', '2027-01-10')).toBe(true);
    expect(withinSeason('2027-01-10', '2026-12-20', '2027-01-10')).toBe(true);
    expect(withinSeason('2027-01-11', '2026-12-20', '2027-01-10')).toBe(false);
    expect(withinSeason('2026-12-19', '2026-12-20', '2027-01-10')).toBe(false);
    expect(withinSeason('2026-12-25', null, '2027-01-10')).toBe(false);
  });

  it('a WEEKEND rule matches nothing at a property with no weekend', () => {
    expect(ruleMatches(weekend('w', 1), '2026-12-26', [])).toBe(false);
  });
});

describe('resolveRate precedence', () => {
  const rules = [
    weekend('weekend', 350_000),
    weekday('saturdays', [SAT], 380_000),
    seasonal('christmas', '2026-12-20', '2027-01-05', 450_000),
  ];

  it('nothing matches: the default', () => {
    const r = resolveRate(input([], { stayDate: '2026-11-17' }));
    expect([r.effectiveRateMinor, r.source]).toEqual([300_000, 'DEFAULT']);
  });

  it('seasonal beats weekday beats weekend', () => {
    expect(resolveRate(input(rules)).source).toBe('SEASONAL');
    expect(resolveRate(input(rules.slice(0, 2))).source).toBe('WEEKDAY');
    expect(resolveRate(input(rules.slice(0, 1))).source).toBe('WEEKEND');
    expect(resolveRate(input(rules)).effectiveRateMinor).toBe(450_000);
  });

  it('kind outranks priority: a priority-99 weekend rule still loses to a priority-0 season', () => {
    const r = resolveRate(
      input([
        weekend('loud', 999_999, 99),
        seasonal('quiet', '2026-12-01', '2026-12-31', 400_000, 0),
      ]),
    );
    expect(r.ruleId).toBe('quiet');
  });

  it('within a tier the higher priority wins', () => {
    const r = resolveRate(
      input([
        seasonal('low', '2026-12-01', '2026-12-31', 400_000, 1),
        seasonal('high', '2026-12-24', '2026-12-27', 500_000, 5),
      ]),
    );
    expect([r.ruleId, r.effectiveRateMinor]).toEqual(['high', 500_000]);
  });

  it('the answer does not depend on the order rules arrive in', () => {
    const forward = resolveRate(input(rules));
    const backward = resolveRate(input([...rules].reverse()));
    expect(backward).toEqual(forward);
  });

  it('an override wins and reports the rule it is masking', () => {
    const r = resolveRate(input(rules, { overrideRateMinor: 275_000 }));
    expect(r).toEqual(
      expect.objectContaining({
        effectiveRateMinor: 275_000,
        source: 'DATE_OVERRIDE',
        ruleRateMinor: 450_000,
        maskedSource: 'SEASONAL',
        maskedRuleId: 'christmas',
      }),
    );
  });
});

describe('resolveRate ambiguity', () => {
  const tie = [
    seasonal('a', '2026-12-01', '2026-12-31', 400_000, 3),
    seasonal('b', '2026-12-20', '2026-12-27', 500_000, 3),
  ];

  it('two equal rules in the winning tier: flagged, priced at the default, both named', () => {
    const r = resolveRate(input(tie));
    expect(r).toEqual(
      expect.objectContaining({
        isAmbiguous: true,
        source: 'DEFAULT',
        effectiveRateMinor: 300_000,
      }),
    );
    expect([...r.conflictingRuleIds].sort()).toEqual(['a', 'b']);
  });

  it('a tie in a LOWER tier is not an ambiguity when a higher tier wins', () => {
    const r = resolveRate(
      input([
        weekend('w1', 1, 0),
        weekend('w2', 2, 0),
        seasonal('s', '2026-12-01', '2026-12-31', 400_000),
      ]),
    );
    expect(r.isAmbiguous).toBe(false);
    expect(r.ruleId).toBe('s');
  });

  it('an override is not made uncertain by a tie underneath it, but still reports it', () => {
    const r = resolveRate(input(tie, { overrideRateMinor: 275_000 }));
    expect(r.effectiveRateMinor).toBe(275_000);
    expect(r.isAmbiguous).toBe(true);
    expect(r.maskedRuleId).toBeNull();
  });
});
