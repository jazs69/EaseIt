/**
 * Persistence for the timeline calendar.
 *
 * Everything is scoped to one `propertyId` the caller has been proved to hold
 * a grant at. Note what this file does *not* do: it never filters rooms in
 * JavaScript after loading them all. Floor, category and housekeeping filters
 * go into the `where`, so a 500-room property does not ship 500 rows to
 * discard 480.
 */

import { Injectable } from '@nestjs/common';
import { OPERABLE_PROPERTY_STATUSES, ReservationStatus, type RoomStatus } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

/** Statuses that occupy a room, and so draw a block on the grid. */
const OCCUPYING_STATUSES = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
  ReservationStatus.ON_HOLD,
] as const;

/** Statuses that consume inventory. ON_HOLD draws a block but holds no stock. */
const CONSUMING_STATUSES = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
] as const;

export interface TimelinePropertyRow {
  id: string;
  code: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  businessDate: Date;
  checkInTime: string;
  checkOutTime: string;
}

export interface TimelineRoomRow {
  id: string;
  number: string;
  floor: string | null;
  status: RoomStatus;
  roomTypeId: string;
  roomType: { code: string; name: string; baseRateMinor: number; sortOrder: number };
}

export interface TimelineStayRow {
  id: string;
  propertyId: string;
  roomId: string | null;
  roomTypeId: string;
  arrivalDate: Date;
  departureDate: Date;
  status: ReservationStatus;
  reservation: {
    id: string;
    confirmationCode: string;
    guestFirstName: string;
    guestLastName: string;
    guestPhone: string | null;
    guestEmail: string | null;
    mealPlan: 'EP' | 'CP' | 'MAP' | 'AP';
    adults: number;
    children: number;
    totalAmountMinor: number;
    paidAmountMinor: number;
    currency: string;
    isMagicLinkActive: boolean;
    /** Real arrival/departure instants, null until the front desk records them. */
    checkedInAt: Date | null;
    checkedOutAt: Date | null;
  };
}

export interface TimelineInventoryRow {
  roomTypeId: string;
  stayDate: Date;
  physical: number;
  sold: number;
  blocked: number;
  overbookingAllowance: number;
}

export interface RoomFilter {
  roomTypeId?: string;
  floor?: string;
  housekeeping: 'all' | 'clean' | 'dirty' | 'blocked';
}

@Injectable()
export class TimelineRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a property the caller may enter, by code or uuid.
   *
   * Joined through `UserPropertyRole`, so an identifier the caller holds no
   * grant for comes back null and is reported as not-found — never as a 403,
   * which would confirm the property exists (CLAUDE.md section 3.2).
   */
  async findGrantedProperty(
    userId: string,
    codeOrId: string,
  ): Promise<TimelinePropertyRow | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grant = await this.prisma.client.userPropertyRole.findFirst({
      where: {
        userId,
        property: {
          status: { in: [...OPERABLE_PROPERTY_STATUSES] },
          ...(isUuid ? { id: codeOrId } : { code: codeOrId }),
        },
      },
      select: {
        property: {
          select: {
            id: true,
            code: true,
            name: true,
            slug: true,
            currency: true,
            timezone: true,
            businessDate: true,
            checkInTime: true,
            checkOutTime: true,
          },
        },
      },
    });

    return grant?.property ?? null;
  }

  /** Rooms for the left axis, filtered and ordered for display. */
  async findRooms(propertyId: string, filter: RoomFilter): Promise<TimelineRoomRow[]> {
    // Mutable arrays, not `as const` tuples: Prisma's generated `in` filter
    // takes `RoomStatus[]`, and a readonly tuple is not assignable to it.
    const housekeepingWhere = ((): { status?: { in: RoomStatus[] } } => {
      switch (filter.housekeeping) {
        case 'clean':
          return { status: { in: ['VACANT_CLEAN', 'OCCUPIED_CLEAN', 'INSPECTED'] } };
        case 'dirty':
          return { status: { in: ['VACANT_DIRTY', 'OCCUPIED_DIRTY'] } };
        case 'blocked':
          return { status: { in: ['OUT_OF_SERVICE', 'OUT_OF_ORDER'] } };
        case 'all':
        default:
          return {};
      }
    })();

    return this.prisma.client.room.findMany({
      where: {
        propertyId,
        ...(filter.roomTypeId === undefined ? {} : { roomTypeId: filter.roomTypeId }),
        ...(filter.floor === undefined ? {} : { floor: filter.floor }),
        ...housekeepingWhere,
      },
      select: {
        id: true,
        number: true,
        floor: true,
        status: true,
        roomTypeId: true,
        roomType: {
          select: { code: true, name: true, baseRateMinor: true, sortOrder: true },
        },
      },
      // Category order first, then room number — so `by-category` grouping is
      // already contiguous and `flat` reads like a floor plan.
      orderBy: [{ roomType: { sortOrder: 'asc' } }, { number: 'asc' }],
    });
  }

  /**
   * Stays overlapping the window.
   *
   * Half-open overlap: `arrival < windowEndExclusive` and `departure >
   * windowStart`. The strict `>` on departure is load-bearing for a *date*
   * axis — a stay checking out on the window's first morning occupied no night
   * inside it, and `>=` would draw a phantom full-width block in that column.
   *
   * `includeDepartures` relaxes it to `>=`, and only the hourly Day view asks
   * for that. There, a guest leaving at 10:00 genuinely occupies the room from
   * midnight until the 10:00 column, and an hourly axis can say so — excluding
   * them would hide every one of the day's checkouts from the one view whose
   * job is the current shift.
   */
  async findOverlappingStays(
    propertyId: string,
    windowStart: Date,
    windowEndExclusive: Date,
    includeDepartures = false,
  ): Promise<TimelineStayRow[]> {
    return this.prisma.client.reservationRoom.findMany({
      where: {
        propertyId,
        status: { in: [...OCCUPYING_STATUSES] },
        arrivalDate: { lt: windowEndExclusive },
        departureDate: includeDepartures ? { gte: windowStart } : { gt: windowStart },
      },
      select: {
        id: true,
        propertyId: true,
        roomId: true,
        roomTypeId: true,
        arrivalDate: true,
        departureDate: true,
        status: true,
        reservation: {
          select: {
            id: true,
            confirmationCode: true,
            guestFirstName: true,
            guestLastName: true,
            guestPhone: true,
            guestEmail: true,
            mealPlan: true,
            adults: true,
            children: true,
            totalAmountMinor: true,
            paidAmountMinor: true,
            currency: true,
            isMagicLinkActive: true,
            checkedInAt: true,
            checkedOutAt: true,
          },
        },
      },
      orderBy: { arrivalDate: 'asc' },
    });
  }

  /** The inventory counters the rollup rows are read from. */
  async findInventory(
    propertyId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<TimelineInventoryRow[]> {
    return this.prisma.client.inventoryDay.findMany({
      where: { propertyId, stayDate: { gte: windowStart, lte: windowEnd } },
      select: {
        roomTypeId: true,
        stayDate: true,
        physical: true,
        sold: true,
        blocked: true,
        overbookingAllowance: true,
      },
    });
  }

  /** Stays with no room assigned, for the UA badge. */
  async findUnassignedStays(
    propertyId: string,
    windowStart: Date,
    windowEndExclusive: Date,
  ): Promise<TimelineStayRow[]> {
    return this.prisma.client.reservationRoom.findMany({
      where: {
        propertyId,
        roomId: null,
        status: { in: [...OCCUPYING_STATUSES] },
        arrivalDate: { lt: windowEndExclusive },
        departureDate: { gt: windowStart },
      },
      select: {
        id: true,
        propertyId: true,
        roomId: true,
        roomTypeId: true,
        arrivalDate: true,
        departureDate: true,
        status: true,
        reservation: {
          select: {
            id: true,
            confirmationCode: true,
            guestFirstName: true,
            guestLastName: true,
            guestPhone: true,
            guestEmail: true,
            mealPlan: true,
            adults: true,
            children: true,
            totalAmountMinor: true,
            paidAmountMinor: true,
            currency: true,
            isMagicLinkActive: true,
            checkedInAt: true,
            checkedOutAt: true,
          },
        },
      },
      orderBy: { arrivalDate: 'asc' },
    });
  }

  /** Every room type, for the category axis and the filter menu. */
  async findRoomTypes(propertyId: string): Promise<
    { id: string; code: string; name: string; baseRateMinor: number; sortOrder: number }[]
  > {
    return this.prisma.client.roomType.findMany({
      where: { propertyId },
      select: { id: true, code: true, name: true, baseRateMinor: true, sortOrder: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** Distinct floors, for the filter menu. */
  async findFloors(propertyId: string): Promise<string[]> {
    const rows = await this.prisma.client.room.findMany({
      where: { propertyId, floor: { not: null } },
      select: { floor: true },
      distinct: ['floor'],
      orderBy: { floor: 'asc' },
    });
    return rows
      .map((row) => row.floor)
      .filter((floor): floor is string => floor !== null);
  }

  /** Room-nights and revenue for ADR, over the window. */
  async findStaysForAdr(
    propertyId: string,
    windowStart: Date,
    windowEndExclusive: Date,
  ): Promise<
    { arrivalDate: Date; departureDate: Date; totalAmountMinor: number }[]
  > {
    return this.prisma.client.reservation.findMany({
      where: {
        propertyId,
        status: { in: [...CONSUMING_STATUSES] },
        arrivalDate: { lt: windowEndExclusive },
        departureDate: { gt: windowStart },
      },
      select: { arrivalDate: true, departureDate: true, totalAmountMinor: true },
    });
  }
}
