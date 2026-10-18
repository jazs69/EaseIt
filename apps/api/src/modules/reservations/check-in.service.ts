/**
 * Front-desk check-in.
 *
 * ===========================================================================
 * One transaction, five mutations, nothing partial.
 *
 * Checking a guest in moves five things at once: the reservation's status, the
 * assignment, the room's occupancy, a folio into existence with the arrival
 * night on it, and an audit row. Any subset of those is a broken state that
 * somebody has to repair by hand — a guest marked in with no folio cannot be
 * charged; a folio with no occupied room leaves the room sellable twice. So
 * they commit together or not at all.
 *
 * The side effects themselves live in `check-in-posting.ts`, shared with the
 * create-reservation path's "check in now" box, so the two pathways cannot
 * drift. What lives here is the decision: may this guest check in, and into
 * which room.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  OVERRIDABLE_BLOCKERS,
  Permission,
  currentDateInTimeZone,
  permissionsForRoles,
  ReservationStatus,
  type CheckInBlocker,
  type CheckInPreflight,
  type CheckInRequest,
  type CheckInResult,
  type PropertyId,
  type Role,
  type RoomId,
} from '@repo/types';

import {
  ForbiddenError,
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import {
  isCleanRoomState,
  isOccupiedRoomState,
  postCheckIn,
  toBusinessDateString,
} from './check-in-posting.js';

const DAY_MS = 86_400_000;

/** Statuses that are a broken transition rather than unfinished desk work. */
const STATE_BLOCKERS: readonly CheckInBlocker[] = [
  'ALREADY_CHECKED_IN',
  'ALREADY_CHECKED_OUT',
  'CANCELLED',
  'NO_SHOW',
  'NOT_CONFIRMED',
];

/** `XXXX-1234`. The raw number never leaves the server (section 5). */
function maskGovtId(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 4) return 'XXXX';
  const groups = Math.max(1, Math.ceil((trimmed.length - 4) / 4));
  return `${Array.from({ length: groups }, () => 'XXXX').join('-')}-${trimmed.slice(-4)}`;
}

function nightsBetween(arrival: Date, departure: Date): number {
  return Math.max(1, Math.round((departure.getTime() - arrival.getTime()) / DAY_MS));
}

@Injectable()
export class CheckInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /* -------------------------------------------------------------------- */
  /*  Pre-flight                                                           */
  /* -------------------------------------------------------------------- */

  /**
   * Everything the modal needs, committing to nothing.
   *
   * Blockers come back as data, not exceptions: every one of them is fixable
   * at the desk inside a minute, and section 5 reserves exceptions for broken
   * invariants rather than for "the room is still dirty". The write path
   * re-derives the same list from the same function, so a UI that says yes
   * cannot meet a server that says no.
   */
  async preflight(
    userId: string,
    hotelId: string,
    reservationId: string,
  ): Promise<CheckInPreflight> {
    const property = await this.authorise(userId, hotelId);
    const reservation = await this.loadReservation(property.id, reservationId);

    const assignment = reservation.rooms[0] ?? null;
    const room = assignment?.room ?? null;

    // Rooms of the booked category that nobody is in. A dirty one is listed
    // and flagged rather than hidden: at 11am most of the house is dirty, and
    // hiding them would leave the clerk with an empty dropdown.
    const availableRooms =
      assignment === null
        ? []
        : await this.prisma.client.room.findMany({
            where: {
              propertyId: property.id,
              roomTypeId: assignment.roomTypeId,
              status: { notIn: ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY', 'OUT_OF_ORDER'] },
            },
            select: { id: true, number: true, status: true },
            orderBy: { number: 'asc' },
          });

    const businessDate = toBusinessDateString(property.businessDate);
    const propertyToday = currentDateInTimeZone(property.timezone, this.clock.now());

    const blockers = this.blockersFor({
      status: reservation.status,
      arrivalDate: toBusinessDateString(reservation.arrivalDate),
      today: propertyToday,
      roomStatus: room?.status ?? null,
      hasGovtId: (reservation.govtIdNumber ?? '').trim().length > 0,
    });

    return {
      reservationId: reservation.id,
      bookingCode: reservation.confirmationCode,
      guestName: `${reservation.guestFirstName} ${reservation.guestLastName}`.trim(),
      guestPhone: reservation.guestPhone,
      status: reservation.status,
      arrivalDate: toBusinessDateString(
        reservation.arrivalDate,
      ) as CheckInPreflight['arrivalDate'],
      departureDate: toBusinessDateString(
        reservation.departureDate,
      ) as CheckInPreflight['departureDate'],
      nights: nightsBetween(reservation.arrivalDate, reservation.departureDate),
      businessDate: businessDate as CheckInPreflight['businessDate'],
      roomTypeId: assignment?.roomTypeId ?? '',
      roomTypeName: assignment?.roomType.name ?? 'Unknown category',
      assignedRoomId: (room?.id ?? null) as RoomId | null,
      assignedRoomNumber: room?.number ?? null,
      availableRooms: availableRooms.map((candidate) => ({
        id: candidate.id as RoomId,
        number: candidate.number,
        housekeepingStatus: candidate.status,
        isClean: isCleanRoomState(candidate.status),
      })),
      govtIdType: reservation.govtIdType,
      govtIdMasked: maskGovtId(reservation.govtIdNumber),
      hasGovtId: (reservation.govtIdNumber ?? '').trim().length > 0,
      totalAmountMinor: reservation.totalAmountMinor,
      paidAmountMinor: reservation.paidAmountMinor,
      // Derived, never a third stored number (section 3.4).
      balanceAmountMinor: reservation.totalAmountMinor - reservation.paidAmountMinor,
      currency: reservation.currency,
      blockers,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Check in                                                             */
  /* -------------------------------------------------------------------- */

  async checkIn(
    userId: string,
    hotelId: string,
    reservationId: string,
    request: CheckInRequest,
  ): Promise<CheckInResult> {
    const property = await this.authorise(userId, hotelId);
    const reservation = await this.loadReservation(property.id, reservationId);

    const assignment = reservation.rooms[0] ?? null;
    if (assignment === null) {
      // Not a blocker: a reservation with no room row at all is a broken
      // booking, not a desk task, and no amount of clicking fixes it here.
      throw new ValidationFailedError({
        reservationId: 'This reservation has no room row and cannot be checked in.',
      });
    }

    // A room is commonly chosen as the guest arrives, because the booking held
    // a category rather than a number.
    const targetRoomId = request.roomId ?? assignment.roomId;
    const targetRoom =
      targetRoomId === null
        ? null
        : await this.prisma.client.room.findFirst({
            where: { id: targetRoomId, propertyId: property.id },
            select: { id: true, number: true, status: true, roomTypeId: true },
          });

    // 404, not 403: confirming that a room exists at another property is
    // itself the leak (section 3.2).
    if (targetRoomId !== null && targetRoom === null) {
      throw new TenantScopeViolationError('Room');
    }

    if (targetRoom !== null && targetRoom.roomTypeId !== assignment.roomTypeId) {
      throw new ValidationFailedError({
        roomId: 'That room is a different category from the one booked.',
      });
    }

    // Identity may be captured at the desk rather than at booking time.
    const govtIdNumber = request.primaryGuestIdNumber ?? reservation.govtIdNumber;
    const govtIdType = request.primaryGuestIdType ?? reservation.govtIdType;

    // Posting uses the business date; the arrival gate uses the calendar date.
    const businessDate = toBusinessDateString(property.businessDate);
    const propertyToday = currentDateInTimeZone(property.timezone, this.clock.now());

    const blockers = this.blockersFor({
      status: reservation.status,
      arrivalDate: toBusinessDateString(reservation.arrivalDate),
      today: propertyToday,
      roomStatus: targetRoom?.status ?? null,
      hasGovtId: (govtIdNumber ?? '').trim().length > 0,
    });

    // An overridable blocker is overridden only because the clerk said so, and
    // the acknowledgement is carried onto the audit row below — "who let a
    // guest into a dirty room" has an answer.
    const unresolved = blockers.filter(
      (blocker) =>
        !(request.acknowledgeRoomNotClean && OVERRIDABLE_BLOCKERS.includes(blocker)),
    );

    const first = unresolved[0];
    if (first !== undefined) {
      if (STATE_BLOCKERS.includes(first)) {
        throw new InvalidStateTransitionError(
          'reservation',
          reservation.status,
          ReservationStatus.CHECKED_IN,
        );
      }
      throw new ValidationFailedError(
        Object.fromEntries(unresolved.map((blocker) => [blocker, blocker])),
      );
    }

    const roomNotClean = blockers.includes('ROOM_NOT_CLEAN');

    /**
     * The arrival night's share of the stay.
     *
     * Split from the reservation's own stored totals rather than re-priced, so
     * the folio agrees with what the guest was quoted even if a rate moved
     * after the booking was taken. The tax share is rounded and the remainder
     * left on the tariff line, so charge + tax is exactly one night's total —
     * rounding both independently is how a bill ends a paisa short (§3.4).
     */
    const nights = nightsBetween(reservation.arrivalDate, reservation.departureDate);
    const nightTotalMinor = Math.round(reservation.totalAmountMinor / nights);
    const taxMinor = Math.round(reservation.taxAmountMinor / nights);
    const roomChargeMinor = nightTotalMinor - taxMinor;

    return this.prisma.client.$transaction(async (tx) => {
      // The RLS backstop. The Prisma extension is the primary tenant control;
      // this is what saves us if a raw query later forgets (section 3.2).
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const checkedInAt = new Date();

      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.CHECKED_IN,
          checkedInAt,
          checkedInBy: userId,
          keyCardsIssued: request.keyCardsIssued,
          registrationCardSigned: request.registrationCardSigned,
          govtIdNumber,
          govtIdType,
          ...(request.initialPayment === null
            ? {}
            : {
                paidAmountMinor:
                  reservation.paidAmountMinor + request.initialPayment.amountMinor,
                paymentMethod: request.initialPayment.method,
                paymentRemark: request.initialPayment.remark,
              }),
        },
      });

      // The assignment's own status mirror has to move too: the exclusion
      // constraint reads `status` from this row, and a stale CONFIRMED there
      // would keep an in-house stay inside the overlap check under the wrong
      // label.
      await tx.reservationRoom.update({
        where: { id: assignment.id },
        data: {
          roomId: targetRoom?.id ?? null,
          status: ReservationStatus.CHECKED_IN,
        },
      });

      const folio = await postCheckIn(tx, {
        propertyId: property.id,
        reservationId: reservation.id,
        staffUserId: userId,
        businessDate,
        currency: reservation.currency,
        roomChargeMinor,
        taxMinor,
        payment:
          request.initialPayment === null
            ? null
            : {
                method: request.initialPayment.method,
                amountMinor: request.initialPayment.amountMinor,
                remark: request.initialPayment.remark,
              },
        room: targetRoom,
        previousStatus: reservation.status,
        previousRoomId: assignment.roomId,
        keyCardsIssued: request.keyCardsIssued,
        roomNotCleanAcknowledged: roomNotClean,
      });

      return {
        reservationId: reservation.id,
        propertyId: property.id as PropertyId,
        bookingCode: reservation.confirmationCode,
        guestName: `${reservation.guestFirstName} ${reservation.guestLastName}`.trim(),
        status: ReservationStatus.CHECKED_IN,
        roomNumber: targetRoom?.number ?? null,
        checkedInAt: checkedInAt.toISOString(),
        keyCardsIssued: request.keyCardsIssued,
        folio,
        roomNotCleanAcknowledged: roomNotClean,
      } satisfies CheckInResult;
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Which requirements are not met.
   *
   * Pure, and the single implementation behind both the modal's pre-flight and
   * the write path's final check. Two implementations of "may this guest check
   * in" is how a UI that says yes meets a server that says no.
   */
  private blockersFor(input: {
    status: string;
    arrivalDate: string;
    /**
     * The calendar date at the property, **not** its business date.
     *
     * A guest standing at the desk today must be checkable in today. The
     * business date is a ledger position that only moves when night audit
     * step 7 runs, so gating on it refused every booking taken after the
     * last audit — which, with the audit module not built, is all of them.
     * Charges still post to the business date; that is a separate question
     * from whether the guest may walk into the room (CLAUDE.md section 3.3).
     */
    today: string;
    roomStatus: string | null;
    hasGovtId: boolean;
  }): CheckInBlocker[] {
    const blockers: CheckInBlocker[] = [];

    switch (input.status) {
      case ReservationStatus.CONFIRMED:
        break;
      case ReservationStatus.CHECKED_IN:
        blockers.push('ALREADY_CHECKED_IN');
        break;
      case ReservationStatus.CHECKED_OUT:
        blockers.push('ALREADY_CHECKED_OUT');
        break;
      case ReservationStatus.CANCELLED:
        blockers.push('CANCELLED');
        break;
      case ReservationStatus.NO_SHOW:
        blockers.push('NO_SHOW');
        break;
      default:
        blockers.push('NOT_CONFIRMED');
    }

    // Lexicographic comparison is exact on `YYYY-MM-DD`, and avoids building a
    // Date that would reintroduce a timezone the business date does not have
    // (section 3.3).
    if (input.arrivalDate > input.today) blockers.push('ARRIVAL_IN_FUTURE');

    if (input.roomStatus === null) {
      blockers.push('NO_ROOM_ASSIGNED');
    } else if (isOccupiedRoomState(input.roomStatus)) {
      blockers.push('ROOM_OCCUPIED');
    } else if (
      input.roomStatus === 'OUT_OF_ORDER' ||
      input.roomStatus === 'OUT_OF_SERVICE'
    ) {
      blockers.push('ROOM_OUT_OF_ORDER');
    } else if (!isCleanRoomState(input.roomStatus)) {
      blockers.push('ROOM_NOT_CLEAN');
    }

    if (!input.hasGovtId) blockers.push('MISSING_GOVT_ID');

    return blockers;
  }

  /**
   * The property, if this user may check guests in there.
   *
   * The grant alone is not enough: housekeeping holds a grant at the property
   * and must not be able to check a guest in. The permission is checked here
   * rather than in a guard because the route is addressed by an explicit
   * hotelId that may differ from the session's active property (section 3.2).
   */
  private async authorise(
    userId: string,
    codeOrId: string,
  ): Promise<{ id: string; code: string; businessDate: Date; timezone: string }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, code: true, businessDate: true, timezone: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants
      .map((grant) => grant.role.key)
      .filter((key): key is Role => key !== null);

    if (!permissionsForRoles(roles).includes(Permission.RESERVATIONS_CHECKIN)) {
      throw new ForbiddenError(Permission.RESERVATIONS_CHECKIN);
    }

    return first.property;
  }

  private async loadReservation(propertyId: string, reservationId: string) {
    const reservation = await this.prisma.client.reservation.findFirst({
      where: { id: reservationId, propertyId },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        guestFirstName: true,
        guestLastName: true,
        guestPhone: true,
        govtIdType: true,
        govtIdNumber: true,
        arrivalDate: true,
        departureDate: true,
        totalAmountMinor: true,
        paidAmountMinor: true,
        taxAmountMinor: true,
        currency: true,
        rooms: {
          select: {
            id: true,
            roomId: true,
            roomTypeId: true,
            roomType: { select: { name: true } },
            room: { select: { id: true, number: true, status: true } },
          },
          take: 1,
        },
      },
    });

    if (reservation === null) throw new TenantScopeViolationError('Reservation');
    return reservation;
  }
}
