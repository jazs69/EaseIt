/**
 * Persistence for property reports.
 *
 * Every query is scoped by `propertyId` as its first condition, and the
 * property itself is resolved through the caller's own grants, so a report can
 * never be run against a hotel the caller holds no role at
 * (CLAUDE.md section 3.2).
 */

import { Injectable } from '@nestjs/common';
import { BookingSource, OPERABLE_PROPERTY_STATUSES, ReservationStatus } from '@repo/types';
import type { MasterReportDimension, MealPlan, Role } from '@repo/types';
import { Prisma } from '@repo/database';

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
  /** Scheduled desk times, `HH:MM` in the property's own zone. */
  checkInTime: string;
  checkOutTime: string;
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

/**
 * The resolved window, with every boundary the dimensions need.
 *
 * Computed once by the service so the repository does no date arithmetic and
 * no timezone conversion — the `createdAt` boundaries in particular depend on
 * the property's zone, which is a domain fact rather than a query detail.
 */
export interface MasterReportWindow {
  dimension: MasterReportDimension;
  /** UTC midnight of the first day, for the `@db.Date` columns. */
  start: Date;
  /** UTC midnight of the last day, inclusive. */
  end: Date;
  /** UTC midnight of the day after the last, for half-open comparisons. */
  endExclusive: Date;
  /** The instant the window opens in the property's own timezone. */
  createdFrom: Date;
  /** The instant it closes, exclusive. */
  createdUntil: Date;
}

export interface MasterReportFilters {
  bookingId?: string | undefined;
  guest?: string | undefined;
  source?: string | undefined;
  status?: string | undefined;
  roomType?: string | undefined;
  room?: string | undefined;
}

/** What the posted ledger says about one booking. */
export interface MasterReportFolioFigures {
  roomRevenueMinor: number;
  roomTaxMinor: number;
  serviceNetMinor: number;
  serviceTaxMinor: number;
  onlinePaymentMinor: number;
  offlinePaymentMinor: number;
  refundMinor: number;
  externalSourcePayment: number;
  externalCardPayment: number;
  /** Distinct payment instruments used, for the transaction-type column. */
  paymentMethods: string[];
  /** Last four digits of the cards used, and their issuers. */
  cardLast4: string[];
  paymentIssuers: string[];
}

export interface MasterReportStayRow {
  id: string;
  confirmationCode: string;
  status: ReservationStatus;
  source: BookingSource;
  mealPlan: MealPlan;
  adults: number;
  children: number;
  infants: number;
  arrivalDate: Date;
  departureDate: Date;
  createdAt: Date;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  otaBookingId: string | null;
  govtIdType: string | null;
  govtIdNumber: string | null;
  cancelledAt: Date | null;
  bookingReferenceId: string | null;
  segment: string | null;
  scantyBaggage: boolean;
  isComplimentary: boolean;
  complimentaryRemarks: string | null;
  otaPrepaidAmountMinor: number;
  otaCommissionMinor: number;
  otaTaxMinor: number;
  otaNetAmountMinor: number;
  promoAmountMinor: number;
  appliedCouponCode: string | null;
  depositMinor: number;
  folio: { customFolioId: string | null } | null;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  totalAmountMinor: number;
  paidAmountMinor: number;
  taxAmountMinor: number;
  company: { gstin: string } | null;
  rooms: { room: { number: string } | null; roomType: { name: string } }[];
  /** The primary guest, where one was captured beyond the booker. */
  guests: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    countryCode: string | null;
    govtIdType: string | null;
    govtIdNumber: string | null;
    specialRequest: string | null;
  }[];
}

/**
 * The enum members whose name contains the needle.
 *
 * An enum column cannot take a `contains`, so a free-text filter has to be
 * resolved to members before it reaches the query. Doing it this way keeps the
 * behaviour a reader expects from a search box — typing "CHECKED" matches both
 * CHECKED_IN and CHECKED_OUT — and a needle matching nothing produces an empty
 * `in`, so the table correctly shows no rows rather than ignoring the filter.
 */
function matchingStatuses(needle: string): ReservationStatus[] {
  const wanted = needle.trim().toUpperCase().replaceAll(/[\s-]+/gu, '_');
  return Object.values(ReservationStatus).filter((value) => value.includes(wanted));
}

function matchingSources(needle: string): BookingSource[] {
  const wanted = needle.trim().toUpperCase().replaceAll(/[\s-]+/gu, '_');
  return Object.values(BookingSource).filter((value) => value.includes(wanted));
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
            checkInTime: true,
            checkOutTime: true,
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

  /**
   * One page of the master report, plus totals over the whole filtered set.
   *
   * ===========================================================================
   * Two queries against one `where`, deliberately.
   *
   * The page is a `findMany` with a skip/take; the totals are an `aggregate`
   * and a `count` over the *same* filter with no paging. Summing the page
   * instead would put a figure labelled "Total" under a table showing ten of
   * four hundred bookings, which is worse than showing no total at all.
   *
   * Building the `where` once and handing it to all three is what guarantees
   * they agree. A second hand-written copy of the filter is how a totals row
   * starts counting rows the table does not show.
   *
   * **Every status is included**, unlike `findStays`, which narrows to the
   * earning ones. A master report is a transaction history: a cancellation and
   * a no-show are things that happened and a reader looking for them needs to
   * find them. The consequence is that the totals are gross booking value
   * rather than revenue, which the service states as a note rather than
   * leaving the reader to infer.
   * ===========================================================================
   */
  async findMasterReportPage(
    propertyId: string,
    window: MasterReportWindow,
    filters: MasterReportFilters,
    paging: { skip: number; take: number },
  ): Promise<{
    rows: MasterReportStayRow[];
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
  }> {
    const where = this.masterReportWhere(propertyId, window, filters);

    const [rows, total, sums, roomCount] = await Promise.all([
      this.prisma.client.reservation.findMany({
        where,
        select: {
          id: true,
          confirmationCode: true,
          status: true,
          source: true,
          mealPlan: true,
          adults: true,
          children: true,
          infants: true,
          arrivalDate: true,
          departureDate: true,
          createdAt: true,
          checkedInAt: true,
          checkedOutAt: true,
          otaBookingId: true,
          govtIdType: true,
          govtIdNumber: true,
          cancelledAt: true,
          bookingReferenceId: true,
          segment: true,
          scantyBaggage: true,
          isComplimentary: true,
          complimentaryRemarks: true,
          otaPrepaidAmountMinor: true,
          otaCommissionMinor: true,
          otaTaxMinor: true,
          otaNetAmountMinor: true,
          promoAmountMinor: true,
          appliedCouponCode: true,
          depositMinor: true,
          folio: { select: { customFolioId: true } },
          guestFirstName: true,
          guestLastName: true,
          guestEmail: true,
          guestPhone: true,
          totalAmountMinor: true,
          paidAmountMinor: true,
          taxAmountMinor: true,
          company: { select: { gstin: true } },
          rooms: {
            select: {
              room: { select: { number: true } },
              roomType: { select: { name: true } },
            },
            orderBy: { arrivalDate: 'asc' },
          },
          // The registered guest, who may differ from whoever booked. Only
          // the first: this is one row per booking, and a report column
          // cannot hold a party of four.
          guests: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              postalCode: true,
              countryCode: true,
              govtIdType: true,
              govtIdNumber: true,
              specialRequest: true,
            },
            orderBy: { ordinal: 'asc' },
            take: 1,
          },
        },
        // Newest booking first: a master report is read as a history, and the
        // thing a reader is looking for is almost always recent.
        orderBy: [{ createdAt: 'desc' }, { confirmationCode: 'desc' }],
        skip: paging.skip,
        take: paging.take,
      }),
      this.prisma.client.reservation.count({ where }),
      this.prisma.client.reservation.aggregate({
        where,
        _sum: {
          totalAmountMinor: true,
          paidAmountMinor: true,
          // The reservation-level money columns the report can total without
          // touching the ledger, so these come free with the page query.
          taxAmountMinor: true,
          otaPrepaidAmountMinor: true,
          otaCommissionMinor: true,
          otaTaxMinor: true,
          otaNetAmountMinor: true,
          promoAmountMinor: true,
          depositMinor: true,
        },
      }),
      // Rooms are a child table, so the count cannot come from the aggregate
      // above — a reservation with three rooms is one row and three rooms.
      this.prisma.client.reservationRoom.count({ where: { reservation: where } }),
    ]);

    return {
      rows,
      total,
      totals: {
        roomCount,
        // `_sum` is null when nothing matched, which is zero rather than
        // absent — a report of no bookings totals ₹0, not blank.
        totalMinor: sums._sum.totalAmountMinor ?? 0,
        paidMinor: sums._sum.paidAmountMinor ?? 0,
        taxMinor: sums._sum.taxAmountMinor ?? 0,
        otaPrepaidMinor: sums._sum.otaPrepaidAmountMinor ?? 0,
        otaCommissionMinor: sums._sum.otaCommissionMinor ?? 0,
        otaTaxMinor: sums._sum.otaTaxMinor ?? 0,
        otaNetMinor: sums._sum.otaNetAmountMinor ?? 0,
        promoMinor: sums._sum.promoAmountMinor ?? 0,
        depositMinor: sums._sum.depositMinor ?? 0,
      },
    };
  }

  /**
   * Every reservation id matching the filter, for aggregating folio lines.
   *
   * Ids only, and no paging: the folio-derived totals have to cover the same
   * set the table describes, and the only way to keep one filter definition is
   * to resolve it once and hand the result to both consumers. A second copy of
   * the filter written in SQL is how a totals row starts counting rows the
   * table does not show.
   *
   * Capped, because this is the one unbounded query in the report. Past the
   * cap the caller omits the folio-derived totals and says so, which is better
   * than either a timeout or a figure quietly computed from a truncated set.
   */
  async findMasterReportIds(
    propertyId: string,
    window: MasterReportWindow,
    filters: MasterReportFilters,
    cap: number,
  ): Promise<{ ids: string[]; truncated: boolean }> {
    const rows = await this.prisma.client.reservation.findMany({
      where: this.masterReportWhere(propertyId, window, filters),
      select: { id: true },
      take: cap + 1,
    });

    return {
      ids: rows.slice(0, cap).map((row) => row.id),
      truncated: rows.length > cap,
    };
  }

  /**
   * Folio figures per reservation, from the posted ledger.
   *
   * ===========================================================================
   * Raw SQL, because room tax and service tax are only distinguishable by the
   * kind of the line each one hangs off.
   *
   * A TAX line carries `derivedFromLineId` pointing at the charge it was
   * computed from, so separating "cumulative room taxes" from "service taxes"
   * means joining `folio_line` to itself and reading the parent's kind. Prisma
   * cannot express that join inside an aggregate, which is exactly the case
   * CLAUDE.md section 2 permits `$queryRaw` for. Parameterised throughout.
   *
   * Reversed lines are excluded from the room-charge sum. A correction posts a
   * reversing line beside the original rather than editing it, so counting
   * both would report a corrected night twice.
   *
   * Payments are stored negative — a payment reduces what is owed — so they
   * are negated here to read as positive amounts collected. The split between
   * online and offline is by instrument: UPI, card and bank transfer clear
   * through a system, cash and cheque are handed over a desk.
   * ===========================================================================
   */
  async findMasterReportFolioFigures(
    propertyId: string,
    reservationIds: readonly string[],
  ): Promise<Map<string, MasterReportFolioFigures>> {
    if (reservationIds.length === 0) return new Map();

    const rows = await this.prisma.client.$queryRaw<
      {
        reservationId: string;
        roomRevenue: bigint;
        roomTax: bigint;
        serviceNet: bigint;
        serviceTax: bigint;
        onlinePaid: bigint;
        offlinePaid: bigint;
        refund: bigint;
        externalSource: bigint;
        externalCard: bigint;
        methods: string[] | null;
        cards: string[] | null;
        issuers: string[] | null;
      }[]
    >`
      SELECT
        f."reservationId"                                                   AS "reservationId",
        COALESCE(SUM(CASE WHEN l."kind" = 'ROOM_CHARGE'
                           AND l."reversesLineId" IS NULL
                          THEN l."amountMinor" ELSE 0 END), 0)              AS "roomRevenue",
        COALESCE(SUM(CASE WHEN l."kind" = 'TAX' AND p."kind" = 'ROOM_CHARGE'
                          THEN l."amountMinor" ELSE 0 END), 0)              AS "roomTax",
        COALESCE(SUM(CASE WHEN l."kind" = 'SERVICE_CHARGE'
                           AND l."reversesLineId" IS NULL
                          THEN l."amountMinor" ELSE 0 END), 0)              AS "serviceNet",
        COALESCE(SUM(CASE WHEN l."kind" = 'TAX' AND p."kind" = 'SERVICE_CHARGE'
                          THEN l."amountMinor" ELSE 0 END), 0)              AS "serviceTax",
        COALESCE(SUM(CASE WHEN l."kind" = 'PAYMENT'
                           AND l."paymentMethod" IN ('UPI', 'CARD', 'BANK_TRANSFER')
                          THEN -l."amountMinor" ELSE 0 END), 0)             AS "onlinePaid",
        COALESCE(SUM(CASE WHEN l."kind" = 'PAYMENT'
                           AND (l."paymentMethod" IS NULL
                                OR l."paymentMethod" IN ('CASH', 'CHEQUE', 'OTHER'))
                          THEN -l."amountMinor" ELSE 0 END), 0)             AS "offlinePaid",
        COALESCE(SUM(CASE WHEN l."kind" = 'REFUND'
                          THEN l."amountMinor" ELSE 0 END), 0)              AS "refund",
        COALESCE(SUM(CASE WHEN l."kind" = 'PAYMENT' AND l."isExternalSource"
                          THEN -l."amountMinor" ELSE 0 END), 0)             AS "externalSource",
        COALESCE(SUM(CASE WHEN l."kind" = 'PAYMENT' AND l."isExternalCard"
                          THEN -l."amountMinor" ELSE 0 END), 0)             AS "externalCard",
        ARRAY_AGG(DISTINCT l."paymentMethod"::text)
          FILTER (WHERE l."kind" = 'PAYMENT' AND l."paymentMethod" IS NOT NULL)
                                                                            AS "methods",
        ARRAY_AGG(DISTINCT l."cardLast4")
          FILTER (WHERE l."cardLast4" IS NOT NULL)                          AS "cards",
        ARRAY_AGG(DISTINCT l."paymentIssuer")
          FILTER (WHERE l."paymentIssuer" IS NOT NULL)                      AS "issuers"
      FROM "folio" f
      JOIN "folio_line" l ON l."folioId" = f."id"
      LEFT JOIN "folio_line" p ON p."id" = l."derivedFromLineId"
      WHERE f."propertyId" = ${propertyId}::uuid
        AND f."reservationId" = ANY(${reservationIds}::uuid[])
      GROUP BY f."reservationId"
    `;

    return new Map(
      rows.map((row) => [
        row.reservationId,
        {
          // Postgres SUM returns bigint; every figure here is minor units and
          // well inside the safe-integer range, so the narrowing is lossless.
          roomRevenueMinor: Number(row.roomRevenue),
          roomTaxMinor: Number(row.roomTax),
          serviceNetMinor: Number(row.serviceNet),
          serviceTaxMinor: Number(row.serviceTax),
          onlinePaymentMinor: Number(row.onlinePaid),
          offlinePaymentMinor: Number(row.offlinePaid),
          refundMinor: Number(row.refund),
          externalSourcePayment: Number(row.externalSource),
          externalCardPayment: Number(row.externalCard),
          paymentMethods: row.methods ?? [],
          // `CHAR(4)` comes back space-padded, which would render as "1234 ".
          cardLast4: (row.cards ?? []).map((card) => card.trim()),
          paymentIssuers: row.issuers ?? [],
        },
      ]),
    );
  }

  /**
   * The filter every master-report query shares.
   *
   * ===========================================================================
   * `propertyId` leads, as it must (CLAUDE.md section 3.2), and the date
   * dimension decides which column the window applies to.
   *
   * Three of the four dimensions test `@db.Date` columns, where comparing
   * against UTC midnight is exactly right because that is how they are stored.
   * `BOOKED` is the exception and the reason this needs saying: `createdAt` is
   * a `timestamptz`, an instant, and "booked on the 19th" means the 19th *in
   * the property's own timezone*. Comparing an instant against UTC midnight
   * would put every booking made in India between midnight and 5:30am on the
   * previous day's report — which is most of a night-audit window.
   * ===========================================================================
   */
  private masterReportWhere(
    propertyId: string,
    window: MasterReportWindow,
    filters: MasterReportFilters,
  ): Prisma.ReservationWhereInput {
    const dateFilter = ((): Prisma.ReservationWhereInput => {
      switch (window.dimension) {
        case 'CHECKIN':
          return { arrivalDate: { gte: window.start, lte: window.end } };
        case 'BOOKED':
          return { createdAt: { gte: window.createdFrom, lt: window.createdUntil } };
        case 'STAY':
          // Overlap, half-open on the departure side: a stay that checked out
          // on the window's first morning sold no night inside it.
          return {
            arrivalDate: { lt: window.endExclusive },
            departureDate: { gt: window.start },
          };
        case 'CHECKOUT':
        default:
          return { departureDate: { gte: window.start, lte: window.end } };
      }
    })();

    // Case-insensitive substring on each supplied filter. Absent filters
    // contribute nothing rather than an always-true clause, so the planner
    // sees the same shape it would without the feature.
    const text: Prisma.ReservationWhereInput[] = [];
    if (filters.bookingId !== undefined) {
      text.push({ confirmationCode: { contains: filters.bookingId, mode: 'insensitive' } });
    }
    if (filters.guest !== undefined) {
      // Matched against either name part, so "jain" finds a guest whose
      // surname it is and "siddharth" finds the same booking.
      text.push({
        OR: [
          { guestFirstName: { contains: filters.guest, mode: 'insensitive' } },
          { guestLastName: { contains: filters.guest, mode: 'insensitive' } },
        ],
      });
    }
    if (filters.source !== undefined) {
      // An enum column cannot take `contains`, so the needle is resolved to
      // the matching enum members first — which also means a filter matching
      // nothing yields no rows rather than being silently ignored.
      text.push({ source: { in: matchingSources(filters.source) } });
    }
    if (filters.status !== undefined) {
      text.push({ status: { in: matchingStatuses(filters.status) } });
    }
    if (filters.roomType !== undefined) {
      text.push({
        rooms: { some: { roomType: { name: { contains: filters.roomType, mode: 'insensitive' } } } },
      });
    }
    if (filters.room !== undefined) {
      text.push({
        rooms: { some: { room: { number: { contains: filters.room, mode: 'insensitive' } } } },
      });
    }

    return { propertyId, ...dateFilter, ...(text.length > 0 ? { AND: text } : {}) };
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
