/**
 * Stay pricing and Indian GST.
 *
 * ===========================================================================
 * Pure functions, no database, no clock — so the arithmetic can be reasoned
 * about and tested without a container.
 *
 * Two rules do the real work:
 *
 *   **GST is banded by the nightly tariff, per night.** Which band, and at
 *   what rate, is the property's configured `PropertyTaxSlab` table — passed
 *   in as data and resolved by `tax-engine.ts`, never hardcoded here. The band
 *   is decided by the *nightly* rate, not the stay total: a four-night stay at
 *   ₹3,000 is ₹12,000 in total but still a ₹3,000 room, and banding on the
 *   total would push it up a slab and overcharge it.
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

import type { NightlyLine, ReservationQuote, TaxSlab } from '@repo/types';

import {
  componentsFor,
  solveUnitNetForGross,
  taxOnNight,
} from '../properties/tax-engine.js';

const DAY_MS = 86_400_000;

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
  /**
   * The property's configured GST bands, lowest floor first.
   *
   * Required rather than optional, and a table rather than a rate, so a caller
   * cannot accidentally price a stay with no tax policy at all. An empty array
   * is accepted and means "not configured", which the engine answers with the
   * statutory default — the deliberate choice, not the accidental one.
   */
  taxSlabs: readonly TaxSlab[];
}

/**
 * Solves for the nightly rate that produces a given **gross** total.
 *
 * ===========================================================================
 * The naive formula is `exTax = total / 1.05`, and it is wrong, because the
 * slab it assumes depends on the answer it produces. A one-night total of
 * ₹10,000 divided by 1.05 gives ₹9,523.81 a night — which is above the ₹7,500
 * boundary, so the correct slab was 18% and the figure contradicts its own
 * premise. Charge it and the hotel has under-collected GST on an invoice that
 * looks arithmetically fine.
 *
 * The arithmetic — trying every slab, accepting only a self-consistent answer,
 * and clamping into the nearest band when a total is unreachable — lives in
 * `tax-engine.ts`, because deriving the net inside a tax-inclusive figure is
 * tax math and the folio needs the same answer when it splits an agreed total.
 * Two implementations would be two answers to one question.
 *
 * What stays here is the stay semantics: a night is the unit, and an exempt
 * stay short-circuits. Returns the nightly rate; the normal forward path then
 * prices from it, so there is exactly one implementation of the per-night
 * rounding.
 * ===========================================================================
 */
export function solveNightlyRateForTotal(
  targetTotalMinor: number,
  nights: number,
  isTaxExempt: boolean,
  slabs: readonly TaxSlab[],
): number {
  if (nights <= 0) throw new Error('A stay must cover at least one night.');

  // An exempt stay has no slab to be consistent with: the gross *is* the net,
  // so the division is the plain one and always lands exactly.
  if (isTaxExempt) return Math.round(targetTotalMinor / nights);

  return solveUnitNetForGross(targetTotalMinor, nights, slabs);
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
          input.taxSlabs,
        );

  const isOverridden =
    input.overrideNightlyRateMinor !== undefined || solved !== undefined;
  const nightlyRateMinor =
    solved ?? input.overrideNightlyRateMinor ?? input.baseNightlyRateMinor;

  /**
   * The slab, resolved once for the stay.
   *
   * An exempt stay resolves no slab at all rather than resolving one and
   * multiplying by zero: the two are indistinguishable in the total and very
   * distinguishable on an invoice, which must show no GST line rather than a
   * 0% GST line against a slab the guest was never in.
   */
  const components = input.isTaxExempt
    ? null
    : componentsFor(nightlyRateMinor, input.taxSlabs);
  const taxRatePercent = components?.taxRatePercent ?? 0;

  const nightly: NightlyLine[] = stayDates(input.arrivalDate, input.departureDate).map(
    (stayDate) => ({
      stayDate: stayDate as NightlyLine['stayDate'],
      nightlyRateMinor,
      // Rounded here, per night, exactly once.
      taxMinor: taxOnNight(nightlyRateMinor, taxRatePercent),
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
    // The CGST/SGST split, so an invoice prints the components the slab
    // configured rather than halving the total and hoping.
    taxComponents: components,
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
