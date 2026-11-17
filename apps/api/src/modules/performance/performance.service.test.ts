/**
 * Group performance reads closed days from the night-audit snapshots (RP-08).
 *
 * A fake repository whose snapshot figures deliberately disagree with the live
 * counters for the same dates, so each assertion proves which source was used.
 */

import { describe, expect, it } from 'vitest';

import type { SnapshotRow } from '../../common/reporting/daily-snapshots.js';
import type { ClockService } from '../platform/clock.service.js';
import type {
  PerformanceInventoryRow,
  PerformancePropertyRow,
  PerformanceRepository,
  PerformanceStayRow,
} from './performance.repository.js';
import { PerformanceService } from './performance.service.js';

const P1 = '00000000-0000-4000-8000-000000000001';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const property: PerformancePropertyRow = {
  id: P1,
  code: 'T1',
  name: 'Test',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  businessDate: day('2026-11-05'),
};

function inventory(date: string, sold: number, blocked = 0): PerformanceInventoryRow {
  return { propertyId: P1, stayDate: day(date), physical: 10, sold, blocked };
}

function snapshot(date: string, sold: number, available: number, revenue: number): SnapshotRow {
  return {
    propertyId: P1,
    businessDate: day(date),
    roomsAvailable: available,
    roomsSold: sold,
    occupancyBp: Math.round((sold * 10_000) / available),
    roomRevenueMinor: revenue,
    adrMinor: sold === 0 ? 0 : Math.round(revenue / sold),
    revparMinor: Math.round(revenue / available),
    serviceRevenueMinor: 0,
    taxMinor: 0,
    paymentsMinor: 0,
    refundsMinor: 0,
  };
}

function service(data: {
  inventory: PerformanceInventoryRow[];
  stays: PerformanceStayRow[];
  closed: SnapshotRow[];
}): PerformanceService {
  const within = <T>(rows: T[], dateOf: (row: T) => Date, from: Date, to: Date) =>
    rows.filter((row) => dateOf(row) >= from && dateOf(row) <= to);
  const repository = {
    findGrantedProperties: () => Promise.resolve([property]),
    findInventory: (_ids: readonly string[], from: Date, to: Date) =>
      Promise.resolve(within(data.inventory, (row) => row.stayDate, from, to)),
    findEarningStays: (_ids: readonly string[], from: Date, toExclusive: Date) =>
      Promise.resolve(
        data.stays.filter((stay) => stay.arrivalDate < toExclusive && stay.departureDate > from),
      ),
    findClosedDays: (_ids: readonly string[], from: Date, to: Date) =>
      Promise.resolve(within(data.closed, (row) => row.businessDate, from, to)),
    countRoomsByProperty: () => Promise.resolve(new Map([[P1, 10]])),
  } as unknown as PerformanceRepository;
  const clock = { now: () => new Date('2026-11-05T06:00:00Z') } as unknown as ClockService;
  return new PerformanceService(repository, clock);
}

describe('PerformanceService closed days (RP-08)', () => {
  // Nov 1-4 closed; Nov 5 open. Live counters say 1 sold every day and a stay
  // worth 1000/night covers Nov 1-6. Snapshots say otherwise.
  const data = {
    inventory: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((d) =>
      inventory(d, 1, d === '2026-11-05' ? 2 : 0),
    ),
    stays: [
      {
        propertyId: P1,
        arrivalDate: day('2026-11-01'),
        departureDate: day('2026-11-06'),
        totalAmountMinor: 5_000,
        source: 'WALK_IN',
        roomCount: 1,
      } as PerformanceStayRow,
    ],
    closed: [
      snapshot('2026-11-01', 4, 9, 40_000),
      snapshot('2026-11-02', 5, 9, 50_000),
      snapshot('2026-11-03', 6, 9, 60_000),
      snapshot('2026-11-04', 7, 9, 70_000),
    ],
  };

  it('takes closed days from snapshots and the open day live, with no double count', async () => {
    const result = await service(data).groupPerformance('user', {
      timeframe: 'mtd',
      targetDate: '2026-11-05',
      compareWithLastYear: false,
    } as never);

    // Closed: 4+5+6+7 = 22 sold of 36, revenue 220000. Open Nov 5: 1 sold of
    // 10 - 2 blocked = 8, revenue 1000 (one night of the 5000 stay).
    expect(result.metrics.roomNightsSold).toBe(23);
    expect(result.metrics.roomNightsAvailable).toBe(44);
    expect(result.metrics.totalRevenueMinor).toBe(221_000);
    expect(result.basis).toEqual({ closedPropertyDays: 4, livePropertyDays: 1 });
  });

  it('a window of closed days only is exactly the snapshots', async () => {
    const result = await service(data).groupPerformance('user', {
      timeframe: 'today',
      targetDate: '2026-11-02',
      compareWithLastYear: false,
    } as never);
    expect(result.metrics.roomNightsSold).toBe(5);
    expect(result.metrics.roomNightsAvailable).toBe(9);
    expect(result.metrics.totalRevenueMinor).toBe(50_000);
    expect(result.metrics.adrMinor).toBe(10_000);
    expect(result.basis).toEqual({ closedPropertyDays: 1, livePropertyDays: 0 });
  });

  it('with no snapshots, everything is live as before (sellable = physical - blocked)', async () => {
    const result = await service({ ...data, closed: [] }).groupPerformance('user', {
      timeframe: 'mtd',
      targetDate: '2026-11-05',
      compareWithLastYear: false,
    } as never);
    expect(result.metrics.roomNightsSold).toBe(5);
    expect(result.metrics.roomNightsAvailable).toBe(48);
    expect(result.metrics.totalRevenueMinor).toBe(5_000);
    expect(result.basis).toEqual({ closedPropertyDays: 0, livePropertyDays: 5 });
  });

  it('the monthly trajectory uses the same rule', async () => {
    const result = await service(data).groupPerformance('user', {
      timeframe: 'mtd',
      targetDate: '2026-11-05',
      compareWithLastYear: false,
    } as never);
    const november = result.monthlyData.find((month) => month.monthKey === '2026-11');
    // The stay's sixth night does not exist (departure Nov 6), so the month
    // equals the MTD figure.
    expect(november?.revenueMinor).toBe(221_000);
    expect(november?.roomNightsSold).toBe(23);
  });
});
