/**
 * Money: integer minor units, explicit rounding, lossless allocation
 * (CLAUDE.md section 3.4). Every expected figure below is worked by hand in
 * the comment beside it, not copied from the implementation's output.
 */

import { describe, expect, it } from 'vitest';

import {
  add,
  allocate,
  allocateByWeights,
  compare,
  format,
  fromMajorUnitString,
  money,
  MoneyError,
  multiply,
  percentage,
  RoundingMode,
  subtract,
  sum,
  toMajorUnitNumber,
  type Money,
} from './money.js';

const inr = (amountMinor: number): Money => money(amountMinor, 'INR');
const amounts = (list: readonly Money[]): number[] => list.map((m) => m.amountMinor);
const total = (list: readonly Money[]): number => list.reduce((s, m) => s + m.amountMinor, 0);

describe('money()', () => {
  it('accepts an integer in a supported currency', () => {
    expect(inr(150_050)).toEqual({ amountMinor: 150_050, currency: 'INR' });
  });

  it('refuses a fractional amount: a float leaked into a price', () => {
    expect(() => inr(10.5)).toThrow(MoneyError);
  });

  it('refuses an amount past the safe integer range', () => {
    expect(() => inr(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
  });

  it('refuses a currency with no known minor-unit exponent rather than assuming 2', () => {
    expect(() => money(100, 'XYZ')).toThrow(/Unsupported currency/);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts and sums in one currency', () => {
    expect(add(inr(100), inr(250)).amountMinor).toBe(350);
    expect(subtract(inr(100), inr(250)).amountMinor).toBe(-150);
    expect(sum([inr(1), inr(2), inr(3)], 'INR').amountMinor).toBe(6);
    expect(sum([], 'INR').amountMinor).toBe(0);
  });

  it('refuses to mix currencies, in every operation that combines two amounts', () => {
    const usd = money(100, 'USD');
    expect(() => add(inr(100), usd)).toThrow(/Cannot combine INR with USD/);
    expect(() => subtract(inr(100), usd)).toThrow(MoneyError);
    expect(() => compare(inr(100), usd)).toThrow(MoneyError);
    expect(() => sum([usd], 'INR')).toThrow(MoneyError);
  });
});

describe('rounding: multiply() rounds exactly once, by the stated mode', () => {
  // 5 x 0.5 = 2.5 and 3 x 0.5 = 1.5 are exact ties in binary, so each mode's
  // tie rule is what decides them.
  it.each([
    [RoundingMode.HALF_UP, 5, 3],
    [RoundingMode.HALF_UP, -5, -3], // away from zero on both sides
    [RoundingMode.HALF_EVEN, 5, 2], // 2.5 -> 2 (even)
    [RoundingMode.HALF_EVEN, 3, 2], // 1.5 -> 2 (even)
    [RoundingMode.HALF_EVEN, -5, -2], // -2.5 -> -2 (even)
    [RoundingMode.DOWN, 5, 2], // toward zero
    [RoundingMode.DOWN, -5, -2],
    [RoundingMode.UP, 5, 3], // away from zero
    [RoundingMode.UP, -5, -3],
  ])('%s: %i x 0.5 -> %i', (mode, amount, expected) => {
    expect(multiply(inr(amount), 0.5, mode).amountMinor).toBe(expected);
  });

  it('defaults to HALF_UP, the property default', () => {
    expect(multiply(inr(5), 0.5).amountMinor).toBe(3);
  });

  it('does not round values that are not ties toward the tie rule', () => {
    // 7 x 0.3 = 2.1 -> 2 under every nearest mode; UP still goes to 3.
    expect(multiply(inr(7), 0.3, RoundingMode.HALF_UP).amountMinor).toBe(2);
    expect(multiply(inr(7), 0.3, RoundingMode.HALF_EVEN).amountMinor).toBe(2);
    expect(multiply(inr(7), 0.3, RoundingMode.UP).amountMinor).toBe(3);
  });

  it('refuses a non-finite rate', () => {
    expect(() => multiply(inr(100), Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => multiply(inr(100), Number.NaN)).toThrow(MoneyError);
  });

  it('percentage(): 18% GST on Rs 1,000.00 is Rs 180.00; 5% of 333 paise is 16.65 -> 17', () => {
    expect(percentage(inr(100_000), 18).amountMinor).toBe(18_000);
    expect(percentage(inr(333), 5).amountMinor).toBe(17);
  });

  it('always returns an integer, whatever the rate', () => {
    for (const rate of [0.05, 0.18, 1 / 3, 2 / 7, 1.125]) {
      expect(Number.isInteger(multiply(inr(123_457), rate).amountMinor)).toBe(true);
    }
  });
});

describe('allocate(): split without losing or inventing a paisa', () => {
  it('Rs 10.00 in three is 3.34 + 3.33 + 3.33', () => {
    expect(amounts(allocate(inr(1_000), 3))).toEqual([334, 333, 333]);
  });

  it('a refund (negative) splits symmetrically', () => {
    expect(amounts(allocate(inr(-1_000), 3))).toEqual([-334, -333, -333]);
  });

  it('an exact division has no remainder to place', () => {
    expect(amounts(allocate(inr(900), 3))).toEqual([300, 300, 300]);
  });

  it('re-sums to the original and never differs by more than one unit, for every case', () => {
    for (let amount = -1_003; amount <= 1_003; amount += 17) {
      for (let parts = 1; parts <= 9; parts += 1) {
        const split = amounts(allocate(inr(amount), parts));
        expect(split).toHaveLength(parts);
        expect(split.reduce((s, v) => s + v, 0)).toBe(amount);
        expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses zero, negative or fractional part counts', () => {
    expect(() => allocate(inr(100), 0)).toThrow(MoneyError);
    expect(() => allocate(inr(100), -2)).toThrow(MoneyError);
    expect(() => allocate(inr(100), 1.5)).toThrow(MoneyError);
  });
});

describe('allocateByWeights()', () => {
  it('splits in proportion and the last part absorbs the remainder', () => {
    // 1000 x 1/3 = 333.33 -> 333 (truncated); the last part takes 1000 - 333 = 667.
    expect(amounts(allocateByWeights(inr(1_000), [1, 2]))).toEqual([333, 667]);
    // Per-night rates driving a prorated discount: 3000 and 5000 of 8000.
    expect(amounts(allocateByWeights(inr(800), [3_000, 5_000]))).toEqual([300, 500]);
  });

  it('re-sums exactly for awkward weights', () => {
    const split = allocateByWeights(inr(100_001), [1, 1, 1, 7, 13]);
    expect(total(split)).toBe(100_001);
  });

  it('all-zero weights fall back to an even split', () => {
    expect(amounts(allocateByWeights(inr(10), [0, 0, 0]))).toEqual([4, 3, 3]);
  });

  it('refuses an empty list and negative or non-finite weights', () => {
    expect(() => allocateByWeights(inr(10), [])).toThrow(MoneyError);
    expect(() => allocateByWeights(inr(10), [1, -1])).toThrow(MoneyError);
    expect(() => allocateByWeights(inr(10), [1, Number.NaN])).toThrow(MoneyError);
  });
});

describe('the UI boundary: parsing and display', () => {
  it.each([
    ['1500.50', 'INR', 150_050],
    ['1,500.5', 'INR', 150_050],
    [' 1500 ', 'INR', 150_000],
    ['-12.30', 'INR', -1_230],
    ['0.05', 'INR', 5],
    ['1500', 'JPY', 1_500], // zero-decimal currency: no scaling by 100
  ])('"%s" %s -> %i minor units', (value, currency, expected) => {
    expect(fromMajorUnitString(value, currency).amountMinor).toBe(expected);
  });

  it('refuses more decimals than the currency has, instead of rounding silently', () => {
    expect(() => fromMajorUnitString('1.234', 'INR')).toThrow(/2 decimal place/);
    expect(() => fromMajorUnitString('15.5', 'JPY')).toThrow(/0 decimal place/);
  });

  it('refuses anything that is not a number', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', '--1']) {
      expect(() => fromMajorUnitString(bad, 'INR')).toThrow(MoneyError);
    }
  });

  it('converts to major units only for display', () => {
    expect(toMajorUnitNumber(inr(150_050))).toBe(1500.5);
    expect(toMajorUnitNumber(money(1_500, 'JPY'))).toBe(1500);
    expect(format(inr(150_050))).toContain('1,500.50');
  });
});
