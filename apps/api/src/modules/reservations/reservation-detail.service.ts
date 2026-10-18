/**
 * The reservation detail panel's data, and its internal notes.
 *
 * ===========================================================================
 * Read-mostly, tenant-scoped, and it decides what the UI may offer.
 *
 * `canCheckIn` / `canCheckOut` are computed here rather than inferred in the
 * browser from a status string. The drawer offering "Check in" on a cancelled
 * booking, or on one whose arrival is next week, teaches a clerk that the
 * buttons lie — and the rule for which transitions are legal belongs with the
 * aggregate, not duplicated in a component (CLAUDE.md section 3.4).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  currentDateInTimeZone,
  Permission,
  permissionsForRoles,
  ReservationStatus,
  type AddReservationNoteCommand,
  type BookingSource,
  type FolioView,
  type MealPlan,
  type PropertyId,
  type ReservationDetail,
  type ReservationGuestDetail,
  type ReservationNoteView,
  type ReservationSubStatus,
  type Role,
  type RoomId,
} from '@repo/types';

import {
  ForbiddenError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { toFolioView } from './check-in-posting.js';

const DAY_MS = 86_400_000;

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `XXXX-1234`. The raw number never leaves the server (section 5). */
function maskGovtId(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 4) return 'XXXX';
  const groups = Math.max(1, Math.ceil((trimmed.length - 4) / 4));
  return `${Array.from({ length: groups }, () => 'XXXX').join('-')}-${trimmed.slice(-4)}`;
}

/**
 * Where a stay sits relative to a date.
 *
 * The same rule as the timeline and the operations dashboard, against the
 * property's business date: a stay must not read "pending departure" on one
 * screen and nothing on another.
 */
function subStatusFor(
  status: string,
  arrivalDate: string,
  departureDate: string,
  businessDate: string,
): ReservationSubStatus | null {
  if (status === ReservationStatus.CHECKED_IN) {
    if (departureDate < businessDate) return 'OVERSTAY';
    if (departureDate === businessDate) return 'PENDING_DEPARTURE';
    return null;
  }
  if (status === ReservationStatus.CONFIRMED) {
    if (arrivalDate < businessDate) return 'OVERDUE_ARRIVAL';
    if (arrivalDate === businessDate) return 'ARRIVING_TODAY';
    return null;
  }
  return null;
}

@Injectable()
export class ReservationDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async detail(
    userId: string,
    hotelId: string,
    reservationId: string,
  ): Promise<ReservationDetail> {
    const { property } = await this.authorise(userId, hotelId, Permission.RESERVATIONS_READ);
    const reservation = await this.load(property.id, reservationId);

    const arrivalDate = toBusinessDate(reservation.arrivalDate);
    const departureDate = toBusinessDate(reservation.departureDate);
    const businessDate = toBusinessDate(property.businessDate);
    const propertyToday = currentDateInTimeZone(property.timezone, this.clock.now());

    const assignment = reservation.rooms[0] ?? null;

    /**
     * Net of tax, by subtraction rather than by rate.
     *
     * Recomputing the net from a tax percentage would round a second time and
     * leave the three rows on screen a paisa short of each other. Subtracting
     * the stored tax from the stored total makes them reconcile by
     * construction (section 3.4).
     */
    const totalMinor = reservation.totalAmountMinor;
    const taxMinor = reservation.taxAmountMinor;

    const folio: FolioView | null =
      reservation.folio === null
        ? null
        : toFolioView(reservation.folio, reservation.folio.lines);

    const guests: ReservationGuestDetail[] = reservation.guests.map((guest) => ({
      id: guest.id,
      ordinal: guest.ordinal,
      name: `${guest.firstName} ${guest.lastName}`.trim(),
      email: guest.email,
      phone: guest.phone,
      govtIdType: guest.govtIdType,
      govtIdMasked: maskGovtId(guest.govtIdNumber),
      city: guest.city,
      countryCode: guest.countryCode,
    }));

    // A booking taken before the guest rows existed still has a booker on the
    // reservation itself, so the list is never empty on screen.
    if (guests.length === 0) {
      guests.push({
        id: reservation.id,
        ordinal: 1,
        name: `${reservation.guestFirstName} ${reservation.guestLastName}`.trim(),
        email: reservation.guestEmail,
        phone: reservation.guestPhone,
        govtIdType: reservation.govtIdType,
        govtIdMasked: maskGovtId(reservation.govtIdNumber),
        city: null,
        countryCode: null,
      });
    }

    const notes: ReservationNoteView[] = reservation.internalNotes.map((note) => ({
      id: note.id,
      body: note.body,
      authorName: note.authorName,
      createdAt: note.createdAt.toISOString(),
    }));

    return {
      id: reservation.id,
      propertyId: property.id as PropertyId,
      bookingCode: reservation.confirmationCode,
      otaBookingId: reservation.otaBookingId,
      status: reservation.status,
      subStatus: subStatusFor(reservation.status, arrivalDate, departureDate, businessDate),
      source: reservation.source as BookingSource,
      isWalkIn: reservation.source === 'WALK_IN',
      bookedAt: reservation.createdAt.toISOString(),
      isMagicLinkActive: reservation.isMagicLinkActive,

      stay: {
        arrivalDate: arrivalDate as ReservationDetail['stay']['arrivalDate'],
        departureDate: departureDate as ReservationDetail['stay']['departureDate'],
        nights: Math.max(
          1,
          Math.round(
            (reservation.departureDate.getTime() - reservation.arrivalDate.getTime()) / DAY_MS,
          ),
        ),
        checkInTime: property.checkInTime,
        checkOutTime: property.checkOutTime,
        adults: reservation.adults,
        children: reservation.children,
        infants: reservation.infants,
      },

      room: {
        roomTypeName: assignment?.roomType.name ?? 'Unknown category',
        roomId: (assignment?.room?.id ?? null) as RoomId | null,
        roomNumber: assignment?.room?.number ?? null,
        housekeepingStatus: assignment?.room?.status ?? null,
        mealPlan: reservation.mealPlan as MealPlan,
      },

      guests,

      company:
        reservation.company === null
          ? null
          : {
              id: reservation.company.id,
              legalName: reservation.company.legalName,
              gstin: reservation.company.gstin,
            },

      money: {
        stay: {
          currency: reservation.currency,
          netMinor: totalMinor - taxMinor,
          taxMinor,
          totalMinor,
          paidMinor: reservation.paidAmountMinor,
          // Derived, never a third stored number (section 3.4).
          balanceMinor: totalMinor - reservation.paidAmountMinor,
          taxIsInclusive: true,
        },
        folio,
      },

      bookingNote: reservation.notes,
      notes,

      /**
       * Decided here, from state the browser cannot see.
       *
       * Check-in additionally refuses a future arrival, a dirty room and a
       * missing ID — those are the check-in sheet's own pre-flight, and they
       * are fixable from inside it, so they do not hide the button. Being
       * cancelled is not fixable from there, so it does.
       */
      canCheckIn:
        reservation.status === ReservationStatus.CONFIRMED && arrivalDate <= propertyToday,
      canCheckOut: reservation.status === ReservationStatus.CHECKED_IN,
    };
  }

  /**
   * Append one internal note.
   *
   * Append-only: there is no edit and no delete. An internal note is part of
   * how a property explains a decision months later, and a log that can be
   * rewritten in place is worth less than no log.
   */
  async addNote(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: AddReservationNoteCommand,
  ): Promise<ReservationNoteView> {
    const { property } = await this.authorise(
      userId,
      hotelId,
      Permission.RESERVATIONS_EDIT,
    );

    // Confirms the reservation is this property's before writing against it.
    // The composite foreign key makes a cross-property note impossible anyway;
    // this turns a constraint violation into a readable 404 (section 3.2).
    const reservation = await this.prisma.client.reservation.findFirst({
      where: { id: reservationId, propertyId: property.id },
      select: { id: true },
    });
    if (reservation === null) throw new TenantScopeViolationError('Reservation');

    const body = command.body.trim();
    if (body.length === 0) {
      throw new ValidationFailedError({ body: 'A note cannot be empty.' });
    }

    const author = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });

    const note = await this.prisma.client.reservationNote.create({
      data: {
        propertyId: property.id,
        reservationId,
        authorUserId: userId,
        // Snapshotted, so a renamed or departed account does not blank the
        // byline on a note written months ago.
        authorName:
          author === null
            ? 'Unknown staff member'
            : `${author.firstName} ${author.lastName}`.trim() || author.email,
        body,
      },
      select: { id: true, body: true, authorName: true, createdAt: true },
    });

    return {
      id: note.id,
      body: note.body,
      authorName: note.authorName,
      createdAt: note.createdAt.toISOString(),
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<{
    property: {
      id: string;
      timezone: string;
      businessDate: Date;
      checkInTime: string;
      checkOutTime: string;
    };
  }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: {
        role: { select: { key: true } },
        property: {
          select: {
            id: true,
            timezone: true,
            businessDate: true,
            checkInTime: true,
            checkOutTime: true,
          },
        },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants
      .map((grant) => grant.role.key)
      .filter((key): key is Role => key !== null);

    if (!permissionsForRoles(roles).includes(required)) {
      throw new ForbiddenError(required);
    }

    return { property: first.property };
  }

  private async load(propertyId: string, reservationId: string) {
    const reservation = await this.prisma.client.reservation.findFirst({
      where: { id: reservationId, propertyId },
      select: {
        id: true,
        confirmationCode: true,
        otaBookingId: true,
        status: true,
        source: true,
        createdAt: true,
        isMagicLinkActive: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        infants: true,
        mealPlan: true,
        notes: true,
        guestFirstName: true,
        guestLastName: true,
        guestEmail: true,
        guestPhone: true,
        govtIdType: true,
        govtIdNumber: true,
        totalAmountMinor: true,
        taxAmountMinor: true,
        paidAmountMinor: true,
        currency: true,
        company: { select: { id: true, legalName: true, gstin: true } },
        rooms: {
          select: {
            roomTypeId: true,
            roomType: { select: { name: true } },
            room: { select: { id: true, number: true, status: true } },
          },
          take: 1,
        },
        guests: {
          select: {
            id: true,
            ordinal: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            govtIdType: true,
            govtIdNumber: true,
            city: true,
            countryCode: true,
          },
          orderBy: { ordinal: 'asc' },
        },
        folio: {
          select: {
            id: true,
            status: true,
            currency: true,
            lines: {
              select: {
                id: true,
                kind: true,
                description: true,
                amountMinor: true,
                chargeDate: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
        internalNotes: {
          select: { id: true, body: true, authorName: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (reservation === null) throw new TenantScopeViolationError('Reservation');
    return reservation;
  }
}
