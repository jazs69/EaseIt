/**
 * Promotions: every night must qualify, all reasons are reported, codes gate
 * properly, a tie applies nothing, and discounts round per night and clamp.
 */

import { describe, expect, it } from 'vitest';

import {
  computeDiscount,
  evaluateEligibility,
  normalizePromoCode,
  selectPromotion,
  type EligibilityContext,
  type PromotionCandidate,
} from './promotion.policy.js';

const promo = (overrides: Partial<PromotionCandidate> = {}): PromotionCandidate => ({
  id: 'p1',
  name: 'Winter',
  discountKind: 'PERCENT',
  discountValue: 1_000,
  priority: 1,
  isActive: true,
  stayFromDate: null,
  stayThroughDate: null,
  bookFromDate: null,
  bookThroughDate: null,
  minNights: null,
  maxNights: null,
  minEligibleAmountMinor: null,
  appliesToAllRatePlans: true,
  appliesToAllRoomTypes: true,
  ratePlanIds: [],
  roomTypeIds: [],
  maxRedemptions: null,
  redeemedCount: 0,
  codes: [],
  ...overrides,
});

const context = (overrides: Partial<EligibilityContext> = {}): EligibilityContext => ({
  bookingDate: '2026-11-17',
  ratePlanId: 'rp-1',
  roomTypeId: 'rt-1',
  stayDates: ['2026-12-20', '2026-12-21', '2026-12-22'],
  stayEligibleAmountMinor: 900_000,
  promoCodeNormalized: null,
  ...overrides,
});

const reasons = (p: PromotionCandidate, c: EligibilityContext) =>
  evaluateEligibility(p, c).reasons.map((r) => r.code);

const code = (
  codeNormalized: string,
  overrides: Partial<PromotionCandidate['codes'][number]> = {},
) => ({
  id: `c-${codeNormalized}`,
  codeNormalized,
  isActive: true,
  expiresOn: null,
  maxRedemptions: null,
  redeemedCount: 0,
  ...overrides,
});

describe('computeDiscount', () => {
  it.each([
    [300_000, 'PERCENT', 1_000, 30_000], // 10% of Rs 3,000
    [333, 'PERCENT', 1_000, 33], // 33.3 -> 33
    [335, 'PERCENT', 1_000, 34], // 33.5 -> 34 (half-up)
    [300_000, 'FIXED_PER_NIGHT', 50_000, 50_000],
    [300_000, 'FIXED_PER_NIGHT', 500_000, 300_000], // clamped: a night never goes below zero
    [300_000, 'PERCENT', 10_000, 300_000], // 100%
    [0, 'PERCENT', 1_000, 0],
    [-5, 'FIXED_PER_NIGHT', 100, 0],
  ] as const)('%i, %s %i -> %i', (amount, kind, value, expected) => {
    expect(computeDiscount(amount, kind, value)).toBe(expected);
  });

  it('per night: 33.33% of three Rs 1.00 nights is 99 paise, not Rs 1.00', () => {
    const perNight = [100, 100, 100].map((n) => computeDiscount(n, 'PERCENT', 3_333));
    expect(perNight).toEqual([33, 33, 33]);
  });
});

describe('evaluateEligibility', () => {
  it('a plain active promotion applies', () => {
    expect(evaluateEligibility(promo(), context())).toEqual(
      expect.objectContaining({ eligible: true, reasons: [], matchedCodeId: null }),
    );
  });

  it('EVERY night must be inside the stay window, not just one', () => {
    const p = promo({ stayFromDate: '2026-12-21', stayThroughDate: '2026-12-31' });
    expect(reasons(p, context())).toEqual(['OUTSIDE_STAY_WINDOW']);
    expect(reasons(p, context({ stayDates: ['2026-12-21', '2026-12-22'] }))).toEqual([]);
  });

  it('windows are inclusive at both ends', () => {
    const p = promo({ bookFromDate: '2026-11-17', bookThroughDate: '2026-11-17' });
    expect(reasons(p, context())).toEqual([]);
    expect(reasons(p, context({ bookingDate: '2026-11-18' }))).toEqual(['OUTSIDE_BOOKING_WINDOW']);
  });

  it('reports every failing condition at once', () => {
    const p = promo({
      isActive: false,
      minNights: 4,
      minEligibleAmountMinor: 1_000_000,
      appliesToAllRatePlans: false,
      ratePlanIds: ['other'],
    });
    expect(reasons(p, context())).toEqual([
      'INACTIVE',
      'RATE_PLAN_NOT_APPLICABLE',
      'BELOW_MIN_NIGHTS',
      'BELOW_MIN_AMOUNT',
    ]);
  });

  it('an empty applicability list with "all" off applies to nothing', () => {
    expect(reasons(promo({ appliesToAllRoomTypes: false }), context())).toEqual([
      'APPLIES_TO_NOTHING',
    ]);
  });

  it('a promotion with codes requires one; the right one matches', () => {
    const p = promo({ codes: [code('XMAS')] });
    expect(reasons(p, context())).toEqual(['CODE_REQUIRED']);
    expect(reasons(p, context({ promoCodeNormalized: 'OTHER' }))).toEqual(['CODE_MISMATCH']);
    expect(evaluateEligibility(p, context({ promoCodeNormalized: 'XMAS' })).matchedCodeId).toBe(
      'c-XMAS',
    );
  });

  it('deactivating the last code does not open the promotion to everyone', () => {
    const p = promo({ codes: [code('XMAS', { isActive: false })] });
    expect(reasons(p, context())).toEqual(['CODE_REQUIRED', 'CODE_INACTIVE']);
    expect(reasons(p, context({ promoCodeNormalized: 'XMAS' }))).toEqual(['CODE_INACTIVE']);
  });

  it('an expired or exhausted code is refused', () => {
    expect(
      reasons(
        promo({ codes: [code('X', { expiresOn: '2026-11-16' })] }),
        context({ promoCodeNormalized: 'X' }),
      ),
    ).toEqual(['CODE_EXPIRED']);
    expect(
      reasons(
        promo({ codes: [code('X', { maxRedemptions: 2, redeemedCount: 2 })] }),
        context({ promoCodeNormalized: 'X' }),
      ),
    ).toEqual(['CODE_EXHAUSTED']);
  });

  it('normalises codes the same way on both sides', () => {
    expect(normalizePromoCode('  xmas ')).toBe(normalizePromoCode('XMAS'));
  });
});

describe('selectPromotion', () => {
  const eligible = (id: string, priority: number, ok = true) => ({
    priority,
    eligibility: {
      promotionId: id,
      promotionName: id,
      eligible: ok,
      reasons: [],
      matchedCodeId: null,
    },
  });

  it('the highest priority eligible promotion wins, regardless of order', () => {
    expect(
      selectPromotion([eligible('a', 1), eligible('b', 5), eligible('c', 3)]).selectedPromotionId,
    ).toBe('b');
    expect(
      selectPromotion([eligible('c', 3), eligible('b', 5), eligible('a', 1)]).selectedPromotionId,
    ).toBe('b');
  });

  it('ineligible ones are ignored, even with a higher priority', () => {
    expect(selectPromotion([eligible('a', 1), eligible('b', 9, false)]).selectedPromotionId).toBe(
      'a',
    );
  });

  it('a tie applies NO discount and names both', () => {
    const s = selectPromotion([eligible('a', 5), eligible('b', 5), eligible('c', 1)]);
    expect(s.selectedPromotionId).toBeNull();
    expect(s.isAmbiguous).toBe(true);
    expect([...s.conflictingPromotionIds].sort()).toEqual(['a', 'b']);
  });

  it('nothing eligible selects nothing, unambiguously', () => {
    expect(selectPromotion([])).toEqual({
      selectedPromotionId: null,
      selectedCodeId: null,
      isAmbiguous: false,
      conflictingPromotionIds: [],
    });
  });
});
