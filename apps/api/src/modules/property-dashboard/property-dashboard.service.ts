/**
 * Property operations dashboard application service.
 *
 * Maps rows to the wire contract and derives everything that must not be
 * stored: the operational sub-status, the outstanding balance, and the
 * available room count. All three are functions of the day being viewed, so a
 * cached copy would be wrong the moment the clock passed midnight.
 */

import { Injectable } from '@nestjs/common';
import {
  ReservationStatus,
  type AvailabilityBreakdown,
  type BusinessDate,
  type DashboardMetric,
  type DashboardReservation,
  type DashboardSummaryQuery,
  type PropertyDashboard,
  type PropertyId,
  type ReservationSubStatus,
  type RoomTypeId,
  type SystemAlert,
} from '@repo/types';

import { TenantScopeViolationError } from '../../common/errors/domain-error.js';
import {
  PropertyDashboardRepository,
  type InventoryRow,
  type ReservationRow,
} from './property-dashboard.repository.js';

/** `YYYY-MM-DD` from a @db.Date, which Prisma returns at UTC midnight. */
function toBusinessDate(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

/** A @db.Date-comparable value from `YYYY-MM-DD`. */
function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function nightsBetween(arrival: Date, departure: Date): number {
  return Math.max(
    1,
    Math.round((departure.getTime() - arrival.getTime()) / 86_400_000),
  );
}

@Injectable()
export class PropertyDashboardService {
  constructor(private readonly repository: PropertyDashboardRepository) {}

  async summary(
    userId: string,
    hotelId: string,
    query: DashboardSummaryQuery,
  ): Promise<PropertyDashboard> {
    const property = await this.repository.findGrantedProperty(userId, hotelId);

    if (property === null) {
      // Covers "no such property", "retired" and "you hold no role there"
      // indistinguishably, on purpose.
      throw new TenantScopeViolationError('Property');
    }

    // The property's own business date is the default, never the server's
    // calendar day: a hotel in Asia/Kolkata and the process running it can be
    // on different dates (CLAUDE.md section 3.3).
    const targetDate = query.date ?? toBusinessDate(property.businessDate);
    const targetDateValue = toUtcMidnight(targetDate);

    const [counts, reservationRows, inventoryRows, gateways] = await Promise.all([
      this.repository.countMetrics(property.id, targetDateValue),
      this.repository.findReservationsForMetric(property.id, query.metric, targetDateValue),
      this.repository.findInventoryForDate(property.id, targetDateValue),
      this.repository.findGatewayConfigs(property.id),
    ]);

    const mapped = reservationRows.map((row) =>
      this.toDashboardReservation(row, targetDate, property.checkInTime, property.checkOutTime),
    );

    // Search is applied after mapping so it can match the *composed* guest
    // name and the assigned room number, neither of which is a single column.
    const needle = query.search?.toLowerCase();
    const reservations =
      needle === undefined
        ? mapped
        : mapped.filter((reservation) =>
            [
              reservation.guestName,
              reservation.bookingCode,
              reservation.roomNumber,
              reservation.guestPhone,
            ]
              .filter((field): field is string => field !== null)
              .some((field) => field.toLowerCase().includes(needle)),
          );

    return {
      property: {
        id: property.id as PropertyId,
        code: property.code,
        name: property.name,
        slug: property.slug,
        timezone: property.timezone,
        currency: property.currency,
        businessDate: toBusinessDate(property.businessDate),
        checkInTime: property.checkInTime,
        checkOutTime: property.checkOutTime,
      },
      targetDate,
      metrics: counts,
      activeMetric: query.metric as DashboardMetric,
      reservations,
      resultCount: reservations.length,
      availability: this.toAvailability(inventoryRows),
      alerts: this.toAlerts(gateways, targetDate),
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Mapping                                                              */
  /* ---------------------------------------------------------------------- */

  private toDashboardReservation(
    row: ReservationRow,
    targetDate: BusinessDate,
    propertyCheckInTime: string,
    propertyCheckOutTime: string,
  ): DashboardReservation {
    // A reservation may hold several rooms; the dashboard card shows the first
    // assigned one. The full set belongs on the reservation detail screen, not
    // squeezed into a feed row.
    const primary = row.rooms[0];

    const arrival = toBusinessDate(row.arrivalDate);
    const departure = toBusinessDate(row.departureDate);

    return {
      id: row.id,
      bookingCode: row.confirmationCode,
      roomNumber: primary?.room?.number ?? null,
      roomTypeId: (primary?.roomTypeId ?? '') as RoomTypeId,
      roomTypeName: primary?.roomType.name ?? 'Unassigned',
      // Composed here rather than stored as one column, so the parts stay
      // separately searchable and sortable.
      guestName: `${row.guestFirstName} ${row.guestLastName}`.trim(),
      guestPhone: row.guestPhone,
      guestEmail: row.guestEmail,
      checkInDate: arrival,
      checkInTime: propertyCheckInTime,
      checkOutDate: departure,
      checkOutTime: propertyCheckOutTime,
      nights: nightsBetween(row.arrivalDate, row.departureDate),
      mealPlan: row.mealPlan,
      adults: row.adults,
      children: row.children,
      status: row.status,
      subStatus: subStatusFor(row.status, arrival, departure, targetDate),
      totalAmountMinor: row.totalAmountMinor,
      paidAmountMinor: row.paidAmountMinor,
      // Derived, never stored: one number computed from two, rather than three
      // numbers free to drift apart (CLAUDE.md section 3.4).
      balanceAmountMinor: row.totalAmountMinor - row.paidAmountMinor,
      currency: row.currency,
      isMagicLinkActive: row.isMagicLinkActive,
      bookedAt: row.createdAt.toISOString(),
    };
  }

  private toAvailability(rows: readonly InventoryRow[]): AvailabilityBreakdown {
    const mapped = rows.map((row) => ({
      roomTypeId: row.roomTypeId as RoomTypeId,
      code: row.roomType.code,
      name: row.roomType.name,
      physical: row.physical,
      sold: row.sold,
      blocked: row.blocked,
      // Floored at zero for display only. A negative value would mean the
      // oversell CHECK had been bypassed, which it cannot be — but showing
      // "-1 available" to a clerk helps nobody either way.
      availableCount: Math.max(
        0,
        row.physical + row.overbookingAllowance - row.sold - row.blocked,
      ),
      baseRateMinor: row.roomType.baseRateMinor,
      currency: row.roomType.currency,
    }));

    return {
      rows: mapped,
      totalAvailableRooms: mapped.reduce((sum, row) => sum + row.availableCount, 0),
      totalPhysicalRooms: mapped.reduce((sum, row) => sum + row.physical, 0),
    };
  }

  /**
   * Operational alerts.
   *
   * Only derived from state the server can see. The copy and the link are
   * written here, never read out of a database column and rendered — an
   * operator-editable href that lands in an anchor is a stored-XSS vector.
   */
  private toAlerts(
    gateways: readonly { provider: string; status: string; onboardingDueDate: Date | null }[],
    targetDate: BusinessDate,
  ): SystemAlert[] {
    const alerts: SystemAlert[] = [];

    for (const gateway of gateways) {
      if (gateway.status !== 'PENDING_KYC') continue;

      const overdue =
        gateway.onboardingDueDate !== null &&
        toBusinessDate(gateway.onboardingDueDate) < targetDate;

      const providerLabel =
        gateway.provider.charAt(0) + gateway.provider.slice(1).toLowerCase();

      alerts.push({
        id: `gateway-${gateway.provider.toLowerCase()}`,
        severity: overdue ? 'OVERDUE' : 'WARNING',
        title: `Complete ${providerLabel} onboarding`,
        body:
          `Under RBI guidelines every payment aggregator must complete KYC ` +
          `verification before a merchant can accept card payments. Until ` +
          `${providerLabel} onboarding is finished this property cannot take ` +
          `online payments, and guest balances must be settled at the desk.`,
        actionLabel: `Review ${providerLabel}'s account opening guidelines to get started.`,
        actionHref:
          gateway.provider === 'RAZORPAY'
            ? 'https://razorpay.com/docs/payments/easy-create-account/'
            : null,
      });
    }

    return alerts;
  }
}

/**
 * Where a stay sits relative to the day being viewed.
 *
 * Pure and exported-adjacent on purpose: it is the one piece of real logic on
 * this screen, and it is a function of (status, arrival, departure, today) with
 * no I/O — which is what makes it testable without a database.
 */
function subStatusFor(
  status: ReservationStatus,
  arrival: BusinessDate,
  departure: BusinessDate,
  today: BusinessDate,
): ReservationSubStatus | null {
  if (status === ReservationStatus.CHECKED_IN) {
    if (departure < today) return 'OVERSTAY';
    if (departure === today) return 'PENDING_DEPARTURE';
    return null;
  }

  if (status === ReservationStatus.CONFIRMED) {
    if (arrival < today) return 'OVERDUE_ARRIVAL';
    if (arrival === today) return 'ARRIVING_TODAY';
    return null;
  }

  return null;
}
