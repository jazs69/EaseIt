/**
 * Property reports.
 *
 * ===========================================================================
 * Five reports are built here. Four are refused, deliberately.
 *
 * A report is the output a hotel reconciles its bank against, so the bar is
 * not "does it render" but "is every number in it true". Four of the nine
 * specified reports need tables that do not exist — folios, posted charges,
 * tax lines, cashier shifts — and the only ways to ship them today are to
 * print zeros or to invent figures. Both are worse than refusing: a zero in a
 * tax column is read as "no tax was collected", not as "this software cannot
 * see tax".
 *
 * So the blocked four throw a typed error naming the module they wait on, and
 * the catalogue carries that reason so the UI never offers them in the first
 * place.
 *
 * The five that are built share one rule: every figure traces to a column.
 * Occupancy and inventory come from `inventory_day`, the same counters the
 * oversell CHECK guards. Revenue comes from reservation totals, spread across
 * a stay's nights — an approximation that is *stated in the response* rather
 * than hidden, and which disappears when the rates module can price a night.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  BOOKING_SOURCE_BUCKET,
  BOOKING_SOURCE_LABELS,
  Permission,
  permissionsForRoles,
  REPORT_BY_TYPE,
  type BusinessDate,
  type PropertyId,
  type ReportColumn,
  type ReportQuery,
  type ReportResponse,
  type ReportRow,
  type ReportType,
  type Role,
} from '@repo/types';

import {
  EntityNotFoundError,
  ForbiddenError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import {
  ReportsRepository,
  type ReportInventoryRow,
  type ReportPropertyRow,
  type ReportStayRow,
} from './reports.repository.js';

const DAY_MS = 86_400_000;
/** A year of daily rows is already a large CSV; beyond that, narrow the window. */
const MAX_WINDOW_DAYS = 370;

const NIGHTLY_SPREAD_NOTE =
  'Revenue is spread evenly across each stay’s nights. Until the rates module can price an individual night, a booking straddling two dates contributes equally to both.';
const NO_TAX_NOTE =
  'Tax is not broken out. Tax lines live on a folio, and the folios module is not built — these figures are gross stay totals, not net of tax.';

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

function percentage(part: number, total: number): number {
  return total === 0 ? 0 : round1((part / total) * 100);
}

@Injectable()
export class ReportsService {
  constructor(private readonly repository: ReportsRepository) {}

  async run(
    userId: string,
    hotelId: string,
    type: ReportType,
    query: ReportQuery,
  ): Promise<ReportResponse> {
    const granted = await this.repository.findGrantedProperty(userId, hotelId);
    if (granted === null) {
      // Not-found, never forbidden: a 403 confirms the property exists to
      // somebody with no grant at it (CLAUDE.md section 3.2).
      throw new TenantScopeViolationError('Property');
    }

    const { property, roles } = granted;

    /**
     * Reports are financial output, so they need the financial permission —
     * not merely a grant at the property. Housekeeping holds a grant and must
     * not read revenue; section 2 says that role is "read-only on financials",
     * and this is where that is enforced for reporting.
     *
     * Computed from the roles held *here*, so the answer is per-property.
     */
    const permissions = permissionsForRoles(roles as Role[]);
    if (!permissions.includes(Permission.FINANCIAL_REPORTS_READ)) {
      throw new ForbiddenError('Reading financial reports');
    }

    const definition = REPORT_BY_TYPE[type];
    if (!definition.availability.available) {
      // A clean, typed refusal carrying the reason — not an empty success.
      throw new EntityNotFoundError(`${definition.title} (not built)`);
    }

    const window = this.resolveWindow(property, query);

    switch (type) {
      case 'room-inventory':
        return this.roomInventory(property, window, definition.title);
      case 'sales':
        return this.sales(property, window, definition.title);
      case 'flash-manager':
        return this.flashManager(property, window, definition.title);
      case 'master':
        return this.master(property, window, definition.title);
      case 'bar-pricing':
        return this.barPricing(property, window, definition.title);
      default:
        // Unreachable: the availability check above has already refused every
        // other member. Thrown rather than returning an empty report, because
        // a silent empty success is how a missing branch ships.
        throw new EntityNotFoundError(`${definition.title} (not built)`);
    }
  }

  /* -------------------------------------------------------------------- */
  /*  Window                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * The reporting window, defaulting to the property's own business date.
   *
   * Never the server's calendar day: a hotel in Asia/Kolkata closes its books
   * on its own date, and a report generated from `now()` in another zone would
   * disagree with them (CLAUDE.md section 3.3).
   */
  private resolveWindow(
    property: ReportPropertyRow,
    query: ReportQuery,
  ): { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate } {
    const businessDate = toBusinessDate(property.businessDate);
    const start = query.startDate ?? businessDate;
    const end = query.endDate ?? start;

    if (end < start) {
      throw new ValidationFailedError({
        endDate: `endDate ${end} must not be before startDate ${start}.`,
      });
    }

    const days =
      Math.round((toUtcMidnight(end).getTime() - toUtcMidnight(start).getTime()) / DAY_MS) + 1;
    if (days > MAX_WINDOW_DAYS) {
      throw new ValidationFailedError({
        endDate: `Report window is limited to ${String(MAX_WINDOW_DAYS)} days; ${String(days)} requested.`,
      });
    }

    return { start, end, businessDate };
  }

  private envelope(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    type: ReportType,
    title: string,
    columns: ReportColumn[],
    rows: ReportRow[],
    totals: ReportRow | null,
    notes: string[],
  ): ReportResponse {
    return {
      type,
      title,
      propertyId: property.id as PropertyId,
      propertyName: property.name,
      propertyCode: property.code,
      currency: property.currency,
      startDate: window.start,
      endDate: window.end,
      generatedFor: window.businessDate,
      columns,
      rows,
      totals,
      rowCount: rows.length,
      notes,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Room inventory — every figure is a stored counter                   */
  /* -------------------------------------------------------------------- */

  private async roomInventory(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    title: string,
  ): Promise<ReportResponse> {
    const inventory = await this.repository.findInventory(
      property.id,
      toUtcMidnight(window.start),
      toUtcMidnight(window.end),
    );

    // Collapsed to one row per date: the counters are additive across room
    // types, and a GM reading an inventory report wants the house position.
    const byDate = new Map<string, { physical: number; sold: number; blocked: number }>();
    for (const row of inventory) {
      const key = toBusinessDate(row.stayDate);
      const bucket = byDate.get(key) ?? { physical: 0, sold: 0, blocked: 0 };
      bucket.physical += row.physical;
      bucket.sold += row.sold;
      bucket.blocked += row.blocked;
      byDate.set(key, bucket);
    }

    const rows: ReportRow[] = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bucket]) => ({
        date,
        totalRooms: bucket.physical,
        soldRooms: bucket.sold,
        blockedRooms: bucket.blocked,
        // Derived from the same three numbers printed beside it, so the row
        // cannot fail to add up.
        availableRooms: Math.max(0, bucket.physical - bucket.sold - bucket.blocked),
        occupancy: percentage(bucket.sold, bucket.physical),
      }));

    const totals = rows.reduce<ReportRow>(
      (sum, row) => ({
        date: 'Total',
        totalRooms: Number(sum['totalRooms'] ?? 0) + Number(row['totalRooms'] ?? 0),
        soldRooms: Number(sum['soldRooms'] ?? 0) + Number(row['soldRooms'] ?? 0),
        blockedRooms: Number(sum['blockedRooms'] ?? 0) + Number(row['blockedRooms'] ?? 0),
        availableRooms:
          Number(sum['availableRooms'] ?? 0) + Number(row['availableRooms'] ?? 0),
        occupancy: 0,
      }),
      { date: 'Total', totalRooms: 0, soldRooms: 0, blockedRooms: 0, availableRooms: 0, occupancy: 0 },
    );
    totals['occupancy'] = percentage(Number(totals['soldRooms']), Number(totals['totalRooms']));

    return this.envelope(
      property,
      window,
      'room-inventory',
      title,
      [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'totalRooms', label: 'Total rooms', kind: 'number' },
        { key: 'soldRooms', label: 'Sold', kind: 'number' },
        { key: 'blockedRooms', label: 'Blocked', kind: 'number' },
        { key: 'availableRooms', label: 'Available', kind: 'number' },
        { key: 'occupancy', label: 'Occupancy', kind: 'percent' },
      ],
      rows,
      rows.length > 0 ? totals : null,
      [
        'Room counts are the stored inventory counters, the same ones the oversell constraint guards — these are the numbers the booking path enforces against.',
      ],
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Sales — date-wise occupancy, ADR, RevPAR, revenue                   */
  /* -------------------------------------------------------------------- */

  private async sales(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    title: string,
  ): Promise<ReportResponse> {
    const [inventory, stays] = await Promise.all([
      this.repository.findInventory(
        property.id,
        toUtcMidnight(window.start),
        toUtcMidnight(window.end),
      ),
      this.repository.findStays(
        property.id,
        toUtcMidnight(window.start),
        addDays(toUtcMidnight(window.end), 1),
      ),
    ]);

    const capacity = this.capacityByDate(inventory);
    const revenue = this.revenueByDate(stays);

    const rows: ReportRow[] = [...capacity.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => {
        const revenueMinor = Math.round(revenue.get(date) ?? 0);
        return {
          date,
          roomsAvailable: day.physical,
          roomsSold: day.sold,
          occupancy: percentage(day.sold, day.physical),
          // ADR divides by rooms *sold*, RevPAR by rooms *available*. Swapping
          // them is the classic reporting bug; they are computed from the same
          // two totals so the identity holds by construction.
          adrMinor: day.sold === 0 ? null : Math.round(revenueMinor / day.sold),
          revParMinor: day.physical === 0 ? 0 : Math.round(revenueMinor / day.physical),
          revenueMinor,
        };
      });

    const soldTotal = rows.reduce((sum, row) => sum + Number(row['roomsSold'] ?? 0), 0);
    const availTotal = rows.reduce((sum, row) => sum + Number(row['roomsAvailable'] ?? 0), 0);
    const revenueTotal = rows.reduce((sum, row) => sum + Number(row['revenueMinor'] ?? 0), 0);

    const totals: ReportRow = {
      date: 'Total',
      roomsAvailable: availTotal,
      roomsSold: soldTotal,
      occupancy: percentage(soldTotal, availTotal),
      adrMinor: soldTotal === 0 ? null : Math.round(revenueTotal / soldTotal),
      revParMinor: availTotal === 0 ? 0 : Math.round(revenueTotal / availTotal),
      revenueMinor: revenueTotal,
    };

    return this.envelope(
      property,
      window,
      'sales',
      title,
      [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'roomsAvailable', label: 'Rooms available', kind: 'number' },
        { key: 'roomsSold', label: 'Rooms sold', kind: 'number' },
        { key: 'occupancy', label: 'Occupancy', kind: 'percent' },
        { key: 'adrMinor', label: 'ADR', kind: 'money' },
        { key: 'revParMinor', label: 'RevPAR', kind: 'money' },
        { key: 'revenueMinor', label: 'Revenue', kind: 'money' },
      ],
      rows,
      rows.length > 0 ? totals : null,
      [
        NIGHTLY_SPREAD_NOTE,
        NO_TAX_NOTE,
        'Payments are not shown per date. A payment belongs to a folio and carries its own date, which the reservation’s settled-so-far figure cannot reconstruct.',
      ],
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Flash manager — today, MTD, YTD                                     */
  /* -------------------------------------------------------------------- */

  private async flashManager(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    title: string,
  ): Promise<ReportResponse> {
    // The flash is always measured against a single reference day — the end of
    // the requested window, which defaults to the business date.
    const target = window.end;
    const [year = '2026', month = '01'] = target.split('-');

    const periods: { label: string; start: BusinessDate; end: BusinessDate }[] = [
      { label: 'Today', start: target, end: target },
      { label: 'Month to date', start: `${year}-${month}-01` as BusinessDate, end: target },
      { label: 'Year to date', start: `${year}-01-01` as BusinessDate, end: target },
    ];

    const earliest = periods[2]?.start ?? target;
    const [inventory, stays] = await Promise.all([
      this.repository.findInventory(
        property.id,
        toUtcMidnight(earliest),
        toUtcMidnight(target),
      ),
      this.repository.findStays(
        property.id,
        toUtcMidnight(earliest),
        addDays(toUtcMidnight(target), 1),
      ),
    ]);

    const capacity = this.capacityByDate(inventory);
    const revenue = this.revenueByDate(stays);

    const rows: ReportRow[] = periods.map((period) => {
      let sold = 0;
      let physical = 0;
      let revenueMinor = 0;

      for (const [date, day] of capacity) {
        if (date < period.start || date > period.end) continue;
        sold += day.sold;
        physical += day.physical;
        revenueMinor += revenue.get(date) ?? 0;
      }

      const rounded = Math.round(revenueMinor);
      return {
        period: period.label,
        from: period.start,
        to: period.end,
        roomsSold: sold,
        roomsAvailable: physical,
        occupancy: percentage(sold, physical),
        adrMinor: sold === 0 ? null : Math.round(rounded / sold),
        revParMinor: physical === 0 ? 0 : Math.round(rounded / physical),
        revenueMinor: rounded,
      };
    });

    return this.envelope(
      property,
      window,
      'flash-manager',
      title,
      [
        { key: 'period', label: 'Period', kind: 'text' },
        { key: 'from', label: 'From', kind: 'date' },
        { key: 'to', label: 'To', kind: 'date' },
        { key: 'roomsSold', label: 'Rooms sold', kind: 'number' },
        { key: 'roomsAvailable', label: 'Rooms available', kind: 'number' },
        { key: 'occupancy', label: 'Occupancy', kind: 'percent' },
        { key: 'adrMinor', label: 'ADR', kind: 'money' },
        { key: 'revParMinor', label: 'RevPAR', kind: 'money' },
        { key: 'revenueMinor', label: 'Revenue', kind: 'money' },
      ],
      rows,
      null,
      [
        `Measured against ${target}, the property’s own business date unless another end date was given.`,
        NIGHTLY_SPREAD_NOTE,
        'CGST/SGST are not included. Tax is a folio line, and the folios module is not built — so this flash reports gross revenue only.',
      ],
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Master — one row per booking                                        */
  /* -------------------------------------------------------------------- */

  private async master(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    title: string,
  ): Promise<ReportResponse> {
    const stays = await this.repository.findStays(
      property.id,
      toUtcMidnight(window.start),
      addDays(toUtcMidnight(window.end), 1),
    );

    const rows: ReportRow[] = stays.map((stay) => {
      const nights = Math.max(
        1,
        Math.round((stay.departureDate.getTime() - stay.arrivalDate.getTime()) / DAY_MS),
      );
      return {
        bookingCode: stay.confirmationCode,
        otaRef: stay.otaBookingId,
        guest: `${stay.guestFirstName} ${stay.guestLastName}`.trim(),
        phone: stay.guestPhone,
        email: stay.guestEmail,
        status: stay.status,
        source: BOOKING_SOURCE_LABELS[BOOKING_SOURCE_BUCKET[stay.source]],
        roomType: stay.rooms[0]?.roomType.name ?? null,
        room: stay.rooms[0]?.room?.number ?? null,
        arrival: toBusinessDate(stay.arrivalDate),
        departure: toBusinessDate(stay.departureDate),
        nights,
        guests: stay.adults + stay.children,
        mealPlan: stay.mealPlan,
        totalMinor: stay.totalAmountMinor,
        paidMinor: stay.paidAmountMinor,
        // Derived, never stored: no third number able to disagree with the two
        // it comes from (CLAUDE.md section 3.4).
        balanceMinor: stay.totalAmountMinor - stay.paidAmountMinor,
      };
    });

    const totals: ReportRow = {
      bookingCode: `${String(rows.length)} bookings`,
      otaRef: null,
      guest: null,
      phone: null,
      email: null,
      status: null,
      source: null,
      roomType: null,
      room: null,
      arrival: null,
      departure: null,
      nights: rows.reduce((sum, row) => sum + Number(row['nights'] ?? 0), 0),
      guests: rows.reduce((sum, row) => sum + Number(row['guests'] ?? 0), 0),
      mealPlan: null,
      totalMinor: rows.reduce((sum, row) => sum + Number(row['totalMinor'] ?? 0), 0),
      paidMinor: rows.reduce((sum, row) => sum + Number(row['paidMinor'] ?? 0), 0),
      balanceMinor: rows.reduce((sum, row) => sum + Number(row['balanceMinor'] ?? 0), 0),
    };

    return this.envelope(
      property,
      window,
      'master',
      title,
      [
        { key: 'bookingCode', label: 'Booking', kind: 'text' },
        { key: 'otaRef', label: 'OTA ref', kind: 'text' },
        { key: 'guest', label: 'Guest', kind: 'text' },
        { key: 'phone', label: 'Phone', kind: 'text' },
        { key: 'email', label: 'Email', kind: 'text' },
        { key: 'status', label: 'Status', kind: 'text' },
        { key: 'source', label: 'Source', kind: 'text' },
        { key: 'roomType', label: 'Room type', kind: 'text' },
        { key: 'room', label: 'Room', kind: 'text' },
        { key: 'arrival', label: 'Arrival', kind: 'date' },
        { key: 'departure', label: 'Departure', kind: 'date' },
        { key: 'nights', label: 'Nights', kind: 'number' },
        { key: 'guests', label: 'Guests', kind: 'number' },
        { key: 'mealPlan', label: 'Board', kind: 'text' },
        { key: 'totalMinor', label: 'Total', kind: 'money' },
        { key: 'paidMinor', label: 'Paid', kind: 'money' },
        { key: 'balanceMinor', label: 'Balance', kind: 'money' },
      ],
      rows,
      rows.length > 0 ? totals : null,
      [
        NO_TAX_NOTE,
        'Paid and balance come from the reservation’s provisional settled-so-far figure, which the schema marks as temporary. When folios land, both become sums of immutable folio lines.',
        'Government ID numbers are deliberately excluded. They are guest PII and have no place in an exportable spreadsheet.',
      ],
    );
  }

  /* -------------------------------------------------------------------- */
  /*  BAR pricing — configured rate per room type                         */
  /* -------------------------------------------------------------------- */

  private async barPricing(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    title: string,
  ): Promise<ReportResponse> {
    const roomTypes = await this.repository.findRoomTypes(property.id);

    const rows: ReportRow[] = roomTypes.map((type) => ({
      code: type.code,
      roomType: type.name,
      rooms: type._count.rooms,
      baseOccupancy: type.maxAdults ?? type.maxGuests,
      maxGuests: type.maxGuests,
      baseRateMinor: type.baseRateMinor,
    }));

    return this.envelope(
      property,
      window,
      'bar-pricing',
      title,
      [
        { key: 'code', label: 'Code', kind: 'text' },
        { key: 'roomType', label: 'Room type', kind: 'text' },
        { key: 'rooms', label: 'Rooms', kind: 'number' },
        { key: 'baseOccupancy', label: 'Base occupancy', kind: 'number' },
        { key: 'maxGuests', label: 'Max guests', kind: 'number' },
        { key: 'baseRateMinor', label: 'Base rate', kind: 'money' },
      ],
      rows,
      null,
      [
        'These are the rates configured at room-type level, which is what "set at the room level" means today.',
        'There is no date dimension yet: seasonal rates, derived and linked rates, and per-date overrides all belong to the rates module, which is not built. A rate shown here applies to every date until that lands.',
      ],
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Shared aggregation                                                  */
  /* -------------------------------------------------------------------- */

  /** Capacity and rooms sold per date, summed across room types. */
  private capacityByDate(
    inventory: readonly ReportInventoryRow[],
  ): Map<string, { physical: number; sold: number }> {
    const byDate = new Map<string, { physical: number; sold: number }>();
    for (const row of inventory) {
      const key = toBusinessDate(row.stayDate);
      const bucket = byDate.get(key) ?? { physical: 0, sold: 0 };
      bucket.physical += row.physical;
      bucket.sold += row.sold;
      byDate.set(key, bucket);
    }
    return byDate;
  }

  /**
   * Revenue attributable to each date.
   *
   * A stay's total covers its whole duration, so it is divided by its own
   * nights and each night inside the window takes an equal share. Kept
   * fractional per date and rounded once by the caller, so the error does not
   * accumulate across a year (CLAUDE.md section 3.4).
   */
  private revenueByDate(stays: readonly ReportStayRow[]): Map<string, number> {
    const byDate = new Map<string, number>();

    for (const stay of stays) {
      const arrival = stay.arrivalDate.getTime();
      const departure = stay.departureDate.getTime();
      const nights = Math.max(1, Math.round((departure - arrival) / DAY_MS));
      const nightly = stay.totalAmountMinor / nights;

      for (let night = 0; night < nights; night += 1) {
        const key = toBusinessDate(new Date(arrival + night * DAY_MS));
        byDate.set(key, (byDate.get(key) ?? 0) + nightly);
      }
    }

    return byDate;
  }
}
