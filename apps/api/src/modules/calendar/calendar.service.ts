/**
 * Group reservation calendar: occupancy across the portfolio over a window.
 *
 * All arithmetic lives here and none of it is stored. Occupancy, ADR and the
 * trend are functions of (inventory, bookings, window), so caching any of them
 * would create a number that can disagree with the rows it came from.
 */

import { Injectable } from '@nestjs/common';
import {
  CALENDAR_WINDOW,
  currentDateInTimeZone,
  type BusinessDate,
  type DailyOccupancyItem,
  type GroupCalendarQuery,
  type GroupCalendarResponse,
  type PropertyCalendarSummary,
  type PropertyId,
} from '@repo/types';

import { ClockService } from '../platform/clock.service.js';
import {
  CalendarRepository,
  type GrantedPropertyRow,
  type InventoryDayRow,
  type StayRow,
} from './calendar.repository.js';

const DAY_MS = 86_400_000;
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MONTH_NAMES = [
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

function toBusinessDate(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** One decimal place, so 1.0% and 1.04% do not both render as "1%". */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Percentage, guarding division by zero.
 *
 * A property with no room types has `total === 0`, and `0/0` is NaN — which
 * serialises to `null` in JSON and then fails schema validation at the client.
 * Returning 0 is both valid and honest: nothing is occupied because nothing
 * exists to occupy.
 */
function percentage(part: number, total: number): number {
  return total === 0 ? 0 : round1((part / total) * 100);
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly repository: CalendarRepository,
    private readonly clock: ClockService,
  ) {}

  async groupCalendar(
    userId: string,
    query: GroupCalendarQuery,
  ): Promise<GroupCalendarResponse> {
    const requestedIds =
      query.propertyIds
        ?.split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0) ?? undefined;

    const properties = await this.repository.findGrantedProperties(userId, requestedIds);

    // The clock the window is measured against.
    //
    // A portfolio can span zones (Asia/Kolkata and Asia/Colombo here), so
    // "today" is not a single fact. The first property alphabetically is the
    // reference, and the response says which one it was — an arbitrary but
    // *stated* choice beats a silent one, and the UI can show the zone rather
    // than implying the viewer's own.
    const reference = properties[0] ?? null;
    const referenceTimezone = reference?.timezone ?? 'Asia/Kolkata';
    const referenceToday =
      reference === null
        ? currentDateInTimeZone(referenceTimezone, this.clock.now())
        : toBusinessDate(reference.businessDate);

    const { startDate, endDate, totalDays } = this.resolveWindow(query, referenceToday);

    const propertyIds = properties.map((property) => property.id);
    const startValue = toUtcMidnight(startDate);
    const endValue = toUtcMidnight(endDate);

    const [inventory, roomCounts, stays, withRoomTypes] = await Promise.all([
      this.repository.findInventory(propertyIds, startValue, endValue),
      this.repository.countRoomsByProperty(propertyIds),
      this.repository.findOverlappingStays(propertyIds, startValue, addDays(endValue, 1)),
      this.repository.findPropertiesWithRoomTypes(propertyIds),
    ]);

    const dailyOccupancy = this.buildDailyOccupancy(
      inventory,
      startValue,
      totalDays,
      referenceToday,
    );

    const propertySummaries = properties.map((property) =>
      this.buildPropertySummary(
        property,
        inventory,
        stays,
        roomCounts.get(property.id) ?? 0,
        withRoomTypes.has(property.id),
        startValue,
        totalDays,
      ),
    );

    // Weighted across the whole window, not a mean of daily percentages — see
    // the note on `averageOccupancy` in the DTO.
    const totalSold = inventory.reduce((sum, row) => sum + row.sold, 0);
    const totalPhysical = inventory.reduce((sum, row) => sum + row.physical, 0);
    const averageOccupancy = percentage(totalSold, totalPhysical);
    const firstDayOccupancy = dailyOccupancy[0]?.occupancyPercentage ?? 0;

    return {
      dateRange: { startDate, endDate, totalDays },
      metrics: {
        averageOccupancy,
        occupancyTrend: round1(averageOccupancy - firstDayOccupancy),
        propertiesCount: properties.length,
        propertiesWithInventoryCount: withRoomTypes.size,
      },
      dailyOccupancy,
      properties: propertySummaries,
      reference: {
        propertyId: (reference?.id ?? null) as PropertyId | null,
        timezone: referenceTimezone,
        businessDate: referenceToday,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Window                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolves the window, clamped.
   *
   * `MAX_DAYS` is not politeness: `endDate` arrives from a query string, and
   * without a ceiling a request for a ten-year window would ask Postgres for
   * millions of inventory rows and build an array to match. The cap turns a
   * denial-of-service into a truncated answer.
   */
  private resolveWindow(
    query: GroupCalendarQuery,
    referenceToday: BusinessDate,
  ): { startDate: BusinessDate; endDate: BusinessDate; totalDays: number } {
    const startDate = query.startDate ?? referenceToday;
    const startValue = toUtcMidnight(startDate);

    if (query.endDate === undefined) {
      const endValue = addDays(startValue, CALENDAR_WINDOW.DEFAULT_DAYS - 1);
      return {
        startDate,
        endDate: toBusinessDate(endValue),
        totalDays: CALENDAR_WINDOW.DEFAULT_DAYS,
      };
    }

    const requestedEnd = toUtcMidnight(query.endDate);
    const requestedDays =
      Math.round((requestedEnd.getTime() - startValue.getTime()) / DAY_MS) + 1;
    const totalDays = Math.min(Math.max(1, requestedDays), CALENDAR_WINDOW.MAX_DAYS);

    return {
      startDate,
      endDate: toBusinessDate(addDays(startValue, totalDays - 1)),
      totalDays,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Daily strip                                                          */
  /* ---------------------------------------------------------------------- */

  private buildDailyOccupancy(
    inventory: readonly InventoryDayRow[],
    startValue: Date,
    totalDays: number,
    referenceToday: BusinessDate,
  ): DailyOccupancyItem[] {
    // Bucketed once, so the loop below is O(days) rather than O(days × rows).
    const byDate = new Map<string, { sold: number; physical: number }>();
    for (const row of inventory) {
      const key = toBusinessDate(row.stayDate);
      const bucket = byDate.get(key) ?? { sold: 0, physical: 0 };
      bucket.sold += row.sold;
      bucket.physical += row.physical;
      byDate.set(key, bucket);
    }

    return Array.from({ length: totalDays }, (_, offset) => {
      const dayValue = addDays(startValue, offset);
      const date = toBusinessDate(dayValue);
      const bucket = byDate.get(date) ?? { sold: 0, physical: 0 };

      return {
        date,
        // From the UTC-midnight value, so the weekday matches the calendar
        // date rather than the server's local interpretation of it.
        dayOfWeek: DAY_NAMES[dayValue.getUTCDay()] ?? '',
        formattedDate: `${MONTH_NAMES[dayValue.getUTCMonth()] ?? ''} ${String(
          dayValue.getUTCDate(),
        ).padStart(2, '0')}`,
        isToday: date === referenceToday,
        occupancyPercentage: percentage(bucket.sold, bucket.physical),
        soldRooms: bucket.sold,
        totalRooms: bucket.physical,
      };
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Per-property rollup                                                  */
  /* ---------------------------------------------------------------------- */

  private buildPropertySummary(
    property: GrantedPropertyRow,
    inventory: readonly InventoryDayRow[],
    stays: readonly StayRow[],
    roomCount: number,
    hasInventory: boolean,
    startValue: Date,
    totalDays: number,
  ): PropertyCalendarSummary {
    const own = inventory.filter((row) => row.propertyId === property.id);
    const sold = own.reduce((sum, row) => sum + row.sold, 0);
    const physical = own.reduce((sum, row) => sum + row.physical, 0);

    const { revenueMinor, roomNights } = this.windowRevenue(
      stays.filter((stay) => stay.propertyId === property.id),
      startValue,
      totalDays,
    );

    return {
      propertyId: property.id as PropertyId,
      propertyCode: property.code,
      propertyName: property.name,
      currency: property.currency,
      totalRooms: roomCount,
      // Null rather than 0 when nothing sold: an ADR of zero reads as "we sold
      // rooms for nothing", which is a different and much worse claim.
      averageRateMinor: roomNights === 0 ? null : Math.round(revenueMinor / roomNights),
      averageOccupancy: percentage(sold, physical),
      roomNightsSold: roomNights,
      hasInventory,
    };
  }

  /**
   * Revenue and room-nights falling *inside* the window.
   *
   * ===========================================================================
   * A stay's `totalAmountMinor` covers its whole duration, which may run well
   * past both ends of the window. Dividing those totals by the window's
   * room-nights would inflate ADR for every long stay that straddles an edge.
   *
   * So the total is spread evenly across the stay's own nights, and only the
   * nights inside the window are counted. That is an approximation — it
   * assumes a flat nightly rate — and it is the best available until a rate
   * calendar exists to say what each individual night was actually sold for.
   * When `rates` lands (CLAUDE.md section 2), this reads per-night prices
   * instead and the approximation goes away.
   * ===========================================================================
   */
  private windowRevenue(
    stays: readonly StayRow[],
    startValue: Date,
    totalDays: number,
  ): { revenueMinor: number; roomNights: number } {
    const windowStart = startValue.getTime();
    const windowEndExclusive = addDays(startValue, totalDays).getTime();

    let revenueMinor = 0;
    let roomNights = 0;

    for (const stay of stays) {
      const arrival = stay.arrivalDate.getTime();
      const departure = stay.departureDate.getTime();

      const stayNights = Math.max(1, Math.round((departure - arrival) / DAY_MS));
      const nightlyMinor = stay.totalAmountMinor / stayNights;

      // Half-open intersection on both sides.
      const overlapStart = Math.max(arrival, windowStart);
      const overlapEnd = Math.min(departure, windowEndExclusive);
      const nightsInWindow = Math.max(0, Math.round((overlapEnd - overlapStart) / DAY_MS));

      if (nightsInWindow === 0) continue;

      roomNights += nightsInWindow;
      revenueMinor += nightlyMinor * nightsInWindow;
    }

    // Rounded once, at the end. Rounding each night first would accumulate
    // the error across a long window (CLAUDE.md section 3.4: rounding is
    // explicit and single-pass).
    return { revenueMinor: Math.round(revenueMinor), roomNights };
  }
}
