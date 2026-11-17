/**
 * Property reports.
 *
 * ===========================================================================
 * A report is the output a hotel reconciles its bank against, so the bar is
 * not "does it render" but "is every number in it true". Reports whose source
 * tables do not exist yet refuse with a typed error naming what they wait on,
 * and the catalogue carries that reason so the UI never offers them.
 *
 * Every figure traces to a column, and a closed day is never recomputed:
 *
 * - Closed days (before the property's business date, audited) are read from
 *   the night audit's immutable `daily_snapshot` (CLAUDE.md section 3.3). The
 *   flash report reads nothing else; the sales report reads them for every
 *   closed date and labels each row.
 * - Open and future days have no snapshot. Where a report shows them they come
 *   from `inventory_day` and reservation totals spread across a stay's nights,
 *   labelled "On the books".
 * - Tax comes from the folio ledger's own tax lines, cross-checked against each
 *   closed day's snapshot.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  addDays as addBusinessDays,
  BOOKING_SOURCE_BUCKET,
  BOOKING_SOURCE_LABELS,
  Permission,
  permissionsForRoles,
  totalClosedDays,
  REPORT_BY_TYPE,
  type BusinessDate,
  type ClosedDay,
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
import { isoDate, toClosedDay } from '../../common/reporting/daily-snapshots.js';
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
  'Tax is not broken out here: these are reservation totals. The Tax report reads the folio tax lines themselves.';

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

/** Basis points to the percent the viewer prints, one decimal. */
function bpToPercent(bp: number): number {
  return round1(bp / 100);
}

/** Calendar days from `start` to `end`, both included; zero when `end < start`. */
function daysInclusive(start: BusinessDate, end: BusinessDate): number {
  if (end < start) return 0;
  return Math.round((toUtcMidnight(end).getTime() - toUtcMidnight(start).getTime()) / DAY_MS) + 1;
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
        return this.flashManager(property, query, definition.title);
      case 'tax':
        return this.tax(property, window, definition.title);
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
        availableRooms: Number(sum['availableRooms'] ?? 0) + Number(row['availableRooms'] ?? 0),
        occupancy: 0,
      }),
      {
        date: 'Total',
        totalRooms: 0,
        soldRooms: 0,
        blockedRooms: 0,
        availableRooms: 0,
        occupancy: 0,
      },
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
  /*  Sales — date-wise; closed days from the snapshots                   */
  /* -------------------------------------------------------------------- */

  /**
   * One row per date. A date the night audit closed is its snapshot, read
   * and never recomputed (RP-08). Any other date (the open business date, the
   * future, days from before the audit existed) is computed live and labelled
   * "On the books", because it can still change.
   */
  private async sales(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    title: string,
  ): Promise<ReportResponse> {
    const [inventory, stays, closed] = await Promise.all([
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
      this.repository.findClosedDays(
        property.id,
        toUtcMidnight(window.start),
        toUtcMidnight(window.end),
      ),
    ]);

    const capacity = this.capacityByDate(inventory);
    const revenue = this.revenueByDate(stays);
    const snapshots = new Map<string, ClosedDay>(
      closed.map((row) => [isoDate(row.businessDate), toClosedDay(row)]),
    );
    const dates = [...new Set([...capacity.keys(), ...snapshots.keys()])].sort();

    let closedRows = 0;
    const rows: ReportRow[] = dates.map((date) => {
      const snapshot = snapshots.get(date);
      if (snapshot !== undefined) {
        closedRows += 1;
        return {
          date,
          basis: 'Closed',
          roomsAvailable: snapshot.roomsAvailable,
          roomsSold: snapshot.roomsSold,
          occupancy: bpToPercent(snapshot.occupancyBp),
          adrMinor: snapshot.adrMinor,
          revParMinor: snapshot.revparMinor,
          revenueMinor: snapshot.roomRevenueMinor,
        };
      }
      const day = capacity.get(date) ?? { physical: 0, sold: 0, blocked: 0 };
      // Sellable capacity, the snapshot's own definition: physical minus
      // blocked, so a closed row and a live row measure the same thing.
      const available = Math.max(0, day.physical - day.blocked);
      const revenueMinor = Math.round(revenue.get(date) ?? 0);
      return {
        date,
        basis: 'On the books',
        roomsAvailable: available,
        roomsSold: day.sold,
        occupancy: percentage(day.sold, available),
        // ADR divides by rooms *sold*, RevPAR by rooms *available*.
        adrMinor: day.sold === 0 ? null : Math.round(revenueMinor / day.sold),
        revParMinor: available === 0 ? 0 : Math.round(revenueMinor / available),
        revenueMinor,
      };
    });

    const soldTotal = rows.reduce((sum, row) => sum + Number(row['roomsSold'] ?? 0), 0);
    const availTotal = rows.reduce((sum, row) => sum + Number(row['roomsAvailable'] ?? 0), 0);
    const revenueTotal = rows.reduce((sum, row) => sum + Number(row['revenueMinor'] ?? 0), 0);

    const totals: ReportRow = {
      date: 'Total',
      basis: null,
      roomsAvailable: availTotal,
      roomsSold: soldTotal,
      occupancy: percentage(soldTotal, availTotal),
      adrMinor: soldTotal === 0 ? null : Math.round(revenueTotal / soldTotal),
      revParMinor: availTotal === 0 ? 0 : Math.round(revenueTotal / availTotal),
      revenueMinor: revenueTotal,
    };

    const notes = [
      'Closed rows are the night audit’s snapshot of that day: rooms from the inventory counters as the audit left them, room revenue from the room charges posted to folios. They do not change afterwards.',
      'Rooms available is physical rooms minus blocked rooms, on every row.',
    ];
    if (closedRows < rows.length) {
      notes.push(
        `${String(rows.length - closedRows)} row(s) are “On the books”: days the night audit has not closed (the open business date, the future, or days from before the audit existed). They are computed live and can still change. ${NIGHTLY_SPREAD_NOTE}`,
      );
    }
    notes.push(NO_TAX_NOTE);

    return this.envelope(
      property,
      window,
      'sales',
      title,
      [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'basis', label: 'Basis', kind: 'text' },
        { key: 'roomsAvailable', label: 'Rooms available', kind: 'number' },
        { key: 'roomsSold', label: 'Rooms sold', kind: 'number' },
        { key: 'occupancy', label: 'Occupancy', kind: 'percent' },
        { key: 'adrMinor', label: 'ADR', kind: 'money' },
        { key: 'revParMinor', label: 'RevPAR', kind: 'money' },
        { key: 'revenueMinor', label: 'Room revenue', kind: 'money' },
      ],
      rows,
      rows.length > 0 ? totals : null,
      notes,
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Flash manager — closed day, MTD, YTD, from the snapshots            */
  /* -------------------------------------------------------------------- */

  /**
   * The flash reads the night audit's snapshots and nothing else (RP-05).
   *
   * Its reference day is the **last closed day** (the business date minus
   * one) unless an end date is given: the open business date has no snapshot
   * yet, and a flash of a day still trading is not a flash of the books. A
   * day in a period without a snapshot is left out and the note says how
   * many, so an incomplete month is never presented as a complete one.
   */
  private async flashManager(
    property: ReportPropertyRow,
    query: ReportQuery,
    title: string,
  ): Promise<ReportResponse> {
    const businessDate = toBusinessDate(property.businessDate);
    const lastClosed = addBusinessDays(businessDate, -1);
    const target = query.endDate ?? lastClosed;
    const [year = '2026', month = '01'] = target.split('-');
    const yearStart = `${year}-01-01` as BusinessDate;

    const periods: { label: string; start: BusinessDate; end: BusinessDate }[] = [
      { label: 'Day', start: target, end: target },
      { label: 'Month to date', start: `${year}-${month}-01` as BusinessDate, end: target },
      { label: 'Year to date', start: yearStart, end: target },
    ];

    const snapshots = (
      await this.repository.findClosedDays(
        property.id,
        toUtcMidnight(yearStart),
        toUtcMidnight(target),
      )
    ).map(toClosedDay);

    const rows: ReportRow[] = periods.map((period) => {
      const totals = totalClosedDays(
        snapshots.filter(
          (day) => day.businessDate >= period.start && day.businessDate <= period.end,
        ),
      );
      return {
        period: period.label,
        from: period.start,
        to: period.end,
        closedDays: totals.days,
        roomsSold: totals.roomsSold,
        roomsAvailable: totals.roomsAvailable,
        occupancy: bpToPercent(totals.occupancyBp),
        adrMinor: totals.adrMinor,
        revParMinor: totals.revparMinor,
        roomRevenueMinor: totals.roomRevenueMinor,
        serviceRevenueMinor: totals.serviceRevenueMinor,
        taxMinor: totals.taxMinor,
        paymentsMinor: totals.paymentsMinor,
        refundsMinor: totals.refundsMinor,
      };
    });

    const notes = [
      `Read from the night audit’s closed-day snapshots, through ${target}. Without an end date the flash is measured against the last closed day; the open business date (${businessDate}) has no snapshot until its audit runs.`,
    ];
    if (target >= businessDate) {
      notes.push(`${target} is not closed yet, so it and any later day contribute nothing here.`);
    }
    // Days closed by the calendar but with no snapshot: from before the night
    // audit existed, or an audit that never ran. Said, not hidden.
    const closableEnd = target < businessDate ? target : lastClosed;
    const missing = daysInclusive(yearStart, closableEnd) - snapshots.length;
    if (missing > 0) {
      notes.push(
        `${String(missing)} closed day(s) since ${yearStart} have no snapshot (from before the night audit existed, or an audit that did not run) and are not counted. “Closed days” shows what each period covers.`,
      );
    }
    notes.push(
      'Room and service revenue are the charges posted to folios, corrections included. Tax is every folio tax line on the date. Payments and refunds are shown separately, not netted.',
    );

    return this.envelope(
      property,
      { start: yearStart, end: target, businessDate },
      'flash-manager',
      title,
      [
        { key: 'period', label: 'Period', kind: 'text' },
        { key: 'from', label: 'From', kind: 'date' },
        { key: 'to', label: 'To', kind: 'date' },
        { key: 'closedDays', label: 'Closed days', kind: 'number' },
        { key: 'roomsSold', label: 'Rooms sold', kind: 'number' },
        { key: 'roomsAvailable', label: 'Rooms available', kind: 'number' },
        { key: 'occupancy', label: 'Occupancy', kind: 'percent' },
        { key: 'adrMinor', label: 'ADR', kind: 'money' },
        { key: 'revParMinor', label: 'RevPAR', kind: 'money' },
        { key: 'roomRevenueMinor', label: 'Room revenue', kind: 'money' },
        { key: 'serviceRevenueMinor', label: 'Service revenue', kind: 'money' },
        { key: 'taxMinor', label: 'Tax', kind: 'money' },
        { key: 'paymentsMinor', label: 'Payments', kind: 'money' },
        { key: 'refundsMinor', label: 'Refunds', kind: 'money' },
      ],
      rows,
      null,
      notes,
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Tax — the folio tax lines, per charge date                          */
  /* -------------------------------------------------------------------- */

  /**
   * Taxable value and tax per charge date (RP-09).
   *
   * "Total tax" is the sum of every folio tax line on the date, so the report
   * reconciles to the ledger exactly. Room and service tax are the parts that
   * trace to a charge; anything that does not trace appears as "Other tax"
   * rather than disappearing.
   *
   * For a closed day the snapshot's frozen tax is printed beside the ledger.
   * They differ only if a tax line was posted to a date after its audit
   * closed it, and that is called out by date.
   */
  private async tax(
    property: ReportPropertyRow,
    window: { start: BusinessDate; end: BusinessDate; businessDate: BusinessDate },
    title: string,
  ): Promise<ReportResponse> {
    const from = toUtcMidnight(window.start);
    const to = toUtcMidnight(window.end);
    const [days, closed] = await Promise.all([
      this.repository.findTaxByDate(property.id, from, to),
      this.repository.findClosedDays(property.id, from, to),
    ]);

    const ledger = new Map(days.map((day) => [isoDate(day.chargeDate), day]));
    const snapshotTax = new Map(closed.map((row) => [isoDate(row.businessDate), row.taxMinor]));
    // A closed day whose snapshot holds tax but whose lines are gone still gets
    // a row, so the disagreement is visible.
    const frozenWithTax = [...snapshotTax.entries()]
      .filter(([, tax]) => tax !== 0)
      .map(([date]) => date);
    const dates = [...new Set([...ledger.keys(), ...frozenWithTax])].sort();

    const mismatches: string[] = [];
    const rows: ReportRow[] = dates.map((date) => {
      const day = ledger.get(date);
      const roomTaxMinor = day?.roomTaxMinor ?? 0;
      const serviceTaxMinor = day?.serviceTaxMinor ?? 0;
      const totalTaxMinor = day?.totalTaxMinor ?? 0;
      const frozen = snapshotTax.get(date) ?? null;
      if (frozen !== null && frozen !== totalTaxMinor) mismatches.push(date);
      return {
        date,
        roomTaxableMinor: day?.roomTaxableMinor ?? 0,
        roomTaxMinor,
        serviceTaxableMinor: day?.serviceTaxableMinor ?? 0,
        serviceTaxMinor,
        otherTaxMinor: totalTaxMinor - roomTaxMinor - serviceTaxMinor,
        totalTaxMinor,
        taxLines: day?.taxLines ?? 0,
        snapshotTaxMinor: frozen,
      };
    });

    const sum = (key: string): number =>
      rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
    const totals: ReportRow = {
      date: 'Total',
      roomTaxableMinor: sum('roomTaxableMinor'),
      roomTaxMinor: sum('roomTaxMinor'),
      serviceTaxableMinor: sum('serviceTaxableMinor'),
      serviceTaxMinor: sum('serviceTaxMinor'),
      otherTaxMinor: sum('otherTaxMinor'),
      totalTaxMinor: sum('totalTaxMinor'),
      taxLines: sum('taxLines'),
      // Per closed day only: a sum over a window mixing closed and open days
      // would compare two different things.
      snapshotTaxMinor: null,
    };

    const notes = [
      'Every figure is a sum of folio lines by charge date (the business date they were posted to). Total tax is every tax line, negative tax corrections included, so it reconciles exactly to the ledger.',
      'Taxable value is the room or service charges plus corrections to them. Room and service tax are traced to the charge each tax line was computed from; “Other tax” is any tax line that does not trace to one, and should be zero.',
      'CGST and SGST are not split. A tax line records its amount, not the slab it was computed under, and a half-and-half split would be an assumption rather than a figure from the books.',
      '“Closed-day snapshot” is the tax the night audit froze for that day, and is empty for days not yet closed.',
    ];
    if (mismatches.length > 0) {
      notes.push(
        `On ${mismatches.join(', ')} the ledger differs from the closed-day snapshot: a tax line was posted to that date after its night audit. Corrections belong on the current business date.`,
      );
    }

    return this.envelope(
      property,
      window,
      'tax',
      title,
      [
        { key: 'date', label: 'Date', kind: 'date' },
        { key: 'roomTaxableMinor', label: 'Room taxable value', kind: 'money' },
        { key: 'roomTaxMinor', label: 'Room tax', kind: 'money' },
        { key: 'serviceTaxableMinor', label: 'Service taxable value', kind: 'money' },
        { key: 'serviceTaxMinor', label: 'Service tax', kind: 'money' },
        { key: 'otherTaxMinor', label: 'Other tax', kind: 'money' },
        { key: 'totalTaxMinor', label: 'Total tax', kind: 'money' },
        { key: 'taxLines', label: 'Tax lines', kind: 'number' },
        { key: 'snapshotTaxMinor', label: 'Closed-day snapshot', kind: 'money' },
      ],
      rows,
      rows.length > 0 ? totals : null,
      notes,
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

  /** Capacity, rooms sold and rooms blocked per date, summed across room types. */
  private capacityByDate(
    inventory: readonly ReportInventoryRow[],
  ): Map<string, { physical: number; sold: number; blocked: number }> {
    const byDate = new Map<string, { physical: number; sold: number; blocked: number }>();
    for (const row of inventory) {
      const key = toBusinessDate(row.stayDate);
      const bucket = byDate.get(key) ?? { physical: 0, sold: 0, blocked: 0 };
      bucket.physical += row.physical;
      bucket.sold += row.sold;
      bucket.blocked += row.blocked;
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
