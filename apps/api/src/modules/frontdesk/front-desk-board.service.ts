/**
 * The arrivals / departures board (FD-09).
 *
 * ===========================================================================
 * Read-only. One reservation query for every row on the board, so arrivals,
 * departures and in-house come from the same read, then one balance query when
 * the caller may see money.
 *
 * "Today" is the property's business date (CLAUDE.md 3.3), not the server's
 * clock: until the night audit rolls the date, last night's late arrivals are
 * still today's work. The one place a clock instant is read is a check-out's
 * timestamp, to tell a guest who left early today from one who left early on
 * an earlier day; it is converted in the property's own time zone.
 *
 * The balance is the folio's posted balance -- the signed sum of its lines,
 * the same figure check-out refuses on (section 3.4: derived, never cached).
 * It is withheld (null) from a caller without `folio:read`: the board needs
 * only `reservations:read`, which roles blind to money also hold.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  Permission,
  permissionsForRoles,
  ReservationStatus,
  type FrontDeskBoard,
  type FrontDeskRow,
  type FrontDeskRowFlag,
  type Role,
} from '@repo/types';

import { ForbiddenError, TenantScopeViolationError } from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const DAY_MS = 86_400_000;
/** Room states a guest can be put into. */
const READY = new Set(['VACANT_CLEAN', 'INSPECTED']);
/** A front desk reads a day at a time; a bound keeps a backlog from flooding it. */
const MAX_ROWS = 500;

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The calendar date of an instant in an IANA time zone, as YYYY-MM-DD. */
function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

const FLAG_ORDER: Record<FrontDeskRowFlag, number> = {
  OVERDUE_ARRIVAL: 0,
  DUE_IN: 1,
  ARRIVED: 2,
  OVERSTAY: 0,
  DUE_OUT: 1,
  DEPARTED: 2,
  STAYING: 0,
};

@Injectable()
export class FrontDeskBoardService {
  constructor(private readonly prisma: PrismaService) {}

  async board(userId: string, hotelId: string): Promise<FrontDeskBoard> {
    const caller = await this.authorise(userId, hotelId);
    const { propertyId, timezone } = caller;
    const today = toBusinessDate(caller.businessDate);
    const todayDate = caller.businessDate;

    const rows = await this.prisma.client.reservation.findMany({
      where: {
        propertyId,
        OR: [
          // Due in today, and overdue arrivals.
          { status: ReservationStatus.CONFIRMED, arrivalDate: { lte: todayDate } },
          // Everyone in the house (arrived today, due out, overstaying, staying).
          { status: ReservationStatus.CHECKED_IN },
          // Left today: on the departure date, or early. The check-out instant
          // bounds the read; the exact local date is checked below.
          {
            status: ReservationStatus.CHECKED_OUT,
            departureDate: { gte: todayDate },
            checkedOutAt: { gte: new Date(todayDate.getTime() - DAY_MS) },
          },
        ],
      },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        guestFirstName: true,
        guestLastName: true,
        currency: true,
        checkedOutAt: true,
        rooms: {
          select: {
            roomType: { select: { name: true } },
            room: { select: { number: true, status: true } },
          },
          take: 1,
        },
        folio: { select: { id: true } },
      },
      orderBy: [{ arrivalDate: 'asc' }, { confirmationCode: 'asc' }],
      take: MAX_ROWS,
    });

    const balances = new Map<string, number>();
    if (caller.showsBalances) {
      const folioIds = rows.flatMap((row) => (row.folio === null ? [] : [row.folio.id]));
      if (folioIds.length > 0) {
        const sums = await this.prisma.client.folioLine.groupBy({
          by: ['folioId'],
          where: { propertyId, folioId: { in: folioIds } },
          _sum: { amountMinor: true },
        });
        for (const sum of sums) balances.set(sum.folioId, sum._sum.amountMinor ?? 0);
      }
    }

    const arrivals: FrontDeskRow[] = [];
    const departures: FrontDeskRow[] = [];
    const inHouse: FrontDeskRow[] = [];

    for (const row of rows) {
      const arrival = toBusinessDate(row.arrivalDate);
      const departure = toBusinessDate(row.departureDate);
      const assignment = row.rooms[0];
      const room = assignment?.room ?? null;

      const make = (flag: FrontDeskRowFlag): FrontDeskRow => ({
        reservationId: row.id,
        bookingCode: row.confirmationCode,
        guestName: `${row.guestFirstName} ${row.guestLastName}`.trim(),
        status: row.status,
        flag,
        arrivalDate: arrival as FrontDeskRow['arrivalDate'],
        departureDate: departure as FrontDeskRow['departureDate'],
        nights: Math.max(0, Math.round((row.departureDate.getTime() - row.arrivalDate.getTime()) / DAY_MS)),
        adults: row.adults,
        children: row.children,
        roomTypeName: assignment?.roomType.name ?? null,
        roomNumber: room?.number ?? null,
        roomStatus: room?.status ?? null,
        roomReady: room !== null && READY.has(room.status),
        balanceMinor: caller.showsBalances
          ? row.folio === null
            ? 0
            : (balances.get(row.folio.id) ?? 0)
          : null,
        currency: row.currency,
      });

      switch (row.status) {
        case ReservationStatus.CONFIRMED:
          arrivals.push(make(arrival < today ? 'OVERDUE_ARRIVAL' : 'DUE_IN'));
          break;
        case ReservationStatus.CHECKED_IN: {
          if (arrival === today) arrivals.push(make('ARRIVED'));
          if (departure < today) departures.push(make('OVERSTAY'));
          else if (departure === today) departures.push(make('DUE_OUT'));
          inHouse.push(make('STAYING'));
          break;
        }
        case ReservationStatus.CHECKED_OUT: {
          // Departed today: by this property's clock, or before the audit
          // rolled the date (a 1am check-out still belongs to the business day).
          const left = row.checkedOutAt === null ? null : localDate(row.checkedOutAt, timezone);
          if (left !== null && left >= today) departures.push(make('DEPARTED'));
          break;
        }
        default:
          break;
      }
    }

    const byFlagThenRoom = (a: FrontDeskRow, b: FrontDeskRow): number =>
      FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag] ||
      (a.roomNumber ?? '~').localeCompare(b.roomNumber ?? '~', undefined, { numeric: true }) ||
      a.guestName.localeCompare(b.guestName);
    arrivals.sort(byFlagThenRoom);
    departures.sort(byFlagThenRoom);
    inHouse.sort(byFlagThenRoom);

    const count = (list: FrontDeskRow[], flag: FrontDeskRowFlag) =>
      list.filter((row) => row.flag === flag).length;

    return {
      businessDate: today as FrontDeskBoard['businessDate'],
      showsBalances: caller.showsBalances,
      arrivals,
      departures,
      inHouse,
      counts: {
        dueIn: count(arrivals, 'DUE_IN'),
        arrived: count(arrivals, 'ARRIVED'),
        overdueArrivals: count(arrivals, 'OVERDUE_ARRIVAL'),
        dueOut: count(departures, 'DUE_OUT'),
        departed: count(departures, 'DEPARTED'),
        overstays: count(departures, 'OVERSTAY'),
        inHouse: inHouse.length,
      },
    };
  }

  private async authorise(
    userId: string,
    codeOrId: string,
  ): Promise<{ propertyId: string; businessDate: Date; timezone: string; showsBalances: boolean }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, businessDate: true, timezone: true } },
      },
    });
    const first = grants[0];
    // Not-found, never 403, for a property the caller has no grant at (3.2).
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);
    const held = permissionsForRoles(roles);
    if (!held.includes(Permission.RESERVATIONS_READ)) {
      throw new ForbiddenError(Permission.RESERVATIONS_READ);
    }

    return {
      propertyId: first.property.id,
      businessDate: first.property.businessDate,
      timezone: first.property.timezone,
      showsBalances: held.includes(Permission.FOLIO_READ),
    };
  }
}
