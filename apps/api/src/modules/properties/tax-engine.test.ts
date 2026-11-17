/**
 * Banded GST: band by the nightly tariff, half-open bands, rounded once per
 * night, and a reverse solve that only accepts a self-consistent slab.
 */

import type { TaxSlab } from '@repo/types';
import { describe, expect, it } from 'vitest';

import {
  componentsFor,
  inclusiveRatePercentFor,
  resolveTaxSlab,
  solveUnitNetForGross,
  STATUTORY_ROOM_TARIFF_SLABS,
  TaxSlabGapError,
  taxOnNight,
  taxPercentFor,
  validateSlabTable,
} from './tax-engine.js';

const slab = (
  slabName: string,
  minTariffMinor: number,
  maxTariffMinor: number | null,
  taxRatePercent: number,
): TaxSlab => ({
  slabName,
  minTariffMinor,
  maxTariffMinor,
  taxRatePercent,
  cgstRatePercent: taxRatePercent / 2,
  sgstRatePercent: taxRatePercent / 2,
});

/** Gross for one unit priced forward: net + its rounded tax. */
const grossOf = (net: number, slabs: readonly TaxSlab[]): number =>
  net + taxOnNight(net, taxPercentFor(net, slabs));

describe('resolveTaxSlab: bands are [min, max)', () => {
  // Statutory since 22 Sep 2025: 0% to Rs 1,000; 5% to Rs 7,500; 18% above.
  it.each([
    [0, 0],
    [99_999, 0], // Rs 999.99
    [100_000, 5], // Rs 1,000.00 sits on the boundary: the slab whose FLOOR it is
    [749_999, 5],
    [750_000, 18], // Rs 7,500.00: the premium slab, not the standard one
    [5_000_000, 18], // open-ended top band
  ])('a nightly tariff of %i paise is taxed at %i%%', (tariff, rate) => {
    expect(taxPercentFor(tariff, STATUTORY_ROOM_TARIFF_SLABS)).toBe(rate);
  });

  it('returns null for a tariff in a gap of a populated table, rather than 0%', () => {
    const gappy = [slab('low', 0, 100_000, 0), slab('high', 200_000, null, 18)];
    expect(resolveTaxSlab(150_000, gappy)).toBeNull();
  });
});

describe('componentsFor', () => {
  it('reads the CGST/SGST split from the slab instead of halving the rate', () => {
    const uneven: TaxSlab[] = [
      {
        slabName: 'x',
        minTariffMinor: 0,
        maxTariffMinor: null,
        taxRatePercent: 12,
        cgstRatePercent: 7,
        sgstRatePercent: 5,
      },
    ];
    expect(componentsFor(500_000, uneven)).toEqual({
      slabName: 'x',
      taxRatePercent: 12,
      cgstRatePercent: 7,
      sgstRatePercent: 5,
    });
  });

  it('falls back to the statutory table when none is configured', () => {
    expect(componentsFor(300_000, []).taxRatePercent).toBe(5);
  });

  it('throws a typed gap error naming the bands, instead of quoting 0%', () => {
    const gappy = [slab('low', 0, 100_000, 0), slab('high', 200_000, null, 18)];
    expect(() => componentsFor(150_000, gappy)).toThrow(TaxSlabGapError);
    try {
      componentsFor(150_000, gappy);
    } catch (error) {
      expect(error).toBeInstanceOf(TaxSlabGapError);
      expect((error as TaxSlabGapError).bands).toEqual(['0-100000', '200000-open']);
    }
  });
});

describe('taxOnNight: rounded once, half-up', () => {
  it.each([
    [300_000, 5, 15_000], // Rs 3,000 at 5% = Rs 150 exactly
    [333, 5, 17], // 16.65 -> 17
    [10, 5, 1], // 0.5 -> 1 (half-up)
    [9, 5, 0], // 0.45 -> 0
    [847_458, 18, 152_542], // 152,542.44 -> 152,542
    [100_000, 0, 0],
  ])('%i at %i%% = %i', (net, rate, tax) => {
    expect(taxOnNight(net, rate)).toBe(tax);
  });
});

describe('solveUnitNetForGross: only a self-consistent slab is accepted', () => {
  it('Rs 10,000 gross for one night is 18% inclusive, not 5%', () => {
    // The naive 10,000 / 1.05 = 9,523.81 sits in the 18% band, contradicting
    // its own premise. 10,000 / 1.18 = 8,474.58 -> 847,458 is consistent.
    const net = solveUnitNetForGross(1_000_000, 1, []);
    expect(net).toBe(847_458);
    expect(taxPercentFor(net, STATUTORY_ROOM_TARIFF_SLABS)).toBe(18);
    expect(grossOf(net, STATUTORY_ROOM_TARIFF_SLABS)).toBe(1_000_000);
  });

  it('solves per unit: Rs 6,300 over two nights is Rs 3,000 a night at 5%', () => {
    expect(solveUnitNetForGross(630_000, 2, [])).toBe(300_000);
  });

  it('an unreachable gross lands on the nearest achievable figure, inside a real band', () => {
    // Between 787,499 (749,999 at 5%) and 885,000 (750,000 at 18%) no net
    // produces the gross. 800,000 is nearer the 5% ceiling.
    const net = solveUnitNetForGross(800_000, 1, []);
    expect(net).toBe(749_999);
    expect(grossOf(net, STATUTORY_ROOM_TARIFF_SLABS)).toBe(787_499);
  });

  it('round-trips: pricing forward from the solved net gives the gross back, when reachable', () => {
    for (const net of [50_000, 100_000, 250_000, 749_999, 750_000, 1_234_567]) {
      const gross = grossOf(net, STATUTORY_ROOM_TARIFF_SLABS);
      const solved = solveUnitNetForGross(gross, 1, []);
      expect(grossOf(solved, STATUTORY_ROOM_TARIFF_SLABS)).toBe(gross);
    }
  });

  it('refuses zero units', () => {
    expect(() => solveUnitNetForGross(100, 0, [])).toThrow();
  });

  it('inclusiveRatePercentFor resolves the rate from the implied net, not the gross', () => {
    expect(inclusiveRatePercentFor(1_000_000, 1, [])).toBe(18);
    // Rs 7,800 gross: 7,800 / 1.05 = 7,428.57 -> 5%, although the gross is above 7,500.
    expect(inclusiveRatePercentFor(780_000, 1, [])).toBe(5);
    expect(inclusiveRatePercentFor(0, 1, [])).toBe(0);
  });
});

describe('validateSlabTable: properties of the whole table', () => {
  it('accepts the statutory table and an empty (unconfigured) one', () => {
    expect(validateSlabTable(STATUTORY_ROOM_TARIFF_SLABS)).toEqual([]);
    expect(validateSlabTable([])).toEqual([]);
  });

  it('accepts slabs in any order', () => {
    expect(validateSlabTable([...STATUTORY_ROOM_TARIFF_SLABS].reverse())).toEqual([]);
  });

  it('reports a floor above zero', () => {
    expect(validateSlabTable([slab('a', 100, null, 5)])).toEqual([
      expect.stringContaining('must start at 0'),
    ]);
  });

  it('reports no open-ended slab, and more than one', () => {
    expect(validateSlabTable([slab('a', 0, 100, 5)])).toEqual([
      expect.stringContaining('must be open-ended'),
    ]);
    expect(validateSlabTable([slab('a', 0, null, 5), slab('b', 100, null, 18)])).toEqual(
      expect.arrayContaining([expect.stringContaining('Only one slab')]),
    );
  });

  it('reports an overlap and a gap, every problem at once', () => {
    const problems = validateSlabTable([
      slab('a', 0, 200, 0),
      slab('b', 100, 300, 5), // overlaps a
      slab('c', 400, null, 18), // gap after b
    ]);
    expect(problems).toEqual(['"a" overlaps "b".', 'A gap sits between "b" and "c".']);
  });
});
