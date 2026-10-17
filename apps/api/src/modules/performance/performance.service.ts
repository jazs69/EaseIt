/**
 * Group performance analytics.
 *
 * ===========================================================================
 * The four measures, and the one thing that makes them trustworthy.
 *
 *   Occupancy = room-nights sold / room-nights available
 *   ADR       = room revenue / room-nights **sold**
 *   RevPAR    = room revenue / room-nights **available**
 *
 * ADR and RevPAR differ only in the denominator, which is exactly why they get
 * swapped: ADR flatters a near-empty hotel (few nights, high average) while
 * RevPAR does not. Computing both from the same two totals makes the identity
 * `RevPAR = ADR × occupancy` hold by construction — and `assertRevParIdentity`
 * checks it in development rather than trusting the arithmetic.
 *
 * Every figure here is derived per request. None is stored, because all four
 * are functions of (window, inventory, bookings) and a cached copy would be a
 * number that can disagree with the rows it came from.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_SOURCE_BUCKET,
  BOOKING_SOURCE_LABELS,
  BOOKING_SOURCES,
  type BookingSourceKey,
  type BookingSourceMetric,
  type BookingSourcePerformance,
  type BusinessDate,
  type GroupPerformance,
  type GroupPerformanceQuery,
  type MonthlyPerformance,
  type PerformanceMetrics,
  type PerformanceRank,
  type PerformanceTimeframe,
  type PropertyId,
  type PropertyPerformanceRow,
  type YearComparison,
} from '@repo/types';

import { ClockService } from '../platform/clock.service.js';
import {
  PerformanceRepository,
  type PerformanceInventoryRow,
  type PerformanceStayRow,
} from './performance.repository.js';

const DAY_MS = 86_400_000;
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

/** Guards `0/0`, which is NaN and serialises to null, failing validation. */
function percentage(part: number, total: number): number {
  return total === 0 ? 0 : round1((part / total) * 100);
}

/** Signed percent change. Null where the base was zero. */
function growth(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return round1(((current - previous) / previous) * 100);
}

/** Totals a period reduces to before any measure is computed. */
interface PeriodTotals {
  revenueMinor: number;
  roomNightsSold: number;
  roomNightsAvailable: number;
}

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    private readonly repository: PerformanceRepository,
    private readonly clock: ClockService,
  ) {}

  async groupPerformance(
    userId: string,
    query: GroupPerformanceQuery,
  ): Promise<GroupPerformance> {
    const requestedIds =
      query.propertyIds
        ?.split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0) ?? undefined;

    const properties = await this.repository.findGrantedProperties(userId, requestedIds);
    const propertyIds = properties.map((property) => property.id);

    // The clock the period is measured against. A portfolio can span zones, so
    // the first property alphabetically is the stated reference rather than a
    // silent pick (CLAUDE.md section 3.3).
    const reference = properties[0] ?? null;
    const referenceTimezone = reference?.timezone ?? 'Asia/Kolkata';
    const targetDate =
      query.targetDate ??
      (reference === null
        ? toBusinessDate(this.clock.now())
        : toBusinessDate(reference.businessDate));

    const period = this.resolvePeriod(query.timeframe, targetDate);

    const [inventory, stays, roomCounts] = await Promise.all([
      this.repository.findInventory(
        propertyIds,
        toUtcMidnight(period.start),
        toUtcMidnight(period.end),
      ),
      this.repository.findEarningStays(
        propertyIds,
        toUtcMidnight(period.start),
        addDays(toUtcMidnight(period.end), 1),
      ),
      this.repository.countRoomsByProperty(propertyIds),
    ]);

    /* -- Portfolio totals ------------------------------------------------ */

    const portfolio = this.totalsFor(inventory, stays, period, null);
    const metrics = this.toMetrics(portfolio);

    /* -- Per property ---------------------------------------------------- */

    const perProperty = new Map<string, PeriodTotals>();
    for (const property of properties) {
      perProperty.set(property.id, this.totalsFor(inventory, stays, period, property.id));
    }

    /* -- Last year ------------------------------------------------------- */

    const comparison = query.compareWithLastYear
      ? await this.compareWithLastYear(propertyIds, query.timeframe, targetDate, portfolio)
      : null;

    /* -- Monthly trajectory ---------------------------------------------- */

    const monthlyData = await this.monthlyTrajectory(propertyIds, targetDate);

    /* -- Rankings and breakdown ------------------------------------------ */

    const ranks: PerformanceRank[] = properties.map((property) => {
      const totals = perProperty.get(property.id) ?? {
        revenueMinor: 0,
        roomNightsSold: 0,
        roomNightsAvailable: 0,
      };
      const own = this.toMetrics(totals);
      return {
        propertyId: property.id as PropertyId,
        propertyCode: property.code,
        name: property.name,
        currency: property.currency,
        revenueMinor: own.totalRevenueMinor,
        occupancy: own.avgOccupancy,
        adrMinor: own.adrMinor,
        revParMinor: own.revParMinor,
      };
    });

    // Ranked by revenue, and only among properties that actually earned: a
    // hotel with no inventory configured is not "the worst performer", it is
    // absent from the comparison.
    const earning = ranks.filter((rank) => rank.revenueMinor > 0);
    const byRevenue = [...earning].sort((a, b) => b.revenueMinor - a.revenueMinor);
    const topPerforming = byRevenue[0] ?? null;
    const lowPerforming = byRevenue[byRevenue.length - 1] ?? null;

    const yoyByProperty = comparison === null ? new Map<string, number | null>() : await this.perPropertyYoy(propertyIds, query.timeframe, targetDate, perProperty);

    const propertyBreakdown: PropertyPerformanceRow[] = ranks.map((rank) => {
      const totals = perProperty.get(rank.propertyId) ?? {
        revenueMinor: 0,
        roomNightsSold: 0,
        roomNightsAvailable: 0,
      };
      return {
        ...rank,
        rooms: roomCounts.get(rank.propertyId) ?? 0,
        roomNightsSold: totals.roomNightsSold,
        roomNightsAvailable: totals.roomNightsAvailable,
        yoyGrowthPercent: yoyByProperty.get(rank.propertyId) ?? null,
        revenueSharePercent: percentage(rank.revenueMinor, portfolio.revenueMinor),
      };
    });

    /* -- Currency sanity -------------------------------------------------- */

    const currencies = new Set(properties.map((property) => property.currency));

    return {
      timeframe: query.timeframe,
      targetDate,
      periodStart: period.start,
      periodEnd: period.end,
      currency: reference?.currency ?? 'INR',
      // Summing rupees and Sri Lankan rupees is meaningless. The figures are
      // still returned, flagged, so the UI warns instead of silently adding.
      hasMixedCurrencies: currencies.size > 1,
      metrics,
      lastYearComparison: comparison,
      rankings: {
        topPerforming,
        lowPerforming,
        // True only when top and low genuinely *are* the same property —
        // one earner, or one property in scope at all. An empty period is a
        // different thing: ten properties that earned nothing are not "one
        // property", and both ranks come back null for the UI to say so.
        isSingleProperty: properties.length <= 1 || earning.length === 1,
        metric: 'Revenue',
      },
      monthlyData,
      bookingSources: this.bookingSourceBreakdown(stays, period),
      propertyBreakdown,
      propertiesCount: properties.length,
      propertiesWithDataCount: ranks.filter((rank) => rank.revenueMinor > 0).length,
      reference: { timezone: referenceTimezone, businessDate: targetDate },
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Periods                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The window a timeframe resolves to, inclusive on both ends.
   *
   * `today` is one day, `mtd` is the 1st of the month to the target date, `ytd`
   * is the 1st of January to the target date. All three *end* on the target
   * date rather than running to the end of the month or year — a month-to-date
   * figure that included future nights would report revenue nobody has earned.
   */
  private resolvePeriod(
    timeframe: PerformanceTimeframe,
    targetDate: BusinessDate,
  ): { start: BusinessDate; end: BusinessDate } {
    const [year = '2026', month = '01'] = targetDate.split('-');

    switch (timeframe) {
      case 'today':
        return { start: targetDate, end: targetDate };
      case 'mtd':
        return { start: `${year}-${month}-01` as BusinessDate, end: targetDate };
      case 'ytd':
      default:
        return { start: `${year}-01-01` as BusinessDate, end: targetDate };
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Measures                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Reduces inventory and stays to the three totals every measure derives from.
   *
   * `propertyId` null means the whole portfolio.
   */
  private totalsFor(
    inventory: readonly PerformanceInventoryRow[],
    stays: readonly PerformanceStayRow[],
    period: { start: BusinessDate; end: BusinessDate },
    propertyId: string | null,
  ): PeriodTotals {
    let roomNightsSold = 0;
    let roomNightsAvailable = 0;

    for (const row of inventory) {
      if (propertyId !== null && row.propertyId !== propertyId) continue;
      roomNightsSold += row.sold;
      roomNightsAvailable += row.physical;
    }

    const periodStart = toUtcMidnight(period.start).getTime();
    const periodEndExclusive = addDays(toUtcMidnight(period.end), 1).getTime();

    const revenueMinor = this.revenueInWindow(
      stays.filter((stay) => propertyId === null || stay.propertyId === propertyId),
      periodStart,
      periodEndExclusive,
    );

    return { revenueMinor, roomNightsSold, roomNightsAvailable };
  }

  /**
   * Revenue attributable to nights inside the window.
   *
   * A stay's total covers its whole duration, which may begin before the
   * window and end after it. The total is spread evenly across the stay's own
   * nights and only the nights inside the window are counted — so a booking
   * straddling a month boundary contributes to both months and to neither
   * twice.
   *
   * That assumes a flat nightly rate. It is the best available until the
   * `rates` module can say what each individual night was sold for, at which
   * point this reads per-night prices and the approximation disappears.
   * Rounded once at the end, so the error does not accumulate across a
   * year-to-date window (CLAUDE.md section 3.4).
   */
  private revenueInWindow(
    stays: readonly PerformanceStayRow[],
    windowStartMs: number,
    windowEndExclusiveMs: number,
  ): number {
    let revenue = 0;

    for (const stay of stays) {
      const slice = this.sliceInWindow(stay, windowStartMs, windowEndExclusiveMs);
      revenue += slice.nightlyMinor * slice.nights;
    }

    return Math.round(revenue);
  }

  /**
   * How much of one stay falls inside the window, and at what nightly rate.
   *
   * The single definition of the spreading rule described above. Both the
   * portfolio measures and the booking-source breakdown go through it, so the
   * two can never attribute a straddling booking differently — which is the
   * kind of divergence that shows up as a widget whose bars do not sum to the
   * total printed above them.
   *
   * `nightlyMinor` stays fractional on purpose: rounding per night would drift
   * by a paisa per night across a year-to-date window. The caller rounds once,
   * at the end of its own summation (CLAUDE.md section 3.4).
   */
  private sliceInWindow(
    stay: PerformanceStayRow,
    windowStartMs: number,
    windowEndExclusiveMs: number,
  ): { nights: number; nightlyMinor: number } {
    const arrival = stay.arrivalDate.getTime();
    const departure = stay.departureDate.getTime();
    const stayNights = Math.max(1, Math.round((departure - arrival) / DAY_MS));

    const overlapStart = Math.max(arrival, windowStartMs);
    const overlapEnd = Math.min(departure, windowEndExclusiveMs);
    const nights = Math.max(0, Math.round((overlapEnd - overlapStart) / DAY_MS));

    return { nights, nightlyMinor: stay.totalAmountMinor / stayNights };
  }

  /* ---------------------------------------------------------------------- */
  /*  Booking source breakdown                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Revenue and room-nights per sales channel.
   *
   * ===========================================================================
   * Grouped on the stored `source`, mapped to a display bucket by
   * `BOOKING_SOURCE_BUCKET` — never the reverse. The storage enum can gain a
   * channel without this method changing, and because the map is an exhaustive
   * `Record`, a new member that nobody assigned a bucket is a compile error
   * rather than revenue that quietly disappears from the chart.
   *
   * All eight buckets are always returned, including empty ones. A chart whose
   * rows appear and vanish as the timeframe changes is unreadable — the reader
   * cannot tell "Agoda sold nothing this month" from "Agoda is further down the
   * list now". A zero bucket is information, so it gets a row.
   *
   * Room-nights are rooms x nights so a group booking is not under-counted,
   * and they use the same spreading rule as revenue, so a stay straddling the
   * window edge contributes the same nights to both measures.
   * ===========================================================================
   */
  private bookingSourceBreakdown(
    stays: readonly PerformanceStayRow[],
    period: { start: BusinessDate; end: BusinessDate },
  ): BookingSourcePerformance {
    const windowStart = toUtcMidnight(period.start).getTime();
    const windowEndExclusive = addDays(toUtcMidnight(period.end), 1).getTime();

    // Fractional until the end, then rounded once per bucket.
    const revenueBy = new Map<BookingSourceKey, number>();
    const nightsBy = new Map<BookingSourceKey, number>();
    for (const key of BOOKING_SOURCES) {
      revenueBy.set(key, 0);
      nightsBy.set(key, 0);
    }

    for (const stay of stays) {
      const slice = this.sliceInWindow(stay, windowStart, windowEndExclusive);
      if (slice.nights === 0) continue;

      const bucket = BOOKING_SOURCE_BUCKET[stay.source];
      revenueBy.set(bucket, (revenueBy.get(bucket) ?? 0) + slice.nightlyMinor * slice.nights);
      nightsBy.set(bucket, (nightsBy.get(bucket) ?? 0) + slice.nights * stay.roomCount);
    }

    const rounded = BOOKING_SOURCES.map((key) => ({
      key,
      revenueMinor: Math.round(revenueBy.get(key) ?? 0),
      roomNightsSold: nightsBy.get(key) ?? 0,
    }));

    // Totalled from the rounded rows, so the bars sum to the printed total.
    const totalRevenueMinor = rounded.reduce((sum, row) => sum + row.revenueMinor, 0);
    const totalRoomNightsSold = rounded.reduce((sum, row) => sum + row.roomNightsSold, 0);

    const sources: BookingSourceMetric[] = rounded.map((row) => ({
      source: row.key,
      label: BOOKING_SOURCE_LABELS[row.key],
      revenueMinor: row.revenueMinor,
      roomNightsSold: row.roomNightsSold,
      revenueSharePercent: percentage(row.revenueMinor, totalRevenueMinor),
      roomNightsSharePercent: percentage(row.roomNightsSold, totalRoomNightsSold),
    }));

    return {
      metricType: 'revenue',
      sources,
      totalRevenueMinor,
      totalRoomNightsSold,
      isEmpty: totalRevenueMinor === 0 && totalRoomNightsSold === 0,
    };
  }

  /** Totals -> the four published measures. */
  private toMetrics(totals: PeriodTotals): PerformanceMetrics {
    const { revenueMinor, roomNightsSold, roomNightsAvailable } = totals;

    const metrics: PerformanceMetrics = {
      totalRevenueMinor: revenueMinor,
      avgOccupancy: percentage(roomNightsSold, roomNightsAvailable),
      // Null, not zero: an ADR of zero asserts rooms were sold for nothing,
      // which is a different and much worse claim than "nothing was sold".
      adrMinor: roomNightsSold === 0 ? null : Math.round(revenueMinor / roomNightsSold),
      // Zero is correct here — real capacity that earned nothing is 0 RevPAR.
      revParMinor:
        roomNightsAvailable === 0 ? 0 : Math.round(revenueMinor / roomNightsAvailable),
      roomNightsSold,
      roomNightsAvailable,
    };

    this.assertRevParIdentity(metrics);
    return metrics;
  }

  /**
   * `RevPAR = ADR × occupancy` must hold.
   *
   * Checked rather than assumed, because the two are computed from different
   * denominators and a mistake in either is silent — the numbers stay
   * plausible and the dashboard lies. Logged, never thrown: a reporting screen
   * must not 500 over a rounding disagreement, and the tolerance absorbs the
   * integer rounding each measure already did.
   */
  private assertRevParIdentity(metrics: PerformanceMetrics): void {
    if (metrics.adrMinor === null || metrics.roomNightsAvailable === 0) return;

    const implied = (metrics.adrMinor * metrics.avgOccupancy) / 100;
    const tolerance = Math.max(2, metrics.revParMinor * 0.01);

    if (Math.abs(implied - metrics.revParMinor) > tolerance) {
      this.logger.error(
        `RevPAR identity violated: ADR ${String(metrics.adrMinor)} x occupancy ` +
          `${String(metrics.avgOccupancy)}% implies ${String(Math.round(implied))} ` +
          `but RevPAR is ${String(metrics.revParMinor)}`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Comparisons                                                          */
  /* ---------------------------------------------------------------------- */

  /** The same timeframe, one year earlier. */
  private async compareWithLastYear(
    propertyIds: readonly string[],
    timeframe: PerformanceTimeframe,
    targetDate: BusinessDate,
    current: PeriodTotals,
  ): Promise<YearComparison | null> {
    const lastYearTarget = shiftYear(targetDate, -1);
    const period = this.resolvePeriod(timeframe, lastYearTarget);

    const [inventory, stays] = await Promise.all([
      this.repository.findInventory(
        propertyIds,
        toUtcMidnight(period.start),
        toUtcMidnight(period.end),
      ),
      this.repository.findEarningStays(
        propertyIds,
        toUtcMidnight(period.start),
        addDays(toUtcMidnight(period.end), 1),
      ),
    ]);

    const totals = this.totalsFor(inventory, stays, period, null);

    // Nothing recorded for that period at all. Returning null is honest; a
    // comparison against zero produces "+infinity% growth".
    if (totals.roomNightsAvailable === 0 && totals.revenueMinor === 0) return null;

    const previous = this.toMetrics(totals);
    const currentMetrics = this.toMetrics(current);

    return {
      previous,
      revenueGrowthPercent: growth(
        currentMetrics.totalRevenueMinor,
        previous.totalRevenueMinor,
      ),
      // Occupancy moves in percentage *points*, not percent: 3% to 6% is "+3
      // points", and calling it "+100%" would be true but useless.
      occupancyDeltaPoints: round1(currentMetrics.avgOccupancy - previous.avgOccupancy),
      adrGrowthPercent:
        previous.adrMinor === null || currentMetrics.adrMinor === null
          ? null
          : growth(currentMetrics.adrMinor, previous.adrMinor),
      revParGrowthPercent: growth(currentMetrics.revParMinor, previous.revParMinor),
      periodStart: period.start,
      periodEnd: period.end,
    };
  }

  /** Year-on-year revenue change per property, for the breakdown column. */
  private async perPropertyYoy(
    propertyIds: readonly string[],
    timeframe: PerformanceTimeframe,
    targetDate: BusinessDate,
    current: ReadonlyMap<string, PeriodTotals>,
  ): Promise<Map<string, number | null>> {
    const period = this.resolvePeriod(timeframe, shiftYear(targetDate, -1));

    const [inventory, stays] = await Promise.all([
      this.repository.findInventory(
        propertyIds,
        toUtcMidnight(period.start),
        toUtcMidnight(period.end),
      ),
      this.repository.findEarningStays(
        propertyIds,
        toUtcMidnight(period.start),
        addDays(toUtcMidnight(period.end), 1),
      ),
    ]);

    const result = new Map<string, number | null>();
    for (const propertyId of propertyIds) {
      const previous = this.totalsFor(inventory, stays, period, propertyId);
      const now = current.get(propertyId)?.revenueMinor ?? 0;
      result.set(propertyId, growth(now, previous.revenueMinor));
    }
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /*  Monthly trajectory                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Twelve months of the target year, for the chart.
   *
   * Always twelve entries, even where there is no data — a chart with a gap in
   * March reads correctly, whereas an eleven-point series silently shifts every
   * later month one position left. `hasData` distinguishes "no capacity
   * configured" from "capacity that sold nothing", so the chart can break the
   * line rather than plot a misleading zero.
   */
  private async monthlyTrajectory(
    propertyIds: readonly string[],
    targetDate: BusinessDate,
  ): Promise<MonthlyPerformance[]> {
    const year = Number(targetDate.slice(0, 4));
    const yearStart = toUtcMidnight(`${String(year)}-01-01`);
    const yearEnd = toUtcMidnight(`${String(year)}-12-31`);

    const [inventory, stays] = await Promise.all([
      this.repository.findInventory(propertyIds, yearStart, yearEnd),
      this.repository.findEarningStays(propertyIds, yearStart, addDays(yearEnd, 1)),
    ]);

    // Bucketed once, so the twelve-month loop is O(rows), not O(12 × rows).
    const byMonth = new Map<number, { sold: number; physical: number }>();
    for (const row of inventory) {
      const month = row.stayDate.getUTCMonth();
      const bucket = byMonth.get(month) ?? { sold: 0, physical: 0 };
      bucket.sold += row.sold;
      bucket.physical += row.physical;
      byMonth.set(month, bucket);
    }

    return Array.from({ length: 12 }, (_, month) => {
      const bucket = byMonth.get(month) ?? { sold: 0, physical: 0 };

      const monthStart = Date.UTC(year, month, 1);
      const monthEndExclusive = Date.UTC(year, month + 1, 1);
      const revenueMinor = this.revenueInWindow(stays, monthStart, monthEndExclusive);

      const padded = String(month + 1).padStart(2, '0');
      return {
        month: MONTHS[month] ?? '',
        monthKey: `${String(year)}-${padded}`,
        revenueMinor,
        occupancy: percentage(bucket.sold, bucket.physical),
        adrMinor: bucket.sold === 0 ? null : Math.round(revenueMinor / bucket.sold),
        revParMinor: bucket.physical === 0 ? 0 : Math.round(revenueMinor / bucket.physical),
        roomNightsSold: bucket.sold,
        hasData: bucket.physical > 0,
      };
    });
  }
}

/**
 * Shifts a `YYYY-MM-DD` by whole years.
 *
 * Clamps 29 February to the 28th, because `2024-02-29` minus one year is not a
 * date. `Date` would silently roll it to 1 March and quietly compare the wrong
 * day.
 */
function shiftYear(date: BusinessDate, years: number): BusinessDate {
  const [yearText = '2026', month = '01', day = '01'] = date.split('-');
  const year = Number(yearText) + years;

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const safeDay = month === '02' && day === '29' && !isLeap ? '28' : day;

  return `${String(year)}-${month}-${safeDay}` as BusinessDate;
}
