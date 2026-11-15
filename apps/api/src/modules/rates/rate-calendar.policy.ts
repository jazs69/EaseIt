/**
 * Pure rate-calendar arithmetic. No Nest, no Prisma, no clock, no I/O.
 *
 * ===========================================================================
 * Everything here is a total function of its arguments, which is what makes
 * the effective-rate rule testable without a database and reusable by F9
 * without dragging a repository along.
 *
 * WHY NOT IMPORT THE DATE HELPERS FROM `inventory-horizon.policy.ts`. They are
 * equivalent, and the duplication below is four small functions. But that file
 * describes *inventory horizon* policy, and importing from it would couple the
 * rates module to inventory's internals through a path that has nothing to do
 * with either module's contract. The narrowest thing that works is a local
 * copy (CLAUDE.md section 5). If a third module needs them, they belong in
 * `packages/types` alongside `addDays` and `enumerateStayDates`, not in
 * whichever module happened to need them first.
 * ===========================================================================
 */

import { resolveRate, type PricingRuleCandidate, type RateSource } from './rate-pricing.policy.js';

/** `YYYY-MM-DD`. The same shape `businessDateSchema` validates. */
export type CalendarDate = string;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Parses `YYYY-MM-DD` into a UTC midnight instant, or null.
 *
 * Strict: the shape is checked, then the parsed value is re-formatted and
 * compared, so `2026-02-30` is rejected rather than silently rolling over to
 * 2026-03-02 the way `new Date` would.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!DATE_SHAPE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return toCalendarDate(parsed) === value ? parsed : null;
}

/** Formats a UTC instant back to `YYYY-MM-DD`. */
export function toCalendarDate(instant: Date): CalendarDate {
  return instant.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Every date from `from` to `to`, both INCLUSIVE. Empty when `to < from`. */
export function enumerateInclusive(from: Date, to: Date): CalendarDate[] {
  const out: CalendarDate[] = [];
  for (let cursor = from.getTime(); cursor <= to.getTime(); cursor += MS_PER_DAY) {
    out.push(toCalendarDate(new Date(cursor)));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The effective-rate rule                                                   */
/* -------------------------------------------------------------------------- */

/**
 * F2's two-tier rule: override wins, otherwise the assignment default.
 *
 * ===========================================================================
 * STILL HERE, STILL EXPORTED, STILL UNCHANGED — F3 did not redefine it. It is
 * now the degenerate case of `resolveRate` in `rate-pricing.policy.ts`: the
 * same answer that resolver gives when no pricing rule matches. Keeping it
 * means any existing caller, and F9's eventual per-night sum, keeps working
 * byte for byte.
 *
 * Use `resolveRate` for anything that must account for seasonal, weekday or
 * weekend rules. Use this only where there are provably none.
 *
 * `null` means "no override exists for this night" — a different fact from an
 * override of zero, and the distinction is load-bearing: a complimentary night
 * is legitimately priced at 0, so a falsy check here would silently replace a
 * deliberate zero with the default. Hence the explicit `=== null`.
 * ===========================================================================
 */
export function effectiveRateMinor(
  defaultRateMinor: number,
  overrideRateMinor: number | null,
): number {
  return overrideRateMinor === null ? defaultRateMinor : overrideRateMinor;
}

/**
 * One night, as the calendar reports it.
 *
 * The first five fields are F2's and keep their exact F2 meaning — in
 * particular `defaultRateMinor` is still the ASSIGNMENT default, not a
 * rule-derived figure, and `overrideRateMinor`/`hasOverride` still describe
 * only an explicit `rate_plan_day` row. F3 adds fields; it redefines none.
 */
export interface CalendarDayView {
  stayDate: CalendarDate;
  defaultRateMinor: number;
  overrideRateMinor: number | null;
  effectiveRateMinor: number;
  hasOverride: boolean;
  /* -- F3 additions ----------------------------------------------------- */
  source: RateSource;
  ruleId: string | null;
  ruleName: string | null;
  ruleRateMinor: number | null;
  maskedSource: RateSource | null;
  maskedRuleId: string | null;
  maskedRuleName: string | null;
  isAmbiguous: boolean;
  conflictingRuleIds: readonly string[];
}

/**
 * Fills a date window, resolving every night through the shared resolver.
 *
 * The window is built from the requested range rather than from the rows that
 * came back, so a night with no override and no matching rule appears as a day
 * at the default instead of being missing. A sparse response would make the
 * client reconstruct the gaps, and a client that got that wrong would render a
 * blank cell as "unpriced" rather than "default".
 *
 * `overrides` is keyed by `YYYY-MM-DD`. A Map rather than a scan per date:
 * 400 dates against 400 overrides is 160,000 comparisons the linear version
 * would do for no reason.
 *
 * `rules` are already filtered by the repository to this plan, enabled, and
 * carrying a price for THIS room type. A rule with no price for the category
 * does not apply to it, and passing it in would make the resolver decide
 * something it has no number for.
 */
export function buildCalendarWindow(
  dates: readonly CalendarDate[],
  defaultRateMinor: number,
  overrides: ReadonlyMap<CalendarDate, number>,
  rules: readonly PricingRuleCandidate[] = [],
  weekendDays: readonly number[] = [],
): CalendarDayView[] {
  return dates.map((stayDate) => {
    const resolution = resolveRate({
      stayDate,
      defaultRateMinor,
      overrideRateMinor: overrides.get(stayDate) ?? null,
      rules,
      weekendDays,
    });

    return {
      stayDate,
      defaultRateMinor: resolution.defaultRateMinor,
      overrideRateMinor: resolution.overrideRateMinor,
      effectiveRateMinor: resolution.effectiveRateMinor,
      // F2's meaning exactly: an explicit date override exists. NOT "a price
      // was set by something" — a seasonal rule is not an override.
      hasOverride: resolution.overrideRateMinor !== null,
      source: resolution.source,
      ruleId: resolution.ruleId,
      ruleName: resolution.ruleName,
      ruleRateMinor: resolution.ruleRateMinor,
      maskedSource: resolution.maskedSource,
      maskedRuleId: resolution.maskedRuleId,
      maskedRuleName: resolution.maskedRuleName,
      isAmbiguous: resolution.isAmbiguous,
      conflictingRuleIds: resolution.conflictingRuleIds,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Range validation                                                          */
/* -------------------------------------------------------------------------- */

export type RangeRefusal =
  | { kind: 'UNPARSEABLE'; field: 'fromDate' | 'toDate' }
  | { kind: 'INVERTED' }
  | { kind: 'TOO_WIDE'; days: number; limit: number };

export interface ParsedRange {
  from: Date;
  to: Date;
  dates: CalendarDate[];
}

/**
 * Validates and expands a requested window.
 *
 * Returns a refusal rather than throwing: an out-of-range request is an
 * expected, recoverable outcome with a reason the caller should report, not a
 * broken invariant (CLAUDE.md section 5 — "expected-and-recoverable is a
 * result, not an exception"). The service turns the refusal into the typed
 * domain error, which keeps this file free of Nest and of HTTP.
 */
export function parseRange(
  fromDate: string,
  toDate: string,
  maxDays: number,
): ParsedRange | RangeRefusal {
  const from = parseCalendarDate(fromDate);
  if (from === null) return { kind: 'UNPARSEABLE', field: 'fromDate' };

  const to = parseCalendarDate(toDate);
  if (to === null) return { kind: 'UNPARSEABLE', field: 'toDate' };

  if (daysBetween(from, to) < 0) return { kind: 'INVERTED' };

  // Inclusive of both ends, so a single-day window is 1 day, not 0.
  const days = daysBetween(from, to) + 1;
  if (days > maxDays) return { kind: 'TOO_WIDE', days, limit: maxDays };

  return { from, to, dates: enumerateInclusive(from, to) };
}

export function isRangeRefusal(value: ParsedRange | RangeRefusal): value is RangeRefusal {
  return 'kind' in value;
}
