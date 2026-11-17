import { describe, expect, it } from 'vitest';

import { totalClosedDays, type ClosedDay } from './daily-snapshot.dto.js';

function day(overrides: Partial<ClosedDay>): ClosedDay {
  return {
    businessDate: '2026-11-01' as ClosedDay['businessDate'],
    roomsAvailable: 0,
    roomsSold: 0,
    occupancyBp: 0,
    roomRevenueMinor: 0,
    adrMinor: null,
    revparMinor: 0,
    serviceRevenueMinor: 0,
    taxMinor: 0,
    paymentsMinor: 0,
    refundsMinor: 0,
    ...overrides,
  };
}

describe('totalClosedDays', () => {
  it('derives the ratios from the sums, not by averaging the days', () => {
    // A quiet day (1 of 10 at 1000) and a full day (10 of 10 at 2000).
    // Averaging the daily ADRs would give 1500; the true ADR is 21000/11.
    const totals = totalClosedDays([
      day({ roomsAvailable: 10, roomsSold: 1, roomRevenueMinor: 1_000 }),
      day({ roomsAvailable: 10, roomsSold: 10, roomRevenueMinor: 20_000 }),
    ]);
    expect(totals.days).toBe(2);
    expect(totals.roomsSold).toBe(11);
    expect(totals.roomsAvailable).toBe(20);
    expect(totals.occupancyBp).toBe(5_500);
    expect(totals.adrMinor).toBe(Math.round(21_000 / 11));
    expect(totals.revparMinor).toBe(1_050);
  });

  it('reports no ADR when nothing was sold, and zero RevPAR on real capacity', () => {
    const totals = totalClosedDays([day({ roomsAvailable: 8 })]);
    expect(totals.adrMinor).toBeNull();
    expect(totals.revparMinor).toBe(0);
    expect(totals.occupancyBp).toBe(0);
  });

  it('is all zeros for no days', () => {
    const totals = totalClosedDays([]);
    expect(totals).toMatchObject({ days: 0, roomsAvailable: 0, occupancyBp: 0, adrMinor: null });
  });

  it('sums the money columns as integers', () => {
    const totals = totalClosedDays([
      day({ serviceRevenueMinor: 150, taxMinor: 27, paymentsMinor: 500, refundsMinor: 20 }),
      day({ serviceRevenueMinor: 50, taxMinor: 9, paymentsMinor: 100, refundsMinor: 0 }),
    ]);
    expect(totals).toMatchObject({
      serviceRevenueMinor: 200,
      taxMinor: 36,
      paymentsMinor: 600,
      refundsMinor: 20,
    });
  });
});
