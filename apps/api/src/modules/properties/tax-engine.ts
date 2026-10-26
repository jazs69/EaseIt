/**
 * Banded GST resolution.
 *
 * ===========================================================================
 * Pure functions over a slab table. No database, no clock, no Nest.
 *
 * This replaces a pair of hardcoded constants. The rate used to be decided by
 * `nightlyRateMinor >= 750_000 ? 18 : 12`, with a single property-wide
 * `taxRatePercent` column able to override it flatly. Both were wrong in the
 * same way: tax policy is something an operator configures and a statute
 * changes, not something a build contains — and that 12 was itself a rate the
 * GST Council had already replaced with 5 by the time it was written, which is
 * the argument for this file in one number.
 *
 * Three rules do the work:
 *
 *   **The band is decided by the nightly tariff, not the stay total.** A
 *   four-night stay at 3,000 a night is 12,000 in total and still a 3,000
 *   room. Banding on the total would push it up a slab and overcharge it.
 *
 *   **Bands are half-open, `[min, max)`.** Adjacent slabs share a boundary
 *   without both claiming the tariff sitting exactly on it. A 7,500 tariff
 *   falls in the slab whose floor is 7,500, not the one whose ceiling is.
 *
 *   **The components are read, not halved.** CGST+SGST is an intra-state
 *   split; an inter-state supply is IGST and is not split at all. The slab
 *   carries all three figures and the CHECK constraint keeps them consistent,
 *   so an invoice prints what was configured rather than what code assumed.
 *
 * Resolution is a scan, not a binary search: a property has three or four
 * slabs, and a scan that is obviously correct beats a bisection that has to be
 * argued about.
 * ===========================================================================
 */

import type { TaxComponents, TaxSlab } from '@repo/types';

/**
 * The statutory room-tariff bands, used only when a property has none.
 *
 * ===========================================================================
 * A fallback, not the policy.
 *
 * Every property in the portfolio is seeded with slabs, so this is reached
 * only by a database that predates the configuration tables or a property
 * created outside the seed. It exists because the alternative — resolving to
 * no slab and therefore 0% — would silently under-collect GST on a live
 * booking, which is the one failure mode worse than refusing to quote.
 *
 * **These are the rates in force since 22 September 2025**: accommodation is
 * exempt up to ₹1,000 a night, 5% without input tax credit from ₹1,001 to
 * ₹7,500, and 18% with ITC above that. The middle band carried 12% with ITC
 * before that date, and this constant said 12% until it was corrected — which
 * over-charged every mid-market room by seven points.
 *
 * A statutory default is the wrong place to be wrong, because it is reached
 * precisely when nobody has configured anything. It is a *fallback*, not the
 * policy: a property that bands differently configures `PropertyTaxSlab` and
 * never reaches this.
 * ===========================================================================
 */
export const STATUTORY_ROOM_TARIFF_SLABS: readonly TaxSlab[] = [
  {
    slabName: 'Exempt tariff (statutory default)',
    minTariffMinor: 0,
    maxTariffMinor: 100_000,
    taxRatePercent: 0,
    cgstRatePercent: 0,
    sgstRatePercent: 0,
  },
  {
    slabName: 'Standard tariff (statutory default)',
    minTariffMinor: 100_000,
    maxTariffMinor: 750_000,
    taxRatePercent: 5,
    cgstRatePercent: 2.5,
    sgstRatePercent: 2.5,
  },
  {
    slabName: 'Premium tariff (statutory default)',
    minTariffMinor: 750_000,
    maxTariffMinor: null,
    taxRatePercent: 18,
    cgstRatePercent: 9,
    sgstRatePercent: 9,
  },
];

/** The slab boundary that still has callers, in minor units. */
export const GST_SLAB_BOUNDARY_MINOR = 750_000;

/**
 * A tariff that falls in no configured band.
 *
 * Not a `DomainError`: this is a server configuration fault rather than
 * something the caller did, and the pure engine deliberately has no dependency
 * on the API's error hierarchy. The service layer catches it and translates.
 */
export class TaxSlabGapError extends Error {
  readonly nightlyRateMinor: number;
  readonly bands: readonly string[];

  constructor(nightlyRateMinor: number, slabs: readonly TaxSlab[]) {
    super(
      `No tax slab covers a nightly tariff of ${String(nightlyRateMinor)} minor units.`,
    );
    this.name = 'TaxSlabGapError';
    this.nightlyRateMinor = nightlyRateMinor;
    this.bands = slabs.map(
      (slab) =>
        `${String(slab.minTariffMinor)}-${
          slab.maxTariffMinor === null ? 'open' : String(slab.maxTariffMinor)
        }`,
    );
  }
}

/**
 * The slab a nightly tariff falls in, or `null` if the table has a gap there.
 *
 * Null is returned rather than defaulted because the two cases need different
 * handling: an empty table means "not configured" and can fall back, while a
 * populated table with a hole in it means "misconfigured" and must be refused.
 * Quietly taxing a hole at 0% turns an operator's data-entry slip into an
 * under-collection that only surfaces at assessment.
 */
export function resolveTaxSlab(
  nightlyRateMinor: number,
  slabs: readonly TaxSlab[],
): TaxSlab | null {
  return (
    slabs.find(
      (slab) =>
        nightlyRateMinor >= slab.minTariffMinor &&
        (slab.maxTariffMinor === null || nightlyRateMinor < slab.maxTariffMinor),
    ) ?? null
  );
}

/** The full split for a nightly tariff, for an invoice to print. */
export function componentsFor(
  nightlyRateMinor: number,
  slabs: readonly TaxSlab[],
): TaxComponents {
  const table = slabs.length === 0 ? STATUTORY_ROOM_TARIFF_SLABS : slabs;
  const slab = resolveTaxSlab(nightlyRateMinor, table);

  if (slab === null) {
    throw new TaxSlabGapError(nightlyRateMinor, table);
  }

  return {
    slabName: slab.slabName,
    taxRatePercent: slab.taxRatePercent,
    cgstRatePercent: slab.cgstRatePercent,
    sgstRatePercent: slab.sgstRatePercent,
  };
}

/**
 * The rate for a nightly tariff, as a percentage.
 *
 * Throws on a gap in a populated table — see `resolveTaxSlab`. A caller that
 * can produce a client-facing error maps it; a caller that cannot would rather
 * fail than price a room wrongly.
 */
export function taxPercentFor(
  nightlyRateMinor: number,
  slabs: readonly TaxSlab[],
): number {
  return componentsFor(nightlyRateMinor, slabs).taxRatePercent;
}

/** The tax on one night, rounded exactly once (section 3.4). */
export function taxOnNight(nightlyRateMinor: number, taxRatePercent: number): number {
  return Math.round((nightlyRateMinor * taxRatePercent) / 100);
}

/**
 * Works backwards from a gross total to the per-unit rate inside it.
 *
 * ===========================================================================
 * The naive formula is `net = gross / 1.05`, and it is wrong, because the slab
 * it assumes depends on the answer it produces.
 *
 * A one-night total of ₹10,000 divided by 1.05 gives ₹9,523.81 — which is
 * above the ₹7,500 boundary, so the correct slab was 18% and the figure
 * contradicts its own premise. Charge it and the hotel has under-collected GST
 * on an invoice that looks arithmetically fine.
 *
 * So every slab is tried and only a **self-consistent** answer is accepted:
 * a slab's solution counts only if the per-unit rate it produces really does
 * fall inside that slab's own band.
 *
 * Some totals are unreachable — they sit in the gap between what two adjacent
 * slabs can produce, and no per-unit rate yields them under either. Rather
 * than pick one and silently charge something else, each slab's candidate is
 * clamped into its own band, priced forward, and whichever lands nearest the
 * requested figure wins. The caller compares the achieved total against the
 * requested one and reports the gap; it is not hidden here.
 *
 * `units` is nights for a stay. The function is deliberately ignorant of what
 * a unit is, because this is tax arithmetic and the band is per unit per day
 * whatever the caller is pricing.
 * ===========================================================================
 */
export function solveUnitNetForGross(
  grossTotalMinor: number,
  units: number,
  slabs: readonly TaxSlab[],
): number {
  if (units <= 0) throw new Error('A gross total must cover at least one unit.');

  const table = slabs.length === 0 ? STATUTORY_ROOM_TARIFF_SLABS : slabs;
  let nearest: { unitNetMinor: number; distance: number } | null = null;

  for (const slab of table) {
    const exTax = grossTotalMinor / (1 + slab.taxRatePercent / 100);
    const candidate = Math.round(exTax / units);

    // Accept immediately if this rate genuinely falls in the slab assumed.
    if (resolveTaxSlab(candidate, table) === slab) return candidate;

    /**
     * Otherwise keep it as a fallback, clamped into the band it belongs to.
     *
     * The ceiling is exclusive, so the top of a closed band is one minor unit
     * below it — a rate exactly on the ceiling belongs to the next slab. An
     * open-ended band has no ceiling to clamp against, and clamping it to the
     * candidate instead would undo the floor clamp in the same expression and
     * hand back a rate outside the band it was supposedly forced into.
     */
    const clamped =
      slab.maxTariffMinor === null
        ? Math.max(candidate, slab.minTariffMinor)
        : Math.min(Math.max(candidate, slab.minTariffMinor), slab.maxTariffMinor - 1);
    const gross = units * (clamped + taxOnNight(clamped, slab.taxRatePercent));
    const distance = Math.abs(gross - grossTotalMinor);

    if (nearest === null || distance < nearest.distance) {
      nearest = { unitNetMinor: clamped, distance };
    }
  }

  // A table always holds at least one slab, so the null branch is unreachable;
  // the zero keeps the function total rather than asserting non-null across a
  // boundary the type system cannot see through (section 5).
  return nearest?.unitNetMinor ?? 0;
}

/**
 * The rate inside a gross total — the slab resolved from the net it implies.
 *
 * The companion to `solveUnitNetForGross` for callers that only need the rate:
 * deriving the tax already inside an agreed, tax-inclusive figure. Resolving
 * the slab from the gross directly would over-rate any total whose gross sits
 * above a boundary its net does not.
 */
export function inclusiveRatePercentFor(
  grossTotalMinor: number,
  units: number,
  slabs: readonly TaxSlab[],
): number {
  if (grossTotalMinor <= 0 || units <= 0) return 0;
  return taxPercentFor(solveUnitNetForGross(grossTotalMinor, units, slabs), slabs);
}

/**
 * Checks a slab table is usable, before it is saved.
 *
 * ===========================================================================
 * Validated on write, so resolution on read cannot fail.
 *
 * Each individual slab is already checked by its zod schema and by four CHECK
 * constraints. What neither can see is the table as a whole: a floor at 0, no
 * overlaps, no gaps, and exactly one open-ended top band. Those are properties
 * of the set, and here is the only place they can be enforced.
 *
 * Returns the problems rather than throwing, because this answers a settings
 * form that should show an operator every mistake at once — an expected,
 * recoverable outcome is a result, not an exception (section 5).
 * ===========================================================================
 */
export function validateSlabTable(slabs: readonly TaxSlab[]): string[] {
  if (slabs.length === 0) return [];

  const problems: string[] = [];
  const ordered = [...slabs].sort((a, b) => a.minTariffMinor - b.minTariffMinor);

  const first = ordered[0];
  if (first !== undefined && first.minTariffMinor !== 0) {
    problems.push(
      'The lowest slab must start at 0, or a tariff below it would be taxed at no rate.',
    );
  }

  const openEnded = ordered.filter((slab) => slab.maxTariffMinor === null);
  if (openEnded.length === 0) {
    problems.push(
      'One slab must be open-ended, or a tariff above the highest ceiling would be taxed at no rate.',
    );
  } else if (openEnded.length > 1) {
    problems.push('Only one slab may be open-ended.');
  }

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const slab = ordered[index];
    const next = ordered[index + 1];
    if (slab === undefined || next === undefined) continue;

    if (slab.maxTariffMinor === null) {
      problems.push(
        `"${slab.slabName}" is open-ended but is not the highest slab, so it swallows "${next.slabName}".`,
      );
      continue;
    }
    if (slab.maxTariffMinor > next.minTariffMinor) {
      problems.push(`"${slab.slabName}" overlaps "${next.slabName}".`);
    }
    if (slab.maxTariffMinor < next.minTariffMinor) {
      problems.push(`A gap sits between "${slab.slabName}" and "${next.slabName}".`);
    }
  }

  return problems;
}
