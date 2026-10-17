/**
 * Persistence for property reports.
 *
 * Every query is scoped by `propertyId` as its first condition, and the
 * property itself is resolved through the caller's own grants, so a report can
 * never be run against a hotel the caller holds no role at
 * (CLAUDE.md section 3.2).
 */

import { Injectable } from '@nestjs/common';
import { OPERABLE_PROPERTY_STATUSES, ReservationStatus } from '@repo/types';
import type { BookingSource, MealPlan, Role } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Statuses whose room-nights count as sold — the same set
 * `inventory_day.sold` is incremented for, so a report cannot disagree with
 * the counter the oversell CHECK guards.
 */
const EARNING_STATUSES = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
] as const;

export interface ReportPropertyRow {
  id: string;
  code: string;
  name: string;
  currency: string;
  timezone: string;
  businessDate: Date;
}

export interface ReportInventoryRow {
  stayDate: Date;
  physical: number;
  sold: number;
  blocked: number;
  overbookingAllowance: number;
  roomType: { code: string; name: string };
}

export interface ReportStayRow {
  id: string;
  confirmationCode: string;
  otaBookingId: string | null;
  guestFirstName: string;
  guestLastName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  status: ReservationStatus;
  source: BookingSource;
  mealPlan: MealPlan;
  adults: number;
  children: number;
  arrivalDate: Date;
  departureDate: Date;
  totalAmountMinor: number;
  paidAmountMinor: number;
  currency: string;
  createdAt: Date;
  rooms: { room: { number: string } | null; roomType: { name: string } }[];
}

export interface ReportRoomTypeRow {
  code: string;
  name: string;
  baseRateMinor: number;
  currency: string;
  maxGuests: number;
  maxAdults: number | null;
  _count: { rooms: number };
}

@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolves a code or uuid through the caller's grants, or null. */
  async findGrantedProperty(
    userId: string,
    codeOrId: string,
  ): Promise<{ property: ReportPropertyRow; roles: Role[] } | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const rows = await this.prisma.client.userPropertyRole.findMany({
      where: {
        userId,
        property: {
          status: { in: [...OPERABLE_PROPERTY_STATUSES] },
          ...(isUuid ? { id: codeOrId } : { code: codeOrId }),
        },
      },
      select: {
        role: { select: { key: true } },
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
    });

    const first = rows[0];
    if (first === undefined) return null;

    // A user may hold several roles here; authority is their union, never the
    // most privileged one alone (CLAUDE.md RBAC notes).
    //
    // `role.key` is null for a property-custom role, which has no built-in
    // key and therefore no entry in the default permission map. Those are
    // dropped here rather than coerced: a custom role's permissions live on
    // its own RolePermission rows, and pretending it maps to a built-in role
    // would grant or deny the wrong set.
    const roles = rows
      .map((row) => row.role.key)
      .filter((key): key is Role => key !== null);

    return { property: first.property, roles };
  }

  /** Per-date, per-room-type inventory counters across the window. */
  findInventory(
    propertyId: string,
    start: Date,
    end: Date,
  ): Promise<ReportInventoryRow[]> {
    return this.prisma.client.inventoryDay.findMany({
      where: { propertyId, stayDate: { gte: start, lte: end } },
      select: {
        stayDate: true,
        physical: true,
        sold: true,
        blocked: true,
        overbookingAllowance: true,
        roomType: { select: { code: true, name: true } },
      },
      orderBy: [{ stayDate: 'asc' }],
    });
  }

  /**
   * Stays overlapping the window.
   *
   * Half-open on the stay side: `departure > start` strictly, because a
   * booking that checked out on the window's first morning sold no night
   * inside it.
   */
  findStays(
    propertyId: string,
    start: Date,
    endExclusive: Date,
  ): Promise<ReportStayRow[]> {
    return this.prisma.client.reservation.findMany({
      where: {
        propertyId,
        status: { in: [...EARNING_STATUSES] },
        arrivalDate: { lt: endExclusive },
        departureDate: { gt: start },
      },
      select: {
        id: true,
        confirmationCode: true,
        otaBookingId: true,
        guestFirstName: true,
        guestLastName: true,
        guestPhone: true,
        guestEmail: true,
        status: true,
        source: true,
        mealPlan: true,
        adults: true,
        children: true,
        arrivalDate: true,
        departureDate: true,
        totalAmountMinor: true,
        paidAmountMinor: true,
        currency: true,
        createdAt: true,
        rooms: {
          select: {
            room: { select: { number: true } },
            roomType: { select: { name: true } },
          },
          take: 1,
        },
      },
      orderBy: [{ arrivalDate: 'asc' }, { confirmationCode: 'asc' }],
    });
  }

  /** Room types with their configured rate, for BAR pricing. */
  findRoomTypes(propertyId: string): Promise<ReportRoomTypeRow[]> {
    return this.prisma.client.roomType.findMany({
      where: { propertyId },
      select: {
        code: true,
        name: true,
        baseRateMinor: true,
        currency: true,
        maxGuests: true,
        maxAdults: true,
        _count: { select: { rooms: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }
}
