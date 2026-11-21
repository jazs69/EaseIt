import { describe, expect, it } from 'vitest';

import { addDays, compress, datesOf, mergeChanges } from './ari-ranges.js';

const window = { from: '2026-12-01', to: '2026-12-31' };

describe('ARI change merging (the debounce)', () => {
  it('merges overlapping and touching ranges per room type', () => {
    const merged = mergeChanges(
      [
        { roomTypeId: 'A', fromDate: '2026-12-03', toDate: '2026-12-05' },
        { roomTypeId: 'A', fromDate: '2026-12-06', toDate: '2026-12-08' },
        { roomTypeId: 'A', fromDate: '2026-12-04', toDate: '2026-12-04' },
        { roomTypeId: 'A', fromDate: '2026-12-20', toDate: '2026-12-21' },
        { roomTypeId: 'B', fromDate: '2026-12-10', toDate: '2026-12-10' },
      ],
      ['A', 'B'],
      window,
    );
    expect(merged.get('A')).toEqual([
      { from: '2026-12-03', to: '2026-12-08' },
      { from: '2026-12-20', to: '2026-12-21' },
    ]);
    expect(merged.get('B')).toEqual([{ from: '2026-12-10', to: '2026-12-10' }]);
  });

  it('expands a null room type to every mapped type and null dates to the window', () => {
    const merged = mergeChanges(
      [{ roomTypeId: null, fromDate: null, toDate: null }],
      ['A', 'B'],
      window,
    );
    expect(merged.get('A')).toEqual([window]);
    expect(merged.get('B')).toEqual([window]);
  });

  it('clamps to the window, drops the past and unmapped types', () => {
    const merged = mergeChanges(
      [
        { roomTypeId: 'A', fromDate: '2026-11-20', toDate: '2026-12-02' },
        { roomTypeId: 'A', fromDate: '2026-11-01', toDate: '2026-11-05' },
        { roomTypeId: 'A', fromDate: '2026-12-30', toDate: '2027-01-15' },
        { roomTypeId: 'Z', fromDate: '2026-12-10', toDate: '2026-12-10' },
      ],
      ['A'],
      window,
    );
    expect(merged.get('A')).toEqual([
      { from: '2026-12-01', to: '2026-12-02' },
      { from: '2026-12-30', to: '2026-12-31' },
    ]);
    expect(merged.has('Z')).toBe(false);
  });
});

describe('compression', () => {
  it('turns runs of equal values into ranges', () => {
    const days = datesOf({ from: '2026-12-01', to: '2026-12-06' }).map((date, i) => ({
      date,
      value: i < 3 ? 5 : i === 3 ? 4 : 5,
    }));
    expect(compress(days, String)).toEqual([
      { from: '2026-12-01', to: '2026-12-03', value: 5 },
      { from: '2026-12-04', to: '2026-12-04', value: 4 },
      { from: '2026-12-05', to: '2026-12-06', value: 5 },
    ]);
  });

  it('never joins across a gap in dates', () => {
    expect(
      compress(
        [
          { date: '2026-12-01', value: 1 },
          { date: '2026-12-03', value: 1 },
        ],
        String,
      ),
    ).toHaveLength(2);
  });

  it('shifts calendar dates by whole UTC days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
