/**
 * The master report: every booking in a window, paginated and filterable.
 *
 * ===========================================================================
 * Its own service rather than another branch in `reports.service.ts`.
 *
 * The other reports answer one question each and return the whole answer. This
 * one is a queryable grid: four date dimensions, six column filters,
 * pagination, and totals that have to cover the filtered set rather than the
 * page. That is a different shape of thing, and bolting it into the switch
 * would have made the generic report envelope carry five fields only one
 * report uses.
 *
 * WHAT THE FIGURES ARE
 * `totalMinor` is the agreed value of the booking and `paidMinor` is what has
 * been collected against it. Both are reservation columns, and `paidMinor` is
 * maintained inside the same transaction as the folio payment line that moves
 * it (`FoliosService.postPayment`), which is the one case section 3.4 permits a
 * materialised total — so it cannot drift from the ledger. `balanceMinor` is
 * their difference, derived here and never stored: a third column able to
 * disagree with the two it comes from is a column that eventually does.
 *
 * Deliberately *not* the sum of posted folio lines. Mid-stay, only the elapsed
 * nights are posted, so a folio-line total would report a four-night booking
 * as worth one night — true of the ledger, wrong as the value of the booking,
 * which is what this report is read for.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  BOOKING_SOURCE_BUCKET,
  BOOKING_SOURCE_LABELS,
  MASTER_REPORT_DIMENSION_LABELS,
  resolveMasterReportColumns,
  Permission,
  permissionsForRoles,
  type BusinessDate,
  type MasterReportQuery,
  type MasterReportResponse,
  type MasterReportRow,
  type MasterReportTotals,
  type PropertyId,
} from '@repo/types';

import {
  EntityNotFoundError,
  ForbiddenError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import {
  ReportsRepository,
  type MasterReportFolioFigures,
  type MasterReportStayRow,
  type MasterReportWindow,
  type ReportPropertyRow,
} from './reports.repository.js';

const DAY_MS = 86_400_000;

/**
 * The widest window the report will run.
 *
 * Two years, which is long enough for a year-on-year comparison and short
 * enough that `count` and `aggregate` over it stay indexed rather than turning
 * into a sequential scan of a property's whole history.
 */
const MAX_WINDOW_DAYS = 732;

/**
 * How many bookings the folio-derived totals will aggregate over.
 *
 * Past this the id list is abandoned and those totals are omitted with a note.
 * Twenty thousand covers two years at a large property and keeps the one
 * unbounded query in this report from becoming a sequential scan.
 */
const FOLIO_TOTALS_CAP = 20_000;

/** A booking with no folio: every ledger figure is zero, not absent. */
const EMPTY_FIGURES: MasterReportFolioFigures = {
  roomRevenueMinor: 0,
  roomTaxMinor: 0,
  serviceNetMinor: 0,
  serviceTaxMinor: 0,
  onlinePaymentMinor: 0,
  offlinePaymentMinor: 0,
  refundMinor: 0,
  externalSourcePayment: 0,
  externalCardPayment: 0,
  paymentMethods: [],
  cardLast4: [],
  paymentIssuers: [],
};

/** An instant as `YYYY-MM-DD HH:MM` in the property's own zone. */
function formatInstant(instant: Date | null, timeZone: string): string | null {
  if (instant === null) return null;
  const local = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return `${local.toISOString().slice(0, 10)} ${local.toISOString().slice(11, 16)}`;
}

/**
 * A government ID as type plus last four digits.
 *
 * Never the whole number. See the column's own comment: a master report leaves
 * download folders and mailboxes, and a full identity document number in a
 * spreadsheet is a disclosure nobody asked for. Four digits is enough to match
 * a guest against the document they are holding.
 */
function maskIdentity(type: string | null, number: string | null): string | null {
  if (number === null || number.trim() === '') return type;
  const digits = number.replaceAll(/\s/gu, '');
  const tail = digits.slice(-4);
  const masked = `${'•'.repeat(Math.max(0, Math.min(8, digits.length - 4)))}${tail}`;
  return type === null ? masked : `${type} ${masked}`;
}

function toBusinessDate(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * The offset of a timezone at a given instant, in milliseconds.
 *
 * Reads the wall clock the zone shows at that instant and subtracts the
 * instant itself. Built on `Intl` rather than a date library, because adding
 * one for a single piece of arithmetic would be a runtime dependency the stack
 * does not need (CLAUDE.md section 6.4) — and `ClockService` already proves the
 * clock itself is injected, which is the part that matters for testability.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    // `hour12: false` can render midnight as 24, which Date.UTC would roll
    // into the next day.
    read('hour') % 24,
    read('minute'),
    read('second'),
  );

  return asIfUtc - instant.getTime();
}

/**
 * The instant a local calendar date begins in a given timezone.
 *
 * Guess UTC midnight, measure the zone's offset there, and correct. One
 * iteration is enough for every real zone: the correction only lands in a
 * different offset when a DST transition falls inside the offset itself, and
 * no zone shifts by more than its own offset at midnight.
 */
function zonedDayStart(date: BusinessDate, timeZone: string): Date {
  const guess = toUtcMidnight(date);
  return new Date(guess.getTime() - zoneOffsetMs(guess, timeZone));
}

@Injectable()
export class MasterReportService {
  constructor(private readonly repository: ReportsRepository) {}

  async run(
    userId: string,
    codeOrId: string,
    query: MasterReportQuery,
  ): Promise<MasterReportResponse> {
    const granted = await this.repository.findGrantedProperty(userId, codeOrId);
    if (granted === null) {
      // Not found, never forbidden: a 403 would confirm the property exists
      // to a caller holding no grant at it (CLAUDE.md section 3.2).
      throw new EntityNotFoundError('Property');
    }

    const { property, roles } = granted;
    if (!permissionsForRoles(roles).includes(Permission.FINANCIAL_REPORTS_READ)) {
      throw new ForbiddenError('Reading financial reports');
    }

    const window = this.resolveWindow(property, query);

    const page = await this.repository.findMasterReportPage(
      property.id,
      window,
      {
        bookingId: query.bookingId,
        guest: query.guest,
        source: query.source,
        status: query.status,
        roomType: query.roomType,
        room: query.room,
      },
      { skip: (query.page - 1) * query.limit, take: query.limit },
    );

    /**
     * The folio figures for the rows on screen.
     *
     * Bounded by the page size, so this is at most two hundred reservations
     * however large the window is. The totals below need the same figures
     * across the whole filtered set, which is a separate and deliberately
     * capped query.
     */
    const pageFigures = await this.repository.findMasterReportFolioFigures(
      property.id,
      page.rows.map((stay) => stay.id),
    );

    const rows = page.rows.map((stay) =>
      this.toRow(stay, property, pageFigures.get(stay.id) ?? EMPTY_FIGURES),
    );

    const columns = resolveMasterReportColumns(query.columns);
    const totals = await this.totalsFor(property.id, window, query, page);

    return {
      propertyId: property.id as PropertyId,
      propertyName: property.name,
      propertyCode: property.code,
      currency: property.currency,
      startDate: toBusinessDate(window.start),
      endDate: toBusinessDate(window.end),
      generatedFor: toBusinessDate(property.businessDate),
      dateDimension: query.dateDimension,

      columns: columns.map((column) => ({
        key: column.key,
        label: column.label,
        kind: column.kind,
      })),
      rows,
      totals: totals.totals,
      pagination: {
        total: page.total,
        page: query.page,
        limit: query.limit,
        pageCount: Math.max(1, Math.ceil(page.total / query.limit)),
      },
      notes: this.notesFor(query, page.total, totals.truncated),
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Totals                                                             */
  /* -------------------------------------------------------------------- */

  /**
   * Column totals over the whole filtered set.
   *
   * ===========================================================================
   * Two sources, one filter.
   *
   * The reservation-level sums come straight from the `aggregate` the page
   * query already ran. The folio-derived ones need the posted ledger, which
   * means resolving the filter to a list of ids and aggregating against it —
   * the only way to keep a single filter definition rather than writing a
   * second copy of it in SQL and watching the two drift.
   *
   * Past `FOLIO_TOTALS_CAP` the id list is abandoned and the folio-derived
   * totals are left out entirely, with a note saying so. A blank cell a reader
   * can ask about beats a figure quietly computed from a truncated set.
   * ===========================================================================
   */
  private async totalsFor(
    propertyId: string,
    window: MasterReportWindow,
    query: MasterReportQuery,
    page: {
      total: number;
      totals: {
        roomCount: number;
        totalMinor: number;
        paidMinor: number;
        taxMinor: number;
        otaPrepaidMinor: number;
        otaCommissionMinor: number;
        otaTaxMinor: number;
        otaNetMinor: number;
        promoMinor: number;
        depositMinor: number;
      };
    },
  ): Promise<{ totals: MasterReportTotals; truncated: boolean }> {
    const byColumn: Record<string, number> = {
      roomCount: page.totals.roomCount,
      totalMinor: page.totals.totalMinor,
      paidMinor: page.totals.paidMinor,
      // Derived from the two sums, which is the same arithmetic each row does
      // — so the total of the balance column equals the sum of the balances,
      // exactly.
      balanceMinor: page.totals.totalMinor - page.totals.paidMinor,
      // The booking value before tax, totalled the same way each row derives
      // it, so the column total equals the sum of the column.
      bookingAmountMinor: page.totals.totalMinor - page.totals.taxMinor,
      otaPrepaidMinor: page.totals.otaPrepaidMinor,
      otaCommissionMinor: page.totals.otaCommissionMinor,
      otaTaxMinor: page.totals.otaTaxMinor,
      otaNetMinor: page.totals.otaNetMinor,
      promoMinor: page.totals.promoMinor,
      depositMinor: page.totals.depositMinor,
    };

    const { ids, truncated } = await this.repository.findMasterReportIds(
      propertyId,
      window,
      {
        bookingId: query.bookingId,
        guest: query.guest,
        source: query.source,
        status: query.status,
        roomType: query.roomType,
        room: query.room,
      },
      FOLIO_TOTALS_CAP,
    );

    if (!truncated && ids.length > 0) {
      const figures = await this.repository.findMasterReportFolioFigures(propertyId, ids);
      const sum = (pick: (f: MasterReportFolioFigures) => number): number =>
        [...figures.values()].reduce((running, entry) => running + pick(entry), 0);

      byColumn['roomRevenueMinor'] = sum((f) => f.roomRevenueMinor);
      byColumn['roomTaxMinor'] = sum((f) => f.roomTaxMinor);
      byColumn['serviceNetMinor'] = sum((f) => f.serviceNetMinor);
      byColumn['serviceTaxMinor'] = sum((f) => f.serviceTaxMinor);
      byColumn['serviceGrossMinor'] =
        sum((f) => f.serviceNetMinor) + sum((f) => f.serviceTaxMinor);
      byColumn['onlinePaymentMinor'] = sum((f) => f.onlinePaymentMinor);
      byColumn['offlinePaymentMinor'] = sum((f) => f.offlinePaymentMinor);
      byColumn['refundMinor'] = sum((f) => f.refundMinor);
      byColumn['externalSourcePayment'] = sum((f) => f.externalSourcePayment);
      byColumn['externalCardPayment'] = sum((f) => f.externalCardPayment);
    }

    return { totals: { bookingCount: page.total, byColumn }, truncated };
  }

  /* -------------------------------------------------------------------- */
  /*  Mapping                                                            */
  /* -------------------------------------------------------------------- */

  private toRow(
    stay: MasterReportStayRow,
    property: ReportPropertyRow,
    figures: MasterReportFolioFigures,
  ): MasterReportRow {
    const timeZone = property.timezone;

    const numbers = stay.rooms
      .map((assignment) => assignment.room?.number)
      .filter((number): number is string => number !== undefined && number !== null);

    const types = [...new Set(stay.rooms.map((assignment) => assignment.roomType.name))];

    /**
     * The booking instant as the property saw it.
     *
     * `createdAt` is an instant; "booked on" is a calendar date in the
     * property's own zone. A booking taken at 00:30 IST is the 19th in Ujjain
     * and the 18th in UTC, and the report has to agree with the hotel.
     */
    const bookedLocal = new Date(
      stay.createdAt.getTime() + zoneOffsetMs(stay.createdAt, timeZone),
    );
    const bookedOn = toBusinessDate(bookedLocal);

    /**
     * Lead time in whole nights, floored at zero.
     *
     * A walk-in is booked and arrives the same day, which is zero rather than
     * a negative — and a back-dated fixture must not report "-3 days", which
     * reads as a data error to anyone scanning the column.
     */
    const leadTimeDays = Math.max(
      0,
      Math.round((stay.arrivalDate.getTime() - toUtcMidnight(bookedOn).getTime()) / DAY_MS),
    );

    const nights = Math.max(
      1,
      Math.round((stay.departureDate.getTime() - stay.arrivalDate.getTime()) / DAY_MS),
    );

    // The registered guest where one was captured, otherwise whoever booked.
    // A report column showing a blank address because the party was recorded
    // separately from the booker would read as missing data.
    const guest = stay.guests[0];

    /**
     * The tax rate this booking actually carried.
     *
     * Derived from its own figures rather than resolved from today's slab
     * table: a GST change since the booking was priced must not retroactively
     * re-rate a historical row. Zero where there is no tax to imply one from.
     */
    const taxableNet = stay.totalAmountMinor - stay.taxAmountMinor;
    const taxPercent =
      taxableNet <= 0 || stay.taxAmountMinor === 0
        ? 0
        : Math.round((stay.taxAmountMinor / taxableNet) * 10_000) / 100;

    return {
      reservationId: stay.id,
      bookingId: stay.confirmationCode,

      /* -- Booking ------------------------------------------------------ */
      bookedOn,
      // Wall clock in the property's zone, matching the date beside it.
      bookedAtTime: bookedLocal.toISOString().slice(11, 16),
      source: BOOKING_SOURCE_LABELS[BOOKING_SOURCE_BUCKET[stay.source]],
      status: stay.status,
      otaBookingId: stay.otaBookingId,
      companyGstin: stay.company?.gstin ?? null,
      // The calendar date in the property's own zone, like every other date
      // column — `cancelledAt` is an instant.
      cancelDate:
        stay.cancelledAt === null
          ? null
          : toBusinessDate(
              new Date(stay.cancelledAt.getTime() + zoneOffsetMs(stay.cancelledAt, timeZone)),
            ),
      bookingReference: stay.bookingReferenceId,
      segment: stay.segment,
      // Rendered as words rather than true/false: this column is read by a
      // person scanning for exceptions, and "Yes" stands out where "true"
      // reads as a serialisation leak. Null for the ordinary case, which the
      // viewer shows as a dash — a column of "No" down four hundred rows is
      // noise that hides the handful that matter.
      scantyBaggage: stay.scantyBaggage ? 'Yes' : null,
      complimentary: stay.isComplimentary ? 'Yes' : null,
      complimentaryRemarks: stay.complimentaryRemarks,
      otaPrepaidMinor: stay.otaPrepaidAmountMinor,

      /* -- Stay --------------------------------------------------------- */
      // Null rather than an empty string: the column is "room no.(s)" and an
      // unassigned booking genuinely has none, which the viewer renders as a
      // dash rather than a blank that looks like a rendering fault.
      rooms: numbers.length > 0 ? numbers.join(', ') : null,
      roomTypes: types.length > 0 ? types.join(', ') : null,
      // The board plan, which is the only rate-plan column this schema has —
      // see the note the response carries.
      ratePlans: stay.mealPlan,
      roomCount: stay.rooms.length,
      // Rooms multiplied by nights, which is the unit occupancy is measured
      // in — two rooms for three nights is six room-nights, not three.
      roomNights: Math.max(stay.rooms.length, 1) * nights,
      arrival: toBusinessDate(stay.arrivalDate),
      departure: toBusinessDate(stay.departureDate),
      // The property's standard desk times: what the booking was sold against.
      scheduledCheckInTime: property.checkInTime,
      scheduledCheckOutTime: property.checkOutTime,
      actualCheckIn: formatInstant(stay.checkedInAt, timeZone),
      actualCheckOut: formatInstant(stay.checkedOutAt, timeZone),
      leadTimeDays,

      /* -- Guest -------------------------------------------------------- */
      guest: `${stay.guestFirstName} ${stay.guestLastName}`.trim(),
      adults: stay.adults,
      children: stay.children,
      infants: stay.infants,
      /**
       * Masked, deliberately.
       *
       * This is a government identity number. A master report is exported,
       * mailed and left in download folders, and a full Aadhaar or passport
       * number in a spreadsheet is a disclosure nobody intended. The type and
       * the last four digits are enough to match a guest against the document
       * at the desk, which is what the column is for; the registration card
       * holds the rest.
       */
      customerIdentification: maskIdentity(
        guest?.govtIdType ?? stay.govtIdType,
        guest?.govtIdNumber ?? stay.govtIdNumber,
      ),
      customerEmail: guest?.email ?? stay.guestEmail,
      customerPhone: guest?.phone ?? stay.guestPhone,
      customerAddressLine1: guest?.addressLine1 ?? null,
      customerAddressLine2: guest?.addressLine2 ?? null,
      customerCity: guest?.city ?? null,
      customerState: guest?.state ?? null,
      customerCountry: guest?.countryCode ?? null,
      customerZipcode: guest?.postalCode ?? null,
      specialRequests: guest?.specialRequest ?? null,

      /* -- Financial ---------------------------------------------------- */
      totalMinor: stay.totalAmountMinor,
      balanceMinor: stay.totalAmountMinor - stay.paidAmountMinor,
      // The agreed value before tax. Distinct from the total, which is what
      // the guest pays.
      bookingAmountMinor: taxableNet,
      roomRevenueMinor: figures.roomRevenueMinor,
      roomTaxMinor: figures.roomTaxMinor,
      taxPercent,
      serviceNetMinor: figures.serviceNetMinor,
      serviceTaxMinor: figures.serviceTaxMinor,
      serviceGrossMinor: figures.serviceNetMinor + figures.serviceTaxMinor,
      otaCommissionMinor: stay.otaCommissionMinor,
      otaTaxMinor: stay.otaTaxMinor,
      // What the channel remits, as recorded — not `total - commission - tax`.
      // Channels withhold differently and settle in batches, and deriving it
      // would make every discrepancy invisible to a reconciliation.
      otaNetMinor: stay.otaNetAmountMinor,
      promoMinor: stay.promoAmountMinor,
      customFolioId: stay.folio?.customFolioId ?? null,

      /* -- Payment ------------------------------------------------------ */
      paidMinor: stay.paidAmountMinor,
      onlinePaymentMinor: figures.onlinePaymentMinor,
      offlinePaymentMinor: figures.offlinePaymentMinor,
      refundMinor: figures.refundMinor,
      // Held, not collected: a deposit is the property holding the guest's
      // money back, so it is reported beside the payments rather than inside
      // `paidMinor`, which would understate the balance due.
      depositMinor: stay.depositMinor,
      externalSourcePayment: figures.externalSourcePayment,
      externalCardPayment: figures.externalCardPayment,
      cardLast4: figures.cardLast4.length > 0 ? figures.cardLast4.join(', ') : null,
      paymentIssuer:
        figures.paymentIssuers.length > 0 ? figures.paymentIssuers.join(', ') : null,
      // The instruments actually used, which is what a transaction type means
      // for a payment taken at a desk.
      transactionType:
        figures.paymentMethods.length > 0 ? figures.paymentMethods.join(', ') : null,
      couponCode: stay.appliedCouponCode,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Window                                                             */
  /* -------------------------------------------------------------------- */

  private resolveWindow(
    property: ReportPropertyRow,
    query: MasterReportQuery,
  ): MasterReportWindow {
    const businessDate = toBusinessDate(property.businessDate);
    const start = query.startDate ?? businessDate;
    const end = query.endDate ?? start;

    if (end < start) {
      throw new ValidationFailedError({
        endDate: `endDate ${end} must not be before startDate ${start}.`,
      });
    }

    const days =
      Math.round(
        (toUtcMidnight(end).getTime() - toUtcMidnight(start).getTime()) / DAY_MS,
      ) + 1;
    if (days > MAX_WINDOW_DAYS) {
      throw new ValidationFailedError({
        startDate: `A master report covers at most ${String(MAX_WINDOW_DAYS)} days; this asked for ${String(days)}.`,
      });
    }

    return {
      dimension: query.dateDimension,
      start: toUtcMidnight(start),
      end: toUtcMidnight(end),
      endExclusive: addDays(toUtcMidnight(end), 1),
      // The `BOOKED` dimension's boundaries, in the property's own zone.
      createdFrom: zonedDayStart(start, property.timezone),
      createdUntil: zonedDayStart(toBusinessDate(addDays(toUtcMidnight(end), 1)), property.timezone),
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Caveats                                                            */
  /* -------------------------------------------------------------------- */

  /**
   * What a reader needs to know before acting on these numbers.
   *
   * Returned with the data rather than written on the page, so the same
   * caveats travel into the CSV and anywhere else the response goes. A figure
   * with a known approximation in it should carry that approximation wherever
   * it goes.
   */
  private notesFor(
    query: MasterReportQuery,
    total: number,
    truncated: boolean,
  ): string[] {
    const notes: string[] = [
      `Filtered on ${MASTER_REPORT_DIMENSION_LABELS[query.dateDimension].toLowerCase()}.`,
      'Totals cover every booking matching the filters, not just the page shown.',
    ];

    if (query.status === undefined) {
      notes.push(
        'Cancellations and no-shows are included, so the totals are gross ' +
          'booking value rather than revenue. Filter the status column to ' +
          'separate them.',
      );
    }

    notes.push(
      'Rate plans show the board plan (EP, CP, MAP, AP). Per-person rate-plan ' +
        'pricing needs the rates module, which is not built.',
    );

    if (truncated) {
      notes.push(
        `More than ${String(FOLIO_TOTALS_CAP)} bookings matched, so the ` +
          'ledger-derived totals (room revenue, taxes, service and payment ' +
          'split) are omitted rather than computed from part of the set. ' +
          'Narrow the window to see them.',
      );
    }

    if (total === 0) {
      notes.push('No bookings matched. Widen the window or clear a column filter.');
    }

    return notes;
  }
}
