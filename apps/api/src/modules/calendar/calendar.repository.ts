/**
 * Persistence for the group reservation calendar.
 *
 * ===========================================================================
 * Occupancy is read from `inventory_day`, not re-derived by counting
 * reservations per night — which is what the spec suggested.
 *
 * `inventory_day.sold` is the same counter the oversell CHECK constraint
 * guards and the same one every booking transaction increments (CLAUDE.md
 * section 3.1). Reading it means the calendar cannot disagree with what the
 * database actually enforced. Re-deriving the number by scanning reservations
 * would produce a *second* opinion on occupancy, and the day those two
 * opinions differ is the day nobody can tell which is right.
 *
 * It is also far cheaper: one indexed range scan per property instead of an
 * overlap join evaluated once per night.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { OPERABLE_PROPERTY_STATUSES, ReservationStatus } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

/** Statuses that consumed a room-night, and so belong in ADR and occupancy. */
const CONSUMING_STATUSES = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
] as const;

export interface GrantedPropertyRow {
  id: string;
  code: string;
  name: string;
  currency: string;
  timezone: string;
  businessDate: Date;
}

export interface InventoryDayRow {
  propertyId: string;
  stayDate: Date;
  physical: number;
  sold: number;
  blocked: number;
}

export interface StayRow {
  propertyId: string;
  arrivalDate: Date;
  departureDate: Date;
  totalAmountMinor: number;
}

@Injectable()
export class CalendarRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every property the caller may see, optionally narrowed.
   *
   * The traversal starts at `UserPropertyRole`, so `propertyIds` can only ever
   * *reduce* the set — an id the caller holds no grant at simply matches
   * nothing. That is why the filter needs no separate authorisation check: it
   * is applied inside a query that was already scoped to the caller.
   */
  async findGrantedProperties(
    userId: string,
    propertyIds?: readonly string[],
  ): Promise<GrantedPropertyRow[]> {
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
        propertyId: true,
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

  /** Inventory counters for every included property across the window. */
  async findInventory(
    propertyIds: readonly string[],
    startDate: Date,
    endDate: Date,
  ): Promise<InventoryDayRow[]> {
    if (propertyIds.length === 0) return [];

    return this.prisma.client.inventoryDay.findMany({
      where: {
        propertyId: { in: [...propertyIds] },
        // Inclusive on both ends: the window's last day is a night that is
        // sold or not, same as any other.
        stayDate: { gte: startDate, lte: endDate },
      },
      select: {
        propertyId: true,
        stayDate: true,
        physical: true,
        sold: true,
        blocked: true,
      },
    });
  }

  /**
   * Sellable room counts, per property.
   *
   * OUT_OF_ORDER rooms are excluded because they are not stock — a room with a
   * flooded bathroom is not "occupied", it is absent. OUT_OF_SERVICE rooms are
   * counted: those are short-term holds that still belong to the property's
   * capacity.
   *
   * Note this is a *current* count, while `inventory_day.physical` is the
   * per-date snapshot. They are normally equal; where they differ, the dated
   * figure is the one occupancy uses, and this one describes the property as
   * it stands today.
   */
  async countRoomsByProperty(
    propertyIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (propertyIds.length === 0) return new Map();

    const grouped = await this.prisma.client.room.groupBy({
      by: ['propertyId'],
      where: {
        propertyId: { in: [...propertyIds] },
        status: { not: 'OUT_OF_ORDER' },
      },
      _count: { _all: true },
    });

    return new Map(grouped.map((row) => [row.propertyId, row._count._all]));
  }

  /**
   * Stays overlapping the window, for the average daily rate.
   *
   * Overlap test is half-open on the stay side: `arrival < windowEnd + 1` and
   * `departure > windowStart`. A booking that checks out on the window's first
   * morning sold no night inside it, and `departure > start` is what excludes
   * it — using `>=` would count a night that was never sold.
   */
  async findOverlappingStays(
    propertyIds: readonly string[],
    startDate: Date,
    endDateExclusive: Date,
  ): Promise<StayRow[]> {
    if (propertyIds.length === 0) return [];

    return this.prisma.client.reservation.findMany({
      where: {
        propertyId: { in: [...propertyIds] },
        status: { in: [...CONSUMING_STATUSES] },
        arrivalDate: { lt: endDateExclusive },
        departureDate: { gt: startDate },
      },
      select: {
        propertyId: true,
        arrivalDate: true,
        departureDate: true,
        totalAmountMinor: true,
      },
    });
  }

  /** Properties that have at least one room type configured. */
  async findPropertiesWithRoomTypes(
    propertyIds: readonly string[],
  ): Promise<Set<string>> {
    if (propertyIds.length === 0) return new Set();

    const grouped = await this.prisma.client.roomType.groupBy({
      by: ['propertyId'],
      where: { propertyId: { in: [...propertyIds] } },
    });

    return new Set(grouped.map((row) => row.propertyId));
  }
}
