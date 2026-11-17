/**
 * Extra-guest pricing: separate adult and child allowances, per-guest
 * rounding, infants free and uncounted, refusals returned rather than thrown.
 */

import { describe, expect, it } from 'vitest';

import {
  extraGuestUnitCharge,
  resolveOccupancyPricing,
  type OccupancyPricingInput,
} from './occupancy-pricing.policy.js';

const input = (
  overrides: Partial<OccupancyPricingInput> = {},
  guests: Partial<OccupancyPricingInput['guests']> = {},
): OccupancyPricingInput => ({
  baseRateMinor: 400_000,
  currency: 'INR',
  config: {
    baseOccupancy: 2,
    includedChildren: 1,
    enabled: true,
    adult: { kind: 'FIXED', value: 100_000 }, // Rs 1,000 per extra adult
    child: { kind: 'PERCENT', value: 2_500 }, // 25% of the base per extra child
  },
  capacity: { maxGuests: 5, maxAdults: 4 },
  ...overrides,
  guests: { adults: 2, children: 0, infants: 0, ...guests },
});

const codes = (result: ReturnType<typeof resolveOccupancyPricing>) =>
  result.refusals.map((r) => r.code);

describe('extraGuestUnitCharge', () => {
  it('FIXED ignores the base rate', () => {
    expect(extraGuestUnitCharge({ kind: 'FIXED', value: 50_000 }, 1)).toBe(50_000);
    expect(extraGuestUnitCharge({ kind: 'FIXED', value: 50_000 }, 9_999_999)).toBe(50_000);
  });

  it('PERCENT is basis points of the base, rounded half-up once', () => {
    expect(extraGuestUnitCharge({ kind: 'PERCENT', value: 2_500 }, 400_000)).toBe(100_000);
    // 10,000 x 33.33% = 3,333.0 exactly; 10,001 x 33.33% = 3,333.333 -> 3,333.
    expect(extraGuestUnitCharge({ kind: 'PERCENT', value: 3_333 }, 10_001)).toBe(3_333);
    // 3 x 50% = 1.5 -> 2.
    expect(extraGuestUnitCharge({ kind: 'PERCENT', value: 5_000 }, 3)).toBe(2);
  });
});

describe('resolveOccupancyPricing', () => {
  it('within both allowances (1 adult + 1 child): no extra charge', () => {
    const r = resolveOccupancyPricing(input({}, { adults: 1, children: 1 }));
    expect(r.totalExtraChargeMinor).toBe(0);
    expect(r.effectiveNightlyRateMinor).toBe(400_000);
    expect(r.refusals).toEqual([]);
  });

  it('base 2 with one child included means one adult included', () => {
    const r = resolveOccupancyPricing(input({}, { adults: 3, children: 1 }));
    // Included: 1 adult + 1 child. Extra: 2 adults x 1,000 = 2,000; 0 children.
    expect([r.includedAdultCount, r.includedChildCount]).toEqual([1, 1]);
    expect([r.extraAdultCount, r.extraChildCount]).toEqual([2, 0]);
    expect(r.adultExtraChargeMinor).toBe(200_000);
    expect(r.effectiveNightlyRateMinor).toBe(600_000);
  });

  it('allowances are not pooled: spare child allowance does not absorb an adult', () => {
    const r = resolveOccupancyPricing(input({}, { adults: 2, children: 0 }));
    // Two guests, base occupancy two, but only one adult is included.
    expect(r.extraAdultCount).toBe(1);
    expect(r.totalExtraChargeMinor).toBe(100_000);
  });

  it('charges each extra child the same rounded amount, then multiplies', () => {
    const r = resolveOccupancyPricing(input({}, { adults: 1, children: 3 }));
    // 1 child included; 2 extra at 25% of 4,000 = 1,000 each.
    expect([r.extraChildCount, r.childUnitChargeMinor, r.childExtraChargeMinor]).toEqual([
      2, 100_000, 200_000,
    ]);
  });

  it('infants are free and do not count toward capacity', () => {
    const r = resolveOccupancyPricing(
      input(
        { capacity: { maxGuests: 2, maxAdults: null } },
        { adults: 1, children: 1, infants: 3 },
      ),
    );
    expect(r.refusals).toEqual([]);
    expect(r.infantCount).toBe(3);
    expect(r.totalExtraChargeMinor).toBe(0);
  });

  it('a disabled configuration prices exactly the base', () => {
    const base = input();
    const r = resolveOccupancyPricing({
      ...base,
      config: { ...base.config, enabled: false },
      guests: { adults: 4, children: 1, infants: 0 },
    });
    expect(r.totalExtraChargeMinor).toBe(0);
    expect(r.effectiveNightlyRateMinor).toBe(400_000);
  });

  it('returns every refusal at once instead of throwing', () => {
    const r = resolveOccupancyPricing(
      input({ capacity: { maxGuests: 3, maxAdults: 2 } }, { adults: 0, children: 4, infants: -1 }),
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining(['ADULTS_BELOW_ONE', 'NEGATIVE_COUNT', 'EXCEEDS_MAX_GUESTS']),
    );
  });

  it('refuses more adults than the adult limit, and fractional counts', () => {
    expect(codes(resolveOccupancyPricing(input({}, { adults: 5 })))).toContain(
      'EXCEEDS_MAX_ADULTS',
    );
    expect(codes(resolveOccupancyPricing(input({}, { adults: 1.5 })))).toContain(
      'NON_INTEGER_COUNT',
    );
  });

  it('refuses an incoherent configuration', () => {
    const base = input();
    const r = resolveOccupancyPricing({
      ...base,
      config: {
        ...base.config,
        baseOccupancy: 6,
        includedChildren: 7,
        adult: { kind: 'PERCENT', value: 100_001 },
      },
    });
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        'INCLUDED_CHILDREN_EXCEED_BASE',
        'BASE_OCCUPANCY_EXCEEDS_CAPACITY',
        'AMOUNT_OUT_OF_RANGE',
      ]),
    );
  });

  it('refuses a nightly total past the plausible range rather than returning it', () => {
    const base = input();
    const r = resolveOccupancyPricing({
      ...base,
      baseRateMinor: 1_999_999_999,
      config: { ...base.config, adult: { kind: 'FIXED', value: 2_000_000_000 } },
      guests: { adults: 4, children: 0, infants: 0 },
    });
    expect(codes(r)).toContain('TOTAL_OUT_OF_RANGE');
  });

  it('every money field is an integer', () => {
    const r = resolveOccupancyPricing(
      input({ baseRateMinor: 333_333 }, { adults: 4, children: 1 }),
    );
    for (const value of [
      r.adultExtraChargeMinor,
      r.childExtraChargeMinor,
      r.totalExtraChargeMinor,
      r.effectiveNightlyRateMinor,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(r.effectiveNightlyRateMinor).toBe(r.baseRateMinor + r.totalExtraChargeMinor);
  });
});
