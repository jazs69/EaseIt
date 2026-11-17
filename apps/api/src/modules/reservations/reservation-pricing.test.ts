/**
 * Stay pricing: per-night bands, per-night rounding, totals that are sums of
 * the rounded lines, and the precedence override > target > plan > rack.
 */

import type { TaxSlab } from '@repo/types';
import { describe, expect, it } from 'vitest';

import {
  nightsBetween,
  quoteStay,
  solveNightlyRateForTotal,
  stayDates,
  type PlannedNight,
  type QuoteInput,
} from './reservation-pricing.js';

const base: QuoteInput = {
  arrivalDate: '2026-12-01',
  departureDate: '2026-12-03',
  baseNightlyRateMinor: 300_000, // Rs 3,000: the 5% band
  isTaxExempt: false,
  currency: 'INR',
  taxSlabs: [], // statutory default
};

const night = (
  stayDate: string,
  rateMinor: number,
  extra: Partial<PlannedNight> = {},
): PlannedNight => ({
  stayDate,
  rateMinor,
  source: 'DEFAULT',
  extraGuestMinor: 0,
  discountMinor: 0,
  ...extra,
});

const plan = (
  nights: PlannedNight[],
  promotion: NonNullable<QuoteInput['plan']>['promotion'] = null,
) => ({
  ratePlanId: 'rp-1',
  ratePlanCode: 'BAR',
  nights,
  promotion,
});

/** The guarantee the guest sees: the day-wise split adds up to the total. */
function expectLinesAddUp(quote: ReturnType<typeof quoteStay>): void {
  const net = quote.nightly.reduce((s, l) => s + l.nightlyRateMinor, 0);
  const tax = quote.nightly.reduce((s, l) => s + l.taxMinor, 0);
  expect(quote.exTaxMinor).toBe(net);
  expect(quote.taxMinor).toBe(tax);
  expect(quote.totalMinor).toBe(net + tax);
  for (const line of quote.nightly) expect(Number.isInteger(line.taxMinor)).toBe(true);
}

describe('stay dates', () => {
  it('counts half-open nights and lists them', () => {
    expect(nightsBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(stayDates('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ]);
    expect(stayDates('2026-12-01', '2026-12-01')).toEqual([]);
  });
});

describe('quoteStay', () => {
  it('rack rate: two nights at Rs 3,000 + 5% = Rs 6,300', () => {
    const quote = quoteStay(base);
    expect(quote.nights).toBe(2);
    expect(
      quote.nightly.map((l) => [l.stayDate, l.nightlyRateMinor, l.taxMinor, l.rateSource]),
    ).toEqual([
      ['2026-12-01', 300_000, 15_000, 'RACK'],
      ['2026-12-02', 300_000, 15_000, 'RACK'],
    ]);
    expect(quote.totalMinor).toBe(630_000);
    expect(quote.taxRatePercent).toBe(5);
    expect(quote.taxComponents).toEqual(
      expect.objectContaining({ cgstRatePercent: 2.5, sgstRatePercent: 2.5 }),
    );
    expect(quote.isOverridden).toBe(false);
    expect(quote.targetAdjustment).toBeNull();
    expectLinesAddUp(quote);
  });

  it('bands each night on its own tariff: a stay can straddle 5% and 18%', () => {
    const quote = quoteStay({
      ...base,
      plan: plan([
        night('2026-12-01', 700_000, { source: 'WEEKDAY' }),
        night('2026-12-02', 800_000, { source: 'WEEKEND' }),
      ]),
    });
    expect(quote.nightly.map((l) => [l.taxRatePercent, l.taxMinor])).toEqual([
      [5, 35_000],
      [18, 144_000],
    ]);
    expect(quote.isRateVarying).toBe(true);
    expect(quote.taxMinor).toBe(179_000);
    // The headline rate and band are the arrival night's.
    expect(quote.nightlyRateMinor).toBe(700_000);
    expect(quote.taxRatePercent).toBe(5);
    expectLinesAddUp(quote);
  });

  it('bands on the nightly tariff, not the stay total', () => {
    // Four nights at Rs 3,000 is Rs 12,000 in total and still a 5% room.
    const quote = quoteStay({ ...base, departureDate: '2026-12-05' });
    expect(quote.exTaxMinor).toBe(1_200_000);
    expect(quote.nightly.every((l) => l.taxRatePercent === 5)).toBe(true);
  });

  it('rounds per night, so three nights of 16.65 paise tax are 51, not 50', () => {
    const fivePercent: TaxSlab[] = [
      {
        slabName: 'flat',
        minTariffMinor: 0,
        maxTariffMinor: null,
        taxRatePercent: 5,
        cgstRatePercent: 2.5,
        sgstRatePercent: 2.5,
      },
    ];
    const quote = quoteStay({
      ...base,
      departureDate: '2026-12-04',
      baseNightlyRateMinor: 333,
      taxSlabs: fivePercent,
    });
    // Each night: 333 x 5% = 16.65 -> 17. A rounded stay total would be 999 x 5% = 49.95 -> 50.
    expect(quote.nightly.map((l) => l.taxMinor)).toEqual([17, 17, 17]);
    expect(quote.taxMinor).toBe(51);
    expectLinesAddUp(quote);
  });

  it('a tax-exempt stay resolves no slab at all: no GST line, not a 0% one', () => {
    const quote = quoteStay({ ...base, isTaxExempt: true });
    expect(quote.taxMinor).toBe(0);
    expect(quote.taxComponents).toBeNull();
    expect(quote.totalMinor).toBe(600_000);
  });

  it('a manual price wins over the plan for every night', () => {
    const quote = quoteStay({
      ...base,
      overrideNightlyRateMinor: 250_000,
      plan: plan([night('2026-12-01', 700_000), night('2026-12-02', 800_000)]),
    });
    expect(quote.nightly.map((l) => [l.nightlyRateMinor, l.rateSource])).toEqual([
      [250_000, 'MANUAL'],
      [250_000, 'MANUAL'],
    ]);
    expect(quote.isOverridden).toBe(true);
    expect(quote.ratePlanId).toBeNull(); // the plan did not price this stay
  });

  it('a reachable target total is hit exactly', () => {
    const quote = quoteStay({ ...base, departureDate: '2026-12-02', targetTotalMinor: 1_000_000 });
    expect(quote.totalMinor).toBe(1_000_000);
    expect(quote.taxRatePercent).toBe(18); // the self-consistent slab
    expect(quote.targetAdjustment).toBeNull();
  });

  it('an unreachable target total is reported, never silently replaced', () => {
    const quote = quoteStay({ ...base, departureDate: '2026-12-02', targetTotalMinor: 800_000 });
    expect(quote.targetAdjustment).toEqual({
      requestedTotalMinor: 800_000,
      achievedTotalMinor: 787_499,
    });
    expect(quote.totalMinor).toBe(787_499);
  });

  it('carries plan extras and the promotion discount total through', () => {
    const quote = quoteStay({
      ...base,
      plan: plan(
        [
          night('2026-12-01', 320_000, { extraGuestMinor: 50_000, discountMinor: 30_000 }),
          night('2026-12-02', 320_000, { extraGuestMinor: 50_000, discountMinor: 30_000 }),
        ],
        { promotionId: 'p1', promotionName: 'Winter', promoCodeId: null },
      ),
    });
    expect(quote.extraGuestTotalMinor).toBe(100_000);
    expect(quote.promotion).toEqual({
      promotionId: 'p1',
      promotionName: 'Winter',
      promoCodeId: null,
      discountTotalMinor: 60_000,
    });
    expect(quote.ratePlanCode).toBe('BAR');
  });

  it('refuses a plan whose nights are not exactly this stay', () => {
    expect(() => quoteStay({ ...base, plan: plan([night('2026-12-01', 1)]) })).toThrow(
      /do not match/,
    );
    expect(() =>
      quoteStay({ ...base, plan: plan([night('2026-12-02', 1), night('2026-12-01', 1)]) }),
    ).toThrow(/do not match/);
  });

  it('refuses a stay of no nights', () => {
    expect(() => quoteStay({ ...base, departureDate: base.arrivalDate })).toThrow(
      /at least one night/,
    );
  });
});

describe('solveNightlyRateForTotal', () => {
  it('an exempt stay divides plainly', () => {
    expect(solveNightlyRateForTotal(900_000, 3, true, [])).toBe(300_000);
  });

  it('a taxed stay solves through the slab table', () => {
    expect(solveNightlyRateForTotal(630_000, 2, false, [])).toBe(300_000);
  });

  it('refuses zero nights', () => {
    expect(() => solveNightlyRateForTotal(100, 0, false, [])).toThrow();
  });
});
