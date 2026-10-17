/**
 * Stay pricing and Indian GST.
 *
 * ===========================================================================
 * Pure functions, no database, no clock — so the arithmetic can be reasoned
 * about and tested without a container.
 *
 * Two rules do the real work:
 *
 *   **GST is banded by the nightly tariff, per night.** Under ₹7,500 a night
 *   attracts 12%, ₹7,500 and over attracts 18%. The band is decided by the
 *   *nightly* rate, not the stay total — a four-night stay at ₹3,000 is
 *   ₹12,000 total but still a 12% room, and banding on the total would
 *   overcharge it by six points.
 *
 *   **Rounding is once per night, and the total is the sum of the rounded
 *   nights.** Not a rounded percentage of a stay total. Section 3.4 is
 *   explicit: round at the line level, store the rounded integer, and never
 *   round a total computed from unrounded intermediates — because the day-wise
 *   split the UI shows has to add up to the total beside it, to the paisa.
 *
 * Every amount in and out is an integer in minor units. No float touches a
 * stored figure: `Math.round` is applied to each night's tax and nothing is
 * divided except by an integer night count.
 * ===========================================================================
 */

import type { NightlyLine, ReservationQuote } from '@repo/types';

const DAY_MS = 86_400_000;

/**
 * The slab boundary, in minor units: ₹7,500.
 *
 * A constant rather than a literal at the comparison, because this is a tax
 * rule that changes by statute and somebody will have to find it.
 */
export const GST_SLAB_BOUNDARY_MINOR = 750_000;
export const GST_LOWER_PERCENT = 12;
export const GST_UPPER_PERCENT = 18;

/**
 * The rate to apply to a nightly tariff.
 *
 * A property-configured flat rate wins. With none configured it falls back to
 * the statutory room-tariff slabs: 12% below ₹7,500 a night, 18% at or above.
 *
 * Note which rate belongs where, because it is easy to mix up and expensive to
 * get wrong: 12/18 is the *room tariff* treatment. 5% is the rate for
 * restaurant service in a hotel, charged without input credit — it is not a
 * room-tariff rate, so a property configured to 5% is making a deliberate
 * choice rather than following the default.
 */
export function gstPercentFor(
  nightlyRateMinor: number,
  configuredPercent?: number | null,
): number {
  if (configuredPercent !== undefined && configuredPercent !== null) {
    return configuredPercent;
  }
  return nightlyRateMinor >= GST_SLAB_BOUNDARY_MINOR ? GST_UPPER_PERCENT : GST_LOWER_PERCENT;
}

/** Calendar nights between two `YYYY-MM-DD` dates. */
export function nightsBetween(arrival: string, departure: string): number {
  const from = new Date(`${arrival}T00:00:00.000Z`).getTime();
  const to = new Date(`${departure}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / DAY_MS);
}

/** Each stay date, arrival inclusive and departure exclusive. */
export function stayDates(arrival: string, departure: string): string[] {
  const nights = nightsBetween(arrival, departure);
  const from = new Date(`${arrival}T00:00:00.000Z`).getTime();

  return Array.from({ length: Math.max(0, nights) }, (_, index) =>
    new Date(from + index * DAY_MS).toISOString().slice(0, 10),
  );
}

export interface QuoteInput {
  arrivalDate: string;
  departureDate: string;
  /** The room type's configured rate, in minor units. */
  baseNightlyRateMinor: number;
  overrideNightlyRateMinor?: number | undefined;
  /** Solve backwards from this gross total instead. */
  targetTotalMinor?: number | undefined;
  isTaxExempt: boolean;
  currency: string;
  /** The property's flat GST rate, or null to use the statutory slabs. */
  taxRatePercent?: number | null | undefined;
}

/**
 * Solves for the nightly rate that produces a given **gross** total.
 *
 * ===========================================================================
 * The naive formula is `exTax = total / 1.12`, and it is wrong, because the
 * slab it assumes depends on the answer it produces. A one-night total of
 * ₹10,000 divided by 1.12 gives ₹8,928.57 a night — which is above the ₹7,500
 * boundary, so the correct slab was 18% and the figure contradicts its own
 * premise. Charge it and the hotel has under-collected GST on an invoice that
 * looks arithmetically fine.
 *
 * So both slabs are tried and only a **self-consistent** one is accepted: a
 * 12% solution is valid only if its nightly rate really is under the boundary,
 * and an 18% solution only if its rate really is at or above it.
 *
 * Totals in the narrow band between the two solutions are unreachable — there
 * is no nightly rate that produces them under either slab. Rather than pick
 * one and silently charge something else, the boundary rate is used and the
 * caller is told the achieved total differs from the requested one.
 *
 * Returns the nightly rate; the normal forward path then prices from it, so
 * there is exactly one implementation of the per-night rounding.
 * ===========================================================================
 */
export function solveNightlyRateForTotal(
  targetTotalMinor: number,
  nights: number,
  isTaxExempt: boolean,
  configuredPercent?: number | null,
): number {
  if (nights <= 0) throw new Error('A stay must cover at least one night.');
  if (isTaxExempt) return Math.round(targetTotalMinor / nights);

  // A flat rate has no slab to be consistent with, so the reverse solve is the
  // plain division the brief describes — and it always lands exactly.
  if (configuredPercent !== undefined && configuredPercent !== null) {
    const exTax = targetTotalMinor / (1 + configuredPercent / 100);
    return Math.round(exTax / nights);
  }

  for (const percent of [GST_LOWER_PERCENT, GST_UPPER_PERCENT]) {
    const exTax = targetTotalMinor / (1 + percent / 100);
    const nightly = Math.round(exTax / nights);
    // Accept only if this rate genuinely falls in the slab we assumed.
    if (gstPercentFor(nightly) === percent) return nightly;
  }

  // Unreachable total: it sits between what 12% and 18% can produce. The
  // boundary is the closest defensible answer, and the caller reports the gap.
  return GST_SLAB_BOUNDARY_MINOR;
}

/**
 * Prices a stay.
 *
 * The nightly rate is flat across the stay today, because rate plans and
 * per-date rates belong to the `rates` module and it is not built. The shape
 * here is already per-night so that when it lands, only the source of
 * `nightlyRateMinor` changes — not the totalling, the tax banding, or the
 * rounding.
 */
export function quoteStay(input: QuoteInput): ReservationQuote {
  const nights = nightsBetween(input.arrivalDate, input.departureDate);
  if (nights <= 0) {
    // Guarded by the DTO and the database CHECK as well; asserted here so the
    // pure function cannot be made to divide by zero in a unit test either.
    throw new Error('A stay must cover at least one night.');
  }

  // A target total is solved into a nightly rate, then priced forward like any
  // other rate — so the per-night rounding has exactly one implementation and
  // the day-wise split always adds up to the total beside it.
  const solved =
    input.targetTotalMinor === undefined
      ? undefined
      : solveNightlyRateForTotal(
          input.targetTotalMinor,
          nights,
          input.isTaxExempt,
          input.taxRatePercent,
        );

  const isOverridden =
    input.overrideNightlyRateMinor !== undefined || solved !== undefined;
  const nightlyRateMinor =
    solved ?? input.overrideNightlyRateMinor ?? input.baseNightlyRateMinor;
  const taxRatePercent = input.isTaxExempt
    ? 0
    : gstPercentFor(nightlyRateMinor, input.taxRatePercent);

  const nightly: NightlyLine[] = stayDates(input.arrivalDate, input.departureDate).map(
    (stayDate) => ({
      stayDate: stayDate as NightlyLine['stayDate'],
      nightlyRateMinor,
      // Rounded here, per night, exactly once.
      taxMinor: Math.round((nightlyRateMinor * taxRatePercent) / 100),
    }),
  );

  // Summed from the rounded lines, so the split shown to the guest adds up to
  // the total charged.
  const exTaxMinor = nightly.reduce((sum, line) => sum + line.nightlyRateMinor, 0);
  const taxMinor = nightly.reduce((sum, line) => sum + line.taxMinor, 0);

  const totalMinor = exTaxMinor + taxMinor;

  return {
    nights,
    nightlyRateMinor,
    exTaxMinor,
    taxMinor,
    totalMinor,
    currency: input.currency,
    taxRatePercent,
    isTaxExempt: input.isTaxExempt,
    nightly,
    isOverridden,
    // Reported only when the reverse solve could not land on the number the
    // clerk typed — silence would mean charging a different figure.
    targetAdjustment:
      input.targetTotalMinor !== undefined && input.targetTotalMinor !== totalMinor
        ? { requestedTotalMinor: input.targetTotalMinor, achievedTotalMinor: totalMinor }
        : null,
  };
}
