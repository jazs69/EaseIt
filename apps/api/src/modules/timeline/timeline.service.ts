/**
 * Timeline calendar application service.
 *
 * Owns the grid arithmetic: which column a stay starts in, how many it spans,
 * and how the rollup rows above and below are computed. All of it derived per
 * request — these are functions of (window, inventory, bookings), so a cached
 * copy would be wrong as soon as the window moved.
 */

import { Injectable } from '@nestjs/common';
import {
  ReservationStatus,
  TIMELINE,
  currentDateInTimeZone,
  TIMEFRAME_DAYS,
  type BlockColour,
  type BusinessDate,
  type ColumnKind,
  type MealPlan,
  type PropertyId,
  type ReservationSubStatus,
  type RoomId,
  type RoomTypeId,
  type TimelineBlock,
  type TimelineCalendar,
  type TimelineCalendarQuery,
  type TimelineCategory,
  type TimelineColumn,
  type TimelineDailyTotal,
  type TimelineRoom,
  type TimelineTimeframe,
} from '@repo/types';

import { TenantScopeViolationError } from '../../common/errors/domain-error.js';
import { ClockService } from '../platform/clock.service.js';
import {
  TimelineRepository,
  type TimelineInventoryRow,
  type TimelineStayRow,
} from './timeline.repository.js';

const DAY_MS = 86_400_000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Housekeeping states that mean the room needs attention. */
const DIRTY_STATUSES = new Set(['VACANT_DIRTY', 'OCCUPIED_DIRTY']);

function toBusinessDate(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `"14:35"` -> 875 minutes from midnight. */
function minutesFromWallClock(wallClock: string): number {
  const [hour = '0', minute = '0'] = wallClock.split(':');
  const parsed = Number(hour) * 60 + Number(minute);
  return Number.isNaN(parsed) ? 0 : Math.max(0, Math.min(parsed, TIMELINE.MINUTES_PER_DAY));
}

/**
 * Narrowest a day-axis block may render, in column units.
 *
 * Only reached by a degenerate stay — a same-day booking, or a property whose
 * check-out time is not before its check-in time. Such a block would otherwise
 * compute to zero or negative width and vanish, which hides the very booking
 * somebody needs to go and fix.
 */
const MIN_BLOCK_UNITS = 0.08;

/** The geometry half of a block, shared by the day and hour coordinate systems. */
interface BlockGeometry {
  gridStartIndex: number;
  gridSpan: number;
  leadFraction: number;
  trailFraction: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Guards `0/0`, which is NaN and serialises to null, failing validation. */
function percentage(part: number, total: number): number {
  return total === 0 ? 0 : round1((part / total) * 100);
}

/** Colour band per status, so every surface agrees on what each one looks like. */
function colourFor(status: ReservationStatus): BlockColour {
  switch (status) {
    case ReservationStatus.CHECKED_IN:
      return 'emerald';
    case ReservationStatus.CONFIRMED:
    case ReservationStatus.TENTATIVE:
      return 'amber';
    case ReservationStatus.CHECKED_OUT:
      return 'zinc';
    case ReservationStatus.ON_HOLD:
      return 'slate';
    case ReservationStatus.CANCELLED:
    case ReservationStatus.NO_SHOW:
    default:
      return 'rose';
  }
}

/**
 * Where a stay sits relative to the business date.
 *
 * The same rule as the operations dashboard, kept identical on purpose: a stay
 * must not read "pending departure" on one screen and nothing on another.
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

@Injectable()
export class TimelineService {
  constructor(
    private readonly repository: TimelineRepository,
    private readonly clock: ClockService,
  ) {}

  async timeline(
    userId: string,
    hotelId: string,
    query: TimelineCalendarQuery,
  ): Promise<TimelineCalendar> {
    const property = await this.repository.findGrantedProperty(userId, hotelId);
    if (property === null) {
      throw new TenantScopeViolationError('Property');
    }

    const businessDate = toBusinessDate(property.businessDate);

    /**
     * Today, at the property — not on the server, and not in the browser.
     *
     * ===========================================================================
     * **The grid anchors to the calendar date, the books anchor to the business
     * date, and they are not the same thing.**
     *
     * This used to default the window to `businessDate`, which is wrong for a
     * grid: the business date is a ledger position advanced only by night audit
     * step 7 (CLAUDE.md section 3.3). Until an audit runs it stays where it was,
     * so a property whose audit has not run for two nights opened its calendar
     * on a column two days in the past, and the live marker sat on that stale
     * column — which is exactly the mismatch this fixes.
     *
     * It is computed from the property's IANA timezone through the injected
     * clock, matching `calendar.service.ts`, which already did this correctly.
     * The two alternatives are both bugs: the server's own date is wrong for
     * nine of ten properties, and the browser's `startOfToday()` is wrong for
     * any clerk whose machine is not set to the hotel's timezone — and is a
     * hydration mismatch besides, since the server would render a different day.
     *
     * `businessDate` is still what every posting and sub-status reads. The gap
     * between the two is surfaced rather than hidden: it means an audit is
     * overdue, and that is an operational alarm, not a rendering detail.
     * ===========================================================================
     */
    const propertyToday = currentDateInTimeZone(property.timezone, this.clock.now());
    const startDate = query.startDate ?? propertyToday;
    const windowStart = toUtcMidnight(startDate);
    // The *calendar* span, which is 1 for Day view even though it renders 24
    // columns. Every database query below works in dates, not columns.
    const days = TIMEFRAME_DAYS[query.timeframe];
    const windowEnd = addDays(windowStart, days - 1);
    const windowEndExclusive = addDays(windowStart, days);

    const filter = {
      ...(query.roomTypeId === undefined ? {} : { roomTypeId: query.roomTypeId }),
      ...(query.floor === undefined ? {} : { floor: query.floor }),
      housekeeping: query.housekeeping,
    };

    const [rooms, stays, inventory, unassigned, roomTypes, floors, adrStays] =
      await Promise.all([
        this.repository.findRooms(property.id, filter),
        /**
         * Departures on the first visible date are included on every axis.
         *
         * This used to be `query.timeframe === 'day'`, on the reasoning that
         * only an hourly axis could render a departure morning. Now that a day
         * column is drawn from check-in to check-out rather than edge to edge,
         * every axis renders it — and without this, opening the calendar *on*
         * a date hid the guest who checks out that morning, which is the one
         * stay the front desk most needs to see.
         *
         * The occupancy strip is unaffected: `findInventory` counts sold
         * room-nights per stay date, where a departure date is correctly not
         * one (CLAUDE.md section 3.1 — departure day is exclusive, so the room
         * is sellable that night).
         */
        this.repository.findOverlappingStays(
          property.id,
          windowStart,
          windowEndExclusive,
          true,
        ),
        this.repository.findInventory(property.id, windowStart, windowEnd),
        this.repository.findUnassignedStays(property.id, windowStart, windowEndExclusive),
        this.repository.findRoomTypes(property.id),
        this.repository.findFloors(property.id),
        this.repository.findStaysForAdr(property.id, windowStart, windowEndExclusive),
      ]);

    /* -- Column axis ----------------------------------------------------- */

    const { columns, columnKind } = this.buildColumns(
      query.timeframe,
      windowStart,
      days,
      propertyToday,
    );

    // In Day view every column shares one date, so "which column is today" is
    // 0 or -1; the live marker derives the intra-day offset itself.
    const todayIndex =
      columnKind === 'hour'
        ? startDate === propertyToday
          ? 0
          : -1
        : columns.findIndex((column) => column.isToday);

    /* -- Blocks ---------------------------------------------------------- */

    const byRoom = new Map<string, TimelineBlock[]>();
    for (const stay of stays) {
      if (stay.roomId === null) continue;
      const block = this.toBlock(
        stay,
        windowStart,
        columnKind,
        columns.length,
        businessDate,
        property,
      );
      const existing = byRoom.get(stay.roomId) ?? [];
      existing.push(block);
      byRoom.set(stay.roomId, existing);
    }

    const timelineRooms: TimelineRoom[] = rooms.map((room) => ({
      id: room.id as RoomId,
      roomNumber: room.number,
      floor: room.floor,
      roomTypeId: room.roomTypeId as RoomTypeId,
      roomTypeName: room.roomType.name,
      roomTypeCode: room.roomType.code,
      housekeepingStatus: room.status,
      needsCleaning: DIRTY_STATUSES.has(room.status),
      isSellable: room.status !== 'OUT_OF_ORDER',
      blocks: byRoom.get(room.id) ?? [],
    }));

    /* -- Rollups --------------------------------------------------------- */

    const dailySummary = this.buildDailyTotals(inventory, windowStart, days);

    const inventoryByType = new Map<string, TimelineInventoryRow[]>();
    for (const row of inventory) {
      const list = inventoryByType.get(row.roomTypeId) ?? [];
      list.push(row);
      inventoryByType.set(row.roomTypeId, list);
    }

    // Only categories with rooms still visible after filtering, so the
    // accordion never renders an empty group.
    const visibleTypeIds = new Set(rooms.map((room) => room.roomTypeId));
    const categories: TimelineCategory[] = roomTypes
      .filter((type) => visibleTypeIds.has(type.id))
      .map((type) => ({
        id: type.id as RoomTypeId,
        code: type.code,
        name: type.name,
        inventory: rooms.filter((room) => room.roomTypeId === type.id).length,
        baseRateMinor: type.baseRateMinor,
        currency: property.currency,
        dailyAvailable: this.buildDailyTotals(
          inventoryByType.get(type.id) ?? [],
          windowStart,
          days,
        ),
        roomIds: rooms
          .filter((room) => room.roomTypeId === type.id)
          .map((room) => room.id as RoomId),
      }));

    /* -- Window aggregates ----------------------------------------------- */

    const totalSold = inventory.reduce((sum, row) => sum + row.sold, 0);
    const totalPhysical = inventory.reduce((sum, row) => sum + row.physical, 0);
    const { revenueMinor, roomNights } = this.windowRevenue(adrStays, windowStart, days);

    const sellableRooms = rooms.filter((room) => room.status !== 'OUT_OF_ORDER').length;

    return {
      property: {
        id: property.id as PropertyId,
        code: property.code,
        name: property.name,
        slug: property.slug,
        currency: property.currency,
        timezone: property.timezone,
        today: propertyToday,
        businessDate,
        checkInTime: property.checkInTime,
        checkOutTime: property.checkOutTime,
        totalRooms: sellableRooms,
        totalRoomsIncludingOutOfOrder: rooms.length,
        averageRateMinor: roomNights === 0 ? null : Math.round(revenueMinor / roomNights),
        averageOccupancy: percentage(totalSold, totalPhysical),
      },
      columns,
      columnKind,
      timeframe: query.timeframe,
      windowStart: startDate,
      windowEnd: toBusinessDate(windowEnd),
      todayIndex,
      dailySummary,
      categories,
      rooms: timelineRooms,
      unassigned: unassigned.map((stay) =>
        this.toBlock(stay, windowStart, columnKind, columns.length, businessDate, property),
      ),
      unassignedCount: unassigned.length,
      viewMode: query.viewMode,
      // Numeric-aware, so floor 2 precedes floor 11. A plain string sort — what
      // the database gives back — orders them 1, 11, 12, 2, which reads as a
      // bug in the filter menu.
      availableFloors: [...floors].sort((a, b) => {
        const left = Number(a);
        const right = Number(b);
        if (Number.isNaN(left) || Number.isNaN(right)) return a.localeCompare(b);
        return left - right;
      }),
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Column axis                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Builds the column axis for a timeframe.
   *
   * ===========================================================================
   * Two kinds of column, one array.
   *
   * Day view divides a single date into 24 hour columns; the others lay out N
   * dates. Returning both shapes through one `columns` array with a
   * `columnKind` tag means the grid renders one loop rather than branching on
   * timeframe, and block placement below works in "column units" without
   * caring what a unit represents.
   *
   * Labels are formatted here, not in the client. A month column wants a bare
   * date number above a single weekday letter, a week column wants
   * `Fri / Oct 16 / 2026`, an hour column wants `09:00` — three different
   * shapes that every client would otherwise reimplement, and disagree on.
   * ===========================================================================
   */
  private buildColumns(
    timeframe: TimelineTimeframe,
    windowStart: Date,
    days: number,
    /** The calendar date at the property, not its business date. */
    today: BusinessDate,
  ): { columns: TimelineColumn[]; columnKind: ColumnKind } {
    if (timeframe === 'day') {
      const date = toBusinessDate(windowStart);
      const isToday = date === today;

      return {
        columnKind: 'hour',
        columns: Array.from({ length: TIMELINE.HOURS_PER_DAY }, (_, hour) => ({
          key: `${date}T${String(hour).padStart(2, '0')}`,
          date,
          hour,
          primaryLabel: `${String(hour).padStart(2, '0')}:00`,
          secondaryLabel: null,
          tertiaryLabel: null,
          // Every hour column of today is "today" — the live marker uses the
          // minute offset below to place itself inside the right one.
          isToday,
          isWeekend: windowStart.getUTCDay() === 0 || windowStart.getUTCDay() === 6,
          startsMonth: false,
        })),
      };
    }

    const compact = timeframe === 'month';

    return {
      columnKind: 'day',
      columns: Array.from({ length: days }, (_, offset) => {
        const value = addDays(windowStart, offset);
        const date = toBusinessDate(value);
        const weekday = value.getUTCDay();
        const dayName = DAY_NAMES[weekday] ?? '';

        return {
          key: date,
          date,
          hour: null,
          // Month view is ~40px wide, so it gets the bare date number with a
          // single weekday letter beneath; anything longer truncates to noise.
          primaryLabel: compact
            ? value.getUTCDate() === 1
              ? `${MONTHS[value.getUTCMonth()] ?? ''} 1`
              : String(value.getUTCDate())
            : `${MONTHS[value.getUTCMonth()] ?? ''} ${String(value.getUTCDate()).padStart(2, '0')}`,
          secondaryLabel: compact ? (dayName[0] ?? '') : dayName,
          tertiaryLabel: compact ? null : String(value.getUTCFullYear()),
          isToday: date === today,
          isWeekend: weekday === 0 || weekday === 6,
          startsMonth: value.getUTCDate() === 1,
        };
      }),
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Block placement                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Positions one stay on the grid.
   *
   * ===========================================================================
   * Two coordinate systems, one method.
   *
   * **Day columns** (week / 10-day / month). A stay is half-open: arrival
   * inclusive, departure exclusive. A booking from the 16th to the 18th
   * occupies **two** columns, not three — the room is free again on the 18th
   * and sellable that night. Using an inclusive span is the single most common
   * bug in a calendar grid, and it makes every block one column too wide,
   * which then disagrees with the availability footer underneath it.
   *
   * **Hour columns** (Day view). The stay is clipped to the viewed date and
   * mapped onto minutes. A guest who checked in at 14:35 starts 35/60 of the
   * way through the 14:00 column, which is what `leadFraction` carries — an
   * hourly view that snapped to whole hours would just be a chunkier day view.
   * Where no real `checkedInAt` exists the property's standard desk time is
   * used instead, and `hasExactTimes` records that so the UI does not imply a
   * precision it does not have.
   *
   * Both ends are clamped to the window, and `continuesBefore` /
   * `continuesAfter` record that the real stay extends past the edge so the UI
   * can draw a torn edge rather than implying the guest arrives here.
   * ===========================================================================
   */
  private toBlock(
    stay: TimelineStayRow,
    windowStart: Date,
    columnKind: ColumnKind,
    columnCount: number,
    businessDate: BusinessDate,
    property: { checkInTime: string; checkOutTime: string },
  ): TimelineBlock {
    const { reservation } = stay;
    const arrivalDate = toBusinessDate(stay.arrivalDate);
    const departureDate = toBusinessDate(stay.departureDate);
    const nights = Math.max(
      1,
      Math.round((stay.departureDate.getTime() - stay.arrivalDate.getTime()) / DAY_MS),
    );

    const hasExactTimes =
      reservation.checkedInAt !== null || reservation.checkedOutAt !== null;

    const geometry =
      columnKind === 'hour'
        ? this.hourGeometry(stay, windowStart, property)
        : this.dayGeometry(stay, windowStart, columnCount, property);

    return {
      id: reservation.id,
      bookingCode: reservation.confirmationCode,
      roomTypeId: stay.roomTypeId,
      guestName: `${reservation.guestFirstName} ${reservation.guestLastName}`.trim(),
      guestPhone: reservation.guestPhone,
      guestEmail: reservation.guestEmail,
      startDate: arrivalDate,
      endDate: departureDate,
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
      nights,
      checkedInAt: reservation.checkedInAt?.toISOString() ?? null,
      checkedOutAt: reservation.checkedOutAt?.toISOString() ?? null,
      hasExactTimes,
      ...geometry,
      status: stay.status,
      subStatus: subStatusFor(stay.status, arrivalDate, departureDate, businessDate),
      colourVariant: colourFor(stay.status),
      mealPlan: reservation.mealPlan as MealPlan,
      adults: reservation.adults,
      children: reservation.children,
      totalAmountMinor: reservation.totalAmountMinor,
      paidAmountMinor: reservation.paidAmountMinor,
      // Derived, never stored (CLAUDE.md section 3.4).
      balanceAmountMinor: reservation.totalAmountMinor - reservation.paidAmountMinor,
      currency: reservation.currency,
      isMagicLinkActive: reservation.isMagicLinkActive,
    };
  }

  /**
   * Placement across date columns.
   *
   * ===========================================================================
   * **A stay occupies the desk's hours, not whole calendar squares.**
   *
   * This used to snap blocks to column boundaries, so a one-night stay filled
   * its arrival column from edge to edge and stopped dead at midnight. Both
   * ends of that are operationally wrong:
   *
   *   * The room is not occupied from midnight on the arrival date. It is let
   *     at the property's check-in time, and before that it is being cleaned
   *     or is simply free.
   *   * The room *is* still occupied on the departure morning, until the
   *     check-out time. A block that ends at midnight claims the room is free
   *     from 00:00, which is when the front desk double-sells it.
   *
   * So the stay is measured in **column units** — whole columns plus a
   * fraction — from check-in on the arrival date to check-out on the departure
   * date, and the fractions are handed to the client as `leadFraction` and
   * `trailFraction`. The client already insets the block by those percentages,
   * which is how the hour view has always placed a 14:35 arrival.
   *
   * What this buys, beyond looking right: **back-to-back stays stop
   * colliding.** A departure and an arrival on the same date now share that
   * column with a visible gap between check-out and check-in — the
   * housekeeping turnaround. The two blocks' grid items overlap, which CSS
   * grid permits, and their absolutely-positioned buttons do not.
   *
   * The times come from the property, never from a constant. These hotels
   * check in at 14:00, not the 12:00 a generic PMS assumes, and the drawer
   * already shows that; a hardcoded midday here would quietly disagree with
   * both the configuration and the stay detail beside it.
   *
   * Desk times rather than recorded arrival instants, deliberately: a column
   * here is a whole day, so a guest who arrived at 15:10 instead of 14:00
   * would move the block by 0.8% of a column — invisible, and it would make
   * the row disagree with the rest of its own date axis. The hour view, where
   * that difference is a whole column, does use the recorded instants.
   * ===========================================================================
   */
  private dayGeometry(
    stay: TimelineStayRow,
    windowStart: Date,
    columnCount: number,
    property: { checkInTime: string; checkOutTime: string },
  ): BlockGeometry {
    const windowStartMs = windowStart.getTime();
    const arrivalOffset = Math.round((stay.arrivalDate.getTime() - windowStartMs) / DAY_MS);
    const departureOffset = Math.round(
      (stay.departureDate.getTime() - windowStartMs) / DAY_MS,
    );

    const checkInFraction =
      minutesFromWallClock(property.checkInTime) / TIMELINE.MINUTES_PER_DAY;
    const checkOutFraction =
      minutesFromWallClock(property.checkOutTime) / TIMELINE.MINUTES_PER_DAY;

    // Column units from the window's left edge.
    const rawStart = arrivalOffset + checkInFraction;
    const rawEnd = departureOffset + checkOutFraction;

    const continuesBefore = rawStart < 0;
    const continuesAfter = rawEnd > columnCount;

    // Clamped to the window, then widened to a minimum so that a day-use
    // booking, or a property configured to check out after it checks in,
    // still renders something a clerk can click rather than a zero-width
    // block that silently disappears.
    let start = Math.min(Math.max(rawStart, 0), columnCount - MIN_BLOCK_UNITS);
    let end = Math.max(Math.min(rawEnd, columnCount), start + MIN_BLOCK_UNITS);
    if (end > columnCount) {
      end = columnCount;
      start = Math.max(0, end - MIN_BLOCK_UNITS);
    }

    // The columns the block touches. `ceil(end) - 1` is the last one it enters
    // at all: a stay ending exactly on a boundary does not reach into the
    // column after it.
    const gridStartIndex = Math.min(Math.floor(start), columnCount - 1);
    const lastIndex = Math.min(
      Math.max(Math.ceil(end) - 1, gridStartIndex),
      columnCount - 1,
    );

    return {
      gridStartIndex,
      gridSpan: lastIndex - gridStartIndex + 1,
      // Unused slivers at each end of the spanned columns.
      leadFraction: start - gridStartIndex,
      trailFraction: lastIndex + 1 - end,
      continuesBefore,
      continuesAfter,
    };
  }

  /** Placement across the 24 hour columns of one date. */
  private hourGeometry(
    stay: TimelineStayRow,
    viewedDay: Date,
    property: { checkInTime: string; checkOutTime: string },
  ): BlockGeometry {
    const dayStartMs = viewedDay.getTime();
    const dayEndMs = dayStartMs + DAY_MS;

    // Where the stay starts, in minutes from midnight of the viewed day.
    //
    // Three cases: the guest checked in on this day at a known instant; the
    // booked arrival falls on this day, so the property's desk time applies;
    // or the stay began earlier and already occupies midnight.
    const startMs = (() => {
      if (
        stay.reservation.checkedInAt !== null &&
        stay.reservation.checkedInAt.getTime() >= dayStartMs &&
        stay.reservation.checkedInAt.getTime() < dayEndMs
      ) {
        return stay.reservation.checkedInAt.getTime();
      }
      if (stay.arrivalDate.getTime() === dayStartMs) {
        return dayStartMs + minutesFromWallClock(property.checkInTime) * 60_000;
      }
      return dayStartMs;
    })();

    const endMs = (() => {
      if (
        stay.reservation.checkedOutAt !== null &&
        stay.reservation.checkedOutAt.getTime() > dayStartMs &&
        stay.reservation.checkedOutAt.getTime() <= dayEndMs
      ) {
        return stay.reservation.checkedOutAt.getTime();
      }
      if (stay.departureDate.getTime() === dayStartMs + DAY_MS) {
        // Departure day: the block ends at the desk's check-out time.
        return dayStartMs + DAY_MS;
      }
      if (stay.departureDate.getTime() === dayStartMs) {
        return dayStartMs + minutesFromWallClock(property.checkOutTime) * 60_000;
      }
      return dayEndMs;
    })();

    const clampedStart = Math.max(dayStartMs, Math.min(startMs, dayEndMs));
    const clampedEnd = Math.max(clampedStart, Math.min(endMs, dayEndMs));

    const startMinutes = (clampedStart - dayStartMs) / 60_000;
    const endMinutes = (clampedEnd - dayStartMs) / 60_000;

    const startColumn = Math.floor(startMinutes / 60);
    // An end exactly on the hour belongs to the previous column, not the next:
    // a stay ending at 11:00 fills the 10:00 column and none of the 11:00 one.
    const endColumnExclusive = Math.max(startColumn + 1, Math.ceil(endMinutes / 60));

    return {
      gridStartIndex: Math.min(startColumn, TIMELINE.HOURS_PER_DAY - 1),
      gridSpan: Math.min(
        endColumnExclusive - startColumn,
        TIMELINE.HOURS_PER_DAY - startColumn,
      ),
      // Offsets inside the first and last columns, so 14:35 does not render at
      // the left edge of the 14:00 slot.
      leadFraction: (startMinutes % 60) / 60,
      trailFraction: endMinutes % 60 === 0 ? 0 : 1 - (endMinutes % 60) / 60,
      continuesBefore: stay.arrivalDate.getTime() < dayStartMs,
      continuesAfter: stay.departureDate.getTime() > dayEndMs,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Rollups                                                              */
  /* ---------------------------------------------------------------------- */

  private buildDailyTotals(
    inventory: readonly TimelineInventoryRow[],
    windowStart: Date,
    days: number,
  ): TimelineDailyTotal[] {
    // Bucketed once so the loop is O(days), not O(days × rows).
    const byDate = new Map<
      string,
      { sold: number; blocked: number; physical: number; allowance: number }
    >();

    for (const row of inventory) {
      const key = toBusinessDate(row.stayDate);
      const bucket = byDate.get(key) ?? { sold: 0, blocked: 0, physical: 0, allowance: 0 };
      bucket.sold += row.sold;
      bucket.blocked += row.blocked;
      bucket.physical += row.physical;
      bucket.allowance += row.overbookingAllowance;
      byDate.set(key, bucket);
    }

    return Array.from({ length: days }, (_, offset) => {
      const date = toBusinessDate(addDays(windowStart, offset));
      const bucket = byDate.get(date) ?? { sold: 0, blocked: 0, physical: 0, allowance: 0 };

      return {
        date,
        sold: bucket.sold,
        blocked: bucket.blocked,
        total: bucket.physical,
        // Floored at zero for display. A negative would mean the oversell
        // CHECK had been bypassed, which it cannot be — but "-1 available"
        // helps nobody either way.
        available: Math.max(
          0,
          bucket.physical + bucket.allowance - bucket.sold - bucket.blocked,
        ),
        occupancyPercentage: percentage(bucket.sold, bucket.physical),
      };
    });
  }

  /**
   * Revenue and room-nights inside the window, for ADR.
   *
   * A stay's total covers its whole duration, which may run past both edges,
   * so the total is spread evenly across the stay's own nights and only the
   * nights inside the window are counted. That assumes a flat nightly rate —
   * an approximation that disappears once the `rates` module can say what each
   * individual night was actually sold for. Rounded once at the end, so the
   * error does not accumulate across a long window (section 3.4).
   */
  private windowRevenue(
    stays: readonly { arrivalDate: Date; departureDate: Date; totalAmountMinor: number }[],
    windowStart: Date,
    days: number,
  ): { revenueMinor: number; roomNights: number } {
    const windowStartMs = windowStart.getTime();
    const windowEndExclusiveMs = addDays(windowStart, days).getTime();

    let revenueMinor = 0;
    let roomNights = 0;

    for (const stay of stays) {
      const arrival = stay.arrivalDate.getTime();
      const departure = stay.departureDate.getTime();
      const stayNights = Math.max(1, Math.round((departure - arrival) / DAY_MS));
      const nightly = stay.totalAmountMinor / stayNights;

      const overlapStart = Math.max(arrival, windowStartMs);
      const overlapEnd = Math.min(departure, windowEndExclusiveMs);
      const nightsInWindow = Math.max(0, Math.round((overlapEnd - overlapStart) / DAY_MS));
      if (nightsInWindow === 0) continue;

      roomNights += nightsInWindow;
      revenueMinor += nightly * nightsInWindow;
    }

    return { revenueMinor: Math.round(revenueMinor), roomNights };
  }
}
