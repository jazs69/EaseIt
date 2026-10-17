/**
 * Persistence for group performance analytics.
 *
 * Occupancy denominators come from `inventory_day`, and revenue from
 * `reservation`. That split is deliberate: `inventory_day.physical` is the only
 * record of what capacity *was* on a past date, and it is the same counter the
 * oversell CHECK guards, so occupancy cannot disagree with what the database
 * enforced. Counting today's rooms instead would rewrite history every time a
 * room is added or taken out of order.
 */

import { Injectable } from '@nestjs/common';
import { OPERABLE_PROPERTY_STATUSES, ReservationStatus, type BookingSource } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Statuses whose room-nights count as sold.
 *
 * CONFIRMED, CHECKED_IN and CHECKED_OUT — the same set the booking path
 * increments `inventory_day.sold` for. CANCELLED, NO_SHOW, ON_HOLD and
 * TENTATIVE are excluded, so a cancelled booking never shows up as revenue.
 */
const EARNING_STATUSES = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
] as const;

export interface PerformancePropertyRow {
  id: string;
  code: string;
  name: string;
  currency: string;
  timezone: string;
  businessDate: Date;
}

export interface PerformanceInventoryRow {
  propertyId: string;
  stayDate: Date;
  physical: number;
  sold: number;
}

export interface PerformanceStayRow {
  propertyId: string;
  arrivalDate: Date;
  departureDate: Date;
  totalAmountMinor: number;
  /** Stored source. The report maps it to a display bucket, never the reverse. */
  source: BookingSource;
  /**
   * Rooms held by this reservation.
   *
   * Needed because room-nights are rooms x nights, not nights: a 3-night
   * booking of 2 rooms sold 6. Counting reservations instead would under-report
   * every group booking, and `inventory_day.sold` — which the other measures
   * use — carries no source, so it cannot answer this question.
   */
  roomCount: number;
}

@Injectable()
export class PerformanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Every property the caller may see, optionally narrowed. */
  async findGrantedProperties(
    userId: string,
    propertyIds?: readonly string[],
  ): Promise<PerformancePropertyRow[]> {
    const rows = await this.prisma.client.userPropertyRole.findMany({
      where: {
        userId,
        property: {
          status: { in: [...OPERABLE_PROPERTY_STATUSES] },
          ...(propertyIds === undefined || propertyIds.length === 0
            ? {}
            : { id: { in: [...propertyIds] } }),
        },
      },
      select: {
        property: {
          select: {
            id: true,
            code: true,
            name: true,
            currency: true,
            timezone: true,
            businessDate: true,
          },
        },
      },
      distinct: ['propertyId'],
      orderBy: { property: { name: 'asc' } },
    });

    return rows.map((row) => row.property);
  }

  /**
   * Capacity and rooms sold per property per date.
   *
   * Only the two counters the measures need are selected. Over a year-to-date
   * window across eleven properties this is already tens of thousands of rows,
   * and `blocked` / `overbookingAllowance` would be dead weight on every one.
   */
  async findInventory(
    propertyIds: readonly string[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PerformanceInventoryRow[]> {
    if (propertyIds.length === 0) return [];

    return this.prisma.client.inventoryDay.findMany({
      where: {
        propertyId: { in: [...propertyIds] },
        stayDate: { gte: periodStart, lte: periodEnd },
      },
      select: { propertyId: true, stayDate: true, physical: true, sold: true },
    });
  }

  /**
   * Earning stays overlapping the period.
   *
   * Half-open on the stay side: `departure > periodStart` strictly, because a
   * booking that checked out on the period's first morning sold no night inside
   * it and must not contribute revenue to it.
   */
  async findEarningStays(
    propertyIds: readonly string[],
    periodStart: Date,
    periodEndExclusive: Date,
  ): Promise<PerformanceStayRow[]> {
    if (propertyIds.length === 0) return [];

    const rows = await this.prisma.client.reservation.findMany({
      where: {
        propertyId: { in: [...propertyIds] },
        status: { in: [...EARNING_STATUSES] },
        arrivalDate: { lt: periodEndExclusive },
        departureDate: { gt: periodStart },
      },
      select: {
        propertyId: true,
        arrivalDate: true,
        departureDate: true,
        totalAmountMinor: true,
        source: true,
        _count: { select: { rooms: true } },
      },
    });

    // Flattened at the repository boundary rather than letting Prisma's
    // `_count` shape reach the service: that shape is a persistence detail,
    // and the domain wants a number called `roomCount`.
    return rows.map((row) => ({
      propertyId: row.propertyId,
      arrivalDate: row.arrivalDate,
      departureDate: row.departureDate,
      totalAmountMinor: row.totalAmountMinor,
      source: row.source,
      // A reservation with no room rows still sold the nights it was priced
      // for, so it counts as one rather than vanishing from the measure.
      roomCount: Math.max(1, row._count.rooms),
    }));
  }

  /** Sellable room counts today, for the breakdown's inventory column. */
  async countRoomsByProperty(propertyIds: readonly string[]): Promise<Map<string, number>> {
    if (propertyIds.length === 0) return new Map();

    const grouped = await this.prisma.client.room.groupBy({
      by: ['propertyId'],
      where: { propertyId: { in: [...propertyIds] }, status: { not: 'OUT_OF_ORDER' } },
      _count: { _all: true },
    });

    return new Map(grouped.map((row) => [row.propertyId, row._count._all]));
  }
}
