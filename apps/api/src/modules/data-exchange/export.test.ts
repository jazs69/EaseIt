/** IE-02: money formatting and rate-run collapsing, without a database. */

import { describe, expect, it } from 'vitest';
import { fromMajorUnitString } from '@repo/types';

import { collapseRuns, formatMajor } from './export-format.js';

describe('formatMajor', () => {
  it('renders minor units exactly, by currency exponent, and round-trips through the import parser', () => {
    const cases: [number, string, string][] = [
      [350000, 'INR', '3500.00'],
      [5, 'INR', '0.05'],
      [-118000, 'INR', '-1180.00'],
      [0, 'INR', '0.00'],
      [1500, 'JPY', '1500'],
      [2_000_000_000, 'INR', '20000000.00'],
    ];
    for (const [minor, currency, text] of cases) {
      expect(formatMajor(minor, currency)).toBe(text);
      expect(fromMajorUnitString(text, currency).amountMinor).toBe(minor);
    }
  });
});

describe('collapseRuns', () => {
  const day = (planCode: string, typeCode: string, d: string, amount: number) => ({
    planCode,
    typeCode,
    day: d,
    amount,
    currency: 'INR',
  });

  it('merges consecutive nights at one price, and breaks on a gap, a price or a category change', () => {
    const runs = collapseRuns([
      day('BAR', 'DLX', '2026-12-01', 500000),
      day('BAR', 'DLX', '2026-12-02', 500000),
      day('BAR', 'DLX', '2026-12-03', 550000),
      day('BAR', 'DLX', '2026-12-05', 550000),
      day('BAR', 'STE', '2026-12-06', 550000),
    ]);
    expect(runs.map((r) => [r.typeCode, r.from, r.to, r.amount])).toEqual([
      ['DLX', '2026-12-01', '2026-12-02', 500000],
      ['DLX', '2026-12-03', '2026-12-03', 550000],
      ['DLX', '2026-12-05', '2026-12-05', 550000],
      ['STE', '2026-12-06', '2026-12-06', 550000],
    ]);
  });

  it('crosses a month and a year end', () => {
    const runs = collapseRuns([
      day('BAR', 'DLX', '2026-12-31', 1),
      day('BAR', 'DLX', '2027-01-01', 1),
      day('BAR', 'DLX', '2027-01-02', 1),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ from: '2026-12-31', to: '2027-01-02' });
  });
});
