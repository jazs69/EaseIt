/**
 * Reading the night audit's closed-day snapshots (RP-05, RP-08, RP-10, GR-02).
 *
 * One query and one mapper, shared by the reports, the revenue screen, the
 * property dashboard and the group view. Each report must see the same closed
 * day the same way, so they all read it through this file. A second copy of
 * the mapping is how two screens would start disagreeing about one day.
 *
 * Read-only by construction: `daily_snapshot` refuses UPDATE with a trigger,
 * and nothing here writes.
 */

import type { BusinessDate, ClosedDay } from '@repo/types';

import type { PrismaService } from '../../prisma/prisma.service.js';

export interface SnapshotRow {
  propertyId: string;
  businessDate: Date;
  roomsAvailable: number;
  roomsSold: number;
  occupancyBp: number;
  roomRevenueMinor: number;
  adrMinor: number;
  revparMinor: number;
  serviceRevenueMinor: number;
  taxMinor: number;
  paymentsMinor: number;
  refundsMinor: number;
}

/** `YYYY-MM-DD` of a `@db.Date`, which Prisma returns at UTC midnight. */
export function isoDate(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

/**
 * Snapshots of the given properties with `from <= businessDate <= to`, oldest
 * first. Always filtered by property in the query itself (CLAUDE.md 3.2).
 */
export async function findClosedDays(
  client: PrismaService['client'],
  propertyIds: readonly string[],
  from: Date,
  to: Date,
): Promise<SnapshotRow[]> {
  if (propertyIds.length === 0) return [];
  return client.dailySnapshot.findMany({
    where: { propertyId: { in: [...propertyIds] }, businessDate: { gte: from, lte: to } },
    select: {
      propertyId: true,
      businessDate: true,
      roomsAvailable: true,
      roomsSold: true,
      occupancyBp: true,
      roomRevenueMinor: true,
      adrMinor: true,
      revparMinor: true,
      serviceRevenueMinor: true,
      taxMinor: true,
      paymentsMinor: true,
      refundsMinor: true,
    },
    orderBy: [{ businessDate: 'asc' }, { propertyId: 'asc' }],
  });
}

/**
 * The wire shape. The stored ADR is 0 when nothing was sold (the column is
 * NOT NULL); on the wire that is null, because zero would mean rooms were sold
 * for nothing.
 */
export function toClosedDay(row: SnapshotRow): ClosedDay {
  return {
    businessDate: isoDate(row.businessDate),
    roomsAvailable: row.roomsAvailable,
    roomsSold: row.roomsSold,
    occupancyBp: row.occupancyBp,
    roomRevenueMinor: row.roomRevenueMinor,
    adrMinor: row.roomsSold === 0 ? null : row.adrMinor,
    revparMinor: row.revparMinor,
    serviceRevenueMinor: row.serviceRevenueMinor,
    taxMinor: row.taxMinor,
    paymentsMinor: row.paymentsMinor,
    refundsMinor: row.refundsMinor,
  };
}
