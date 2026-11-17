/**
 * Flash, sales, tax and revenue read closed days from the night-audit
 * snapshots (RP-05, RP-08, RP-09, RP-10). A fake repository; the integration
 * suite `test/integration/snapshot-reports.test.mjs` covers the same against
 * Postgres and the running API.
 */

import { describe, expect, it } from 'vitest';
import type { ReportQuery } from '@repo/types';

import type { SnapshotRow } from '../../common/reporting/daily-snapshots.js';
import type {
  ReportInventoryRow,
  ReportPropertyRow,
  ReportsRepository,
  TaxDayRow,
} from './reports.repository.js';
import { ReportsService } from './reports.service.js';
import { RevenueService } from './revenue.service.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const property: ReportPropertyRow = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'T1',
  name: 'Test',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  // The open business date; 2026-11-01 .. 2026-11-04 are closed.
  businessDate: day('2026-11-05'),
  checkInTime: '14:00',
  checkOutTime: '11:00',
};

function snapshot(date: string, sold: number, revenue: number, tax: number): SnapshotRow {
  return {
    propertyId: property.id,
    businessDate: day(date),
    roomsAvailable: 9,
    roomsSold: sold,
    occupancyBp: Math.round((sold * 10_000) / 9),
    roomRevenueMinor: revenue,
    adrMinor: sold === 0 ? 0 : Math.round(revenue / sold),
    revparMinor: Math.round(revenue / 9),
    serviceRevenueMinor: 100,
    taxMinor: tax,
    paymentsMinor: 1_000,
    refundsMinor: 10,
  };
}

// Nov 2 has no snapshot: a closed day the audit never froze.
const CLOSED = [
  snapshot('2026-10-31', 3, 30_000, 3_600),
  snapshot('2026-11-01', 4, 40_000, 4_800),
  snapshot('2026-11-03', 6, 60_000, 7_200),
  snapshot('2026-11-04', 7, 70_000, 8_400),
];

function inventory(date: string, sold: number): ReportInventoryRow {
  return {
    stayDate: day(date),
    physical: 10,
    sold,
    blocked: 1,
    overbookingAllowance: 0,
    roomType: { code: 'A', name: 'A' },
  };
}

function fakeRepository(
  overrides: { roles?: string[]; tax?: TaxDayRow[] } = {},
): ReportsRepository {
  const within = (row: SnapshotRow, from: Date, to: Date) =>
    row.businessDate >= from && row.businessDate <= to;
  return {
    findGrantedProperty: () =>
      Promise.resolve({ property, roles: overrides.roles ?? ['PROPERTY_ADMIN'] }),
    findClosedDays: (_id: string, from: Date, to: Date) =>
      Promise.resolve(CLOSED.filter((row) => within(row, from, to))),
    // Live counters disagree with every snapshot: 1 sold each day.
    findInventory: (_id: string, from: Date, to: Date) =>
      Promise.resolve(
        ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']
          .map((date) => inventory(date, 1))
          .filter((row) => row.stayDate >= from && row.stayDate <= to),
      ),
    findStays: () => Promise.resolve([]),
    findTaxByDate: () => Promise.resolve(overrides.tax ?? []),
  } as unknown as ReportsRepository;
}

const query = (q: Partial<ReportQuery> = {}): ReportQuery => ({ format: 'json', ...q });

describe('flash manager (RP-05)', () => {
  it('defaults to the last closed day and reads only snapshots', async () => {
    const report = await new ReportsService(fakeRepository()).run(
      'u',
      'T1',
      'flash-manager',
      query(),
    );
    const [dayRow, mtd, ytd] = report.rows;
    expect(dayRow).toMatchObject({
      period: 'Day',
      to: '2026-11-04',
      closedDays: 1,
      roomsSold: 7,
      roomRevenueMinor: 70_000,
      taxMinor: 8_400,
    });
    expect(mtd).toMatchObject({
      closedDays: 3,
      roomsSold: 17,
      roomRevenueMinor: 170_000,
      roomsAvailable: 27,
    });
    expect(ytd).toMatchObject({ closedDays: 4, roomsSold: 20, roomRevenueMinor: 200_000 });
    // ADR from sums: 170000 / 17.
    expect(mtd?.['adrMinor']).toBe(10_000);
    expect(report.notes.some((note) => note.includes('have no snapshot'))).toBe(true);
  });

  it('an open target day contributes nothing and says so', async () => {
    const report = await new ReportsService(fakeRepository()).run(
      'u',
      'T1',
      'flash-manager',
      query({ endDate: '2026-11-05' as never }),
    );
    expect(report.rows[0]).toMatchObject({ closedDays: 0, roomsSold: 0, adrMinor: null });
    expect(report.notes.some((note) => note.includes('is not closed yet'))).toBe(true);
  });
});

describe('sales (RP-08)', () => {
  it('reads snapshots for closed dates and live counters for the rest, labelled', async () => {
    const report = await new ReportsService(fakeRepository()).run(
      'u',
      'T1',
      'sales',
      query({ startDate: '2026-11-01' as never, endDate: '2026-11-06' as never }),
    );
    const byDate = new Map(report.rows.map((row) => [row['date'], row]));
    expect(byDate.get('2026-11-01')).toMatchObject({
      basis: 'Closed',
      roomsSold: 4,
      roomsAvailable: 9,
      revenueMinor: 40_000,
    });
    // Nov 2: closed by the calendar, no snapshot, so live.
    expect(byDate.get('2026-11-02')).toMatchObject({
      basis: 'On the books',
      roomsSold: 1,
      roomsAvailable: 9,
    });
    expect(byDate.get('2026-11-05')).toMatchObject({ basis: 'On the books', roomsSold: 1 });
    expect(report.totals).toMatchObject({ roomsSold: 4 + 1 + 6 + 7 + 1 + 1 });
  });
});

describe('tax (RP-09)', () => {
  const tax: TaxDayRow[] = [
    {
      chargeDate: day('2026-11-04'),
      roomTaxableMinor: 70_000,
      roomTaxMinor: 8_400,
      serviceTaxableMinor: 0,
      serviceTaxMinor: 0,
      totalTaxMinor: 8_400,
      taxLines: 7,
    },
    {
      chargeDate: day('2026-11-05'),
      roomTaxableMinor: 10_000,
      roomTaxMinor: 1_200,
      serviceTaxableMinor: 1_000,
      serviceTaxMinor: 180,
      totalTaxMinor: 1_400,
      taxLines: 3,
    },
  ];

  it('totals every tax line, keeps the unattributed part visible, and checks closed days', async () => {
    const report = await new ReportsService(fakeRepository({ tax })).run(
      'u',
      'T1',
      'tax',
      query({ startDate: '2026-11-03' as never, endDate: '2026-11-05' as never }),
    );
    const byDate = new Map(report.rows.map((row) => [row['date'], row]));
    expect(byDate.get('2026-11-04')).toMatchObject({
      totalTaxMinor: 8_400,
      snapshotTaxMinor: 8_400,
      otherTaxMinor: 0,
    });
    expect(byDate.get('2026-11-05')).toMatchObject({
      totalTaxMinor: 1_400,
      otherTaxMinor: 20,
      snapshotTaxMinor: null,
    });
    // Nov 3's snapshot froze 7200 of tax but the ledger has none: shown, flagged.
    expect(byDate.get('2026-11-03')).toMatchObject({ totalTaxMinor: 0, snapshotTaxMinor: 7_200 });
    expect(
      report.notes.some((note) => note.includes('2026-11-03') && note.includes('differs')),
    ).toBe(true);
    expect(
      report.notes.some((note) => note.includes('2026-11-04') && note.includes('differs')),
    ).toBe(false);
    expect(report.totals).toMatchObject({
      totalTaxMinor: 9_800,
      taxLines: 10,
      snapshotTaxMinor: null,
    });
  });

  it('is refused without financial reports', async () => {
    await expect(
      new ReportsService(fakeRepository({ roles: ['HOUSEKEEPING'] })).run(
        'u',
        'T1',
        'tax',
        query(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('revenue screen (RP-10)', () => {
  it('defaults to the month of the last closed day; gaps named, open days counted', async () => {
    const overview = await new RevenueService(fakeRepository()).overview('u', 'T1', {});
    expect(overview.from).toBe('2026-11-01');
    expect(overview.to).toBe('2026-11-04');
    expect(overview.days.map((d) => d.businessDate)).toEqual([
      '2026-11-01',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(overview.missingDates).toEqual(['2026-11-02']);
    expect(overview.openDays).toBe(0);
    expect(overview.totals).toMatchObject({
      days: 3,
      roomsSold: 17,
      roomRevenueMinor: 170_000,
      adrMinor: 10_000,
    });
  });

  it('counts days on or after the business date as open', async () => {
    const overview = await new RevenueService(fakeRepository()).overview('u', 'T1', {
      from: '2026-11-04' as never,
      to: '2026-11-07' as never,
    });
    expect(overview.days).toHaveLength(1);
    expect(overview.openDays).toBe(3);
    expect(overview.missingDates).toEqual([]);
  });

  it('refuses an over-long window and a role without financial reports', async () => {
    await expect(
      new RevenueService(fakeRepository()).overview('u', 'T1', {
        from: '2024-01-01' as never,
        to: '2026-11-04' as never,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      new RevenueService(fakeRepository({ roles: ['FRONT_DESK'] })).overview('u', 'T1', {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
