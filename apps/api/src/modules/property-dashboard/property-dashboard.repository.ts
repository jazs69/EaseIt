/**
 * Persistence for the property operations dashboard.
 *
 * Every query here is scoped to one `propertyId` that the caller has already
 * been proved to hold a grant at (CLAUDE.md section 3.2). The counts are eight
 * aggregates over the same table, issued as one batch so they all resolve
 * against the same snapshot — eight sequential round trips could each see a
 * different state, and a dashboard whose tabs disagree with its own feed is
 * worse than a slow one.
 */

import { Injectable } from '@nestjs/common';
import { ReservationStatus, type MealPlan } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

/** Statuses that count as "currently in the hotel". */
const IN_HOUSE_STATUSES = [ReservationStatus.CHECKED_IN] as const;

/** Statuses that are still live bookings for arrival/departure purposes. */
const LIVE_STATUSES = [ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN] as const;

export interface DashboardPropertyRow {
  id: string;
  code: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  businessDate: Date;
  checkInTime: string;
  checkOutTime: string;
}

export interface ReservationRow {
  id: string;
  confirmationCode: string;
  status: ReservationStatus;
  mealPlan: MealPlan;
  arrivalDate: Date;
  departureDate: Date;
  adults: number;
  children: number;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  totalAmountMinor: number;
  paidAmountMinor: number;
  currency: string;
  isMagicLinkActive: boolean;
  createdAt: Date;
  rooms: {
    roomTypeId: string;
    roomType: { name: string; code: string };
    room: { number: string } | null;
  }[];
}

export interface InventoryRow {
  roomTypeId: string;
  physical: number;
  sold: number;
  blocked: number;
  overbookingAllowance: number;
  roomType: {
    code: string;
    name: string;
    baseRateMinor: number;
    currency: string;
    sortOrder: number;
  };
}

export interface DashboardCounts {
  newBookingsCount: number;
  inHouseCount: number;
  arrivalsCount: number;
  departuresCount: number;
  cancellationsCount: number;
  onHoldCount: number;
  noShowsCount: number;
  magicLinkCount: number;
}

@Injectable()
export class PropertyDashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a property the caller holds a grant at, by **code or id**.
   *
   * The dashboard is reached as `?hotelId=31336`, an operator-facing code
   * rather than a uuid, so both spellings are accepted. Either way the lookup
   * is joined through `UserPropertyRole`, so an identifier the caller has no
   * grant for comes back null and is reported as not-found — never as a 403,
   * which would confirm the property exists (CLAUDE.md section 3.2).
   */
  async findGrantedProperty(
    userId: string,
    codeOrId: string,
  ): Promise<DashboardPropertyRow | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grant = await this.prisma.client.userPropertyRole.findFirst({
      where: {
        userId,
        property: isUuid ? { id: codeOrId } : { code: codeOrId },
      },
      select: {
        property: {
          select: {
            id: true,
            code: true,
            name: true,
            slug: true,
            timezone: true,
            currency: true,
            businessDate: true,
            checkInTime: true,
            checkOutTime: true,
          },
        },
      },
    });

    return grant?.property ?? null;
  }

  /**
   * The eight headline counts, in one round trip.
   *
   * `$transaction` with an array runs them as a batch in a single read
   * transaction, so every count sees the same snapshot.
   */
  async countMetrics(propertyId: string, targetDate: Date): Promise<DashboardCounts> {
    const client = this.prisma.client;

    // "Created today" is an instant range, not a calendar comparison: the
    // column is a timestamptz. The window is the target date in UTC, matching
    // how @db.Date values are stored at UTC midnight.
    const dayStart = new Date(targetDate);
    const dayEnd = new Date(targetDate);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const [
      newBookingsCount,
      inHouseCount,
      arrivalsCount,
      departuresCount,
      cancellationsCount,
      onHoldCount,
      noShowsCount,
      magicLinkCount,
    ] = await client.$transaction([
      client.reservation.count({
        where: { propertyId, createdAt: { gte: dayStart, lt: dayEnd } },
      }),
      client.reservation.count({
        where: { propertyId, status: { in: [...IN_HOUSE_STATUSES] } },
      }),
      client.reservation.count({
        where: { propertyId, arrivalDate: targetDate, status: { in: [...LIVE_STATUSES] } },
      }),
      client.reservation.count({
        where: { propertyId, departureDate: targetDate, status: { in: [...LIVE_STATUSES] } },
      }),
      client.reservation.count({
        where: { propertyId, status: ReservationStatus.CANCELLED },
      }),
      client.reservation.count({
        where: { propertyId, status: ReservationStatus.ON_HOLD },
      }),
      client.reservation.count({
        where: { propertyId, status: ReservationStatus.NO_SHOW },
      }),
      client.reservation.count({ where: { propertyId, isMagicLinkActive: true } }),
    ]);

    return {
      newBookingsCount,
      inHouseCount,
      arrivalsCount,
      departuresCount,
      cancellationsCount,
      onHoldCount,
      noShowsCount,
      magicLinkCount,
    };
  }

  /** The reservation feed for one metric view. */
  async findReservationsForMetric(
    propertyId: string,
    metric: string,
    targetDate: Date,
  ): Promise<ReservationRow[]> {
    const dayStart = new Date(targetDate);
    const dayEnd = new Date(targetDate);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    // Each view selects on a different axis — creation instant, status, or one
    // of the two stay dates — which is exactly why `DashboardMetric` is its own
    // union rather than a status filter.
    const where = (() => {
      switch (metric) {
        case 'NEW_BOOKINGS':
          return { propertyId, createdAt: { gte: dayStart, lt: dayEnd } };
        case 'ARRIVALS':
          return { propertyId, arrivalDate: targetDate, status: { in: [...LIVE_STATUSES] } };
        case 'DEPARTURES':
          return { propertyId, departureDate: targetDate, status: { in: [...LIVE_STATUSES] } };
        case 'CANCELLATIONS':
          return { propertyId, status: ReservationStatus.CANCELLED };
        case 'ON_HOLD':
          return { propertyId, status: ReservationStatus.ON_HOLD };
        case 'NO_SHOWS':
          return { propertyId, status: ReservationStatus.NO_SHOW };
        case 'MAGIC_LINK':
          return { propertyId, isMagicLinkActive: true };
        case 'IN_HOUSE':
        default:
          return { propertyId, status: { in: [...IN_HOUSE_STATUSES] } };
      }
    })();

    return this.prisma.client.reservation.findMany({
      where,
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        mealPlan: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        guestFirstName: true,
        guestLastName: true,
        guestEmail: true,
        guestPhone: true,
        totalAmountMinor: true,
        paidAmountMinor: true,
        currency: true,
        isMagicLinkActive: true,
        createdAt: true,
        rooms: {
          select: {
            roomTypeId: true,
            roomType: { select: { name: true, code: true } },
            room: { select: { number: true } },
          },
        },
      },
      orderBy: [{ arrivalDate: 'asc' }, { confirmationCode: 'asc' }],
      // A front desk reads a day at a time. Unbounded would mean a cancelled
      // backlog of thousands rendering into one page.
      take: 200,
    });
  }

  /** Availability by category for one date. */
  async findInventoryForDate(propertyId: string, targetDate: Date): Promise<InventoryRow[]> {
    return this.prisma.client.inventoryDay.findMany({
      where: { propertyId, stayDate: targetDate },
      select: {
        roomTypeId: true,
        physical: true,
        sold: true,
        blocked: true,
        overbookingAllowance: true,
        roomType: {
          select: {
            code: true,
            name: true,
            baseRateMinor: true,
            currency: true,
            sortOrder: true,
          },
        },
      },
      orderBy: { roomType: { sortOrder: 'asc' } },
    });
  }

  /** Payment-gateway onboarding state, for the operational alert. */
  async findGatewayConfigs(propertyId: string): Promise<
    {
      provider: string;
      status: string;
      onboardingDueDate: Date | null;
    }[]
  > {
    return this.prisma.client.paymentGatewayConfig.findMany({
      where: { propertyId },
      select: { provider: true, status: true, onboardingDueDate: true },
    });
  }
}
