/**
 * Creating a reservation.
 *
 * ===========================================================================
 * This is the file CLAUDE.md section 3.1 is written about. A double booking is
 * the worst thing this system can produce, and the defence is two layers deep.
 *
 * **Layer 1 — the database.** Two constraints do the actual guaranteeing, and
 * neither can be talked out of it by a race:
 *
 *   * `inventory_day_not_oversold` — a CHECK that `sold + blocked <= physical
 *     + overbooking_allowance`. Selling is `sold = sold + 1` per stay date; a
 *     losing concurrent booking violates the CHECK and its whole transaction
 *     rolls back.
 *   * `reservation_room_no_overlap` — a GiST exclusion constraint over
 *     `(room_id, daterange(arrival, departure, '[)'))`, so one physical room
 *     cannot hold two overlapping stays. Departure is exclusive because a room
 *     vacated in the morning is sellable that night.
 *
 * **Layer 2 — this transaction.** Everything happens inside one
 * `$transaction`, and locks are taken in a **fixed order** — property, then
 * room type, then stay dates ascending — so two bookings that overlap can only
 * ever deadlock-free queue behind each other. The inventory rows are locked
 * `FOR UPDATE` *before* being incremented: without that, two transactions both
 * read `sold = 2`, both write `3`, and one sale vanishes rather than failing
 * loudly.
 *
 * Nothing slow or external happens inside: no HTTP, no queue publish, no mail.
 * Those belong in the outbox once `platform` has one.
 *
 * Serialization failures (40001), CHECK violations (23514) and exclusion
 * violations (23P01) are **retried** up to three times with jittered backoff,
 * because under contention the loser is often retryable — the next attempt
 * re-reads a counter that genuinely has room. Only after that does the caller
 * see `RoomUnavailableError`.
 *
 * Covered by `test/concurrency/parallel-booking.test.mjs`, which fires N
 * parallel requests at the last available room and asserts exactly one wins.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ReservationStatus,
  type CreateReservationCommand,
  type CreatedReservation,
  type PropertyId,
  type ReservationQuote,
  type ReservationQuoteRequest,
  type TaxSlab,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  DomainError,
  EntityNotFoundError,
  RoomUnavailableError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { isRetryableSqlState, sqlState } from '../../common/errors/sql-state.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PropertyTaxService } from '../properties/property-tax.service.js';
import { postCheckIn } from './check-in-posting.js';
import { quoteStay, nightsBetween, stayDates } from './reservation-pricing.js';

/** Postgres SQLSTATEs that mean "try again", not "give up". */
const MAX_ATTEMPTS = 3;
const TRANSACTION_TIMEOUT_MS = 10_000;


function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

@Injectable()
export class CreateReservationService {
  private readonly logger = new Logger(CreateReservationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: PropertyTaxService,
  ) {}

  /**
   * The property's GST bands.
   *
   * The legacy flat `taxRatePercent` column is handed over as the fallback
   * and nothing else: a property with slab rows prices from them. The
   * precedence lives in `PropertyTaxService`, so this is a pass-through
   * rather than a second opinion.
   */
  private async slabsFor(property: {
    id: string;
    taxRatePercent: Prisma.Decimal | null;
  }): Promise<TaxSlab[]> {
    return this.tax.slabsFor(
      property.id,
      property.taxRatePercent === null ? null : Number(property.taxRatePercent),
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Quote — advisory only                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Prices a stay without reserving anything.
   *
   * Explicitly advisory (section 3.1): it takes no locks and makes no promise.
   * The booking re-derives the same figures inside its transaction, so a quote
   * that goes stale between here and submit cannot become a wrong charge.
   */
  async quote(
    userId: string,
    hotelId: string,
    request: ReservationQuoteRequest,
  ): Promise<ReservationQuote> {
    const property = await this.resolveProperty(userId, hotelId);
    const roomType = await this.loadRoomType(property.id, request.roomTypeId);

    this.assertStayWindow(request.arrivalDate, request.departureDate);

    return quoteStay({
      arrivalDate: request.arrivalDate,
      departureDate: request.departureDate,
      baseNightlyRateMinor: roomType.baseRateMinor,
      overrideNightlyRateMinor: request.overrideNightlyRateMinor,
      targetTotalMinor: request.targetTotalMinor,
      isTaxExempt: request.isTaxExempt,
      currency: roomType.currency,
      taxSlabs: await this.slabsFor(property),
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Create                                                              */
  /* -------------------------------------------------------------------- */

  async create(
    userId: string,
    hotelId: string,
    command: CreateReservationCommand,
  ): Promise<CreatedReservation> {
    const property = await this.resolveProperty(userId, hotelId);
    const roomType = await this.loadRoomType(property.id, command.roomTypeId);

    this.assertStayWindow(command.arrivalDate, command.departureDate);

    // The room, if one was chosen, must belong to this property *and* to the
    // room type being sold. Checked here rather than trusted: a roomId is a
    // client-supplied identifier like any other (section 3.2).
    if (command.roomId !== null) {
      const room = await this.prisma.client.room.findFirst({
        where: { id: command.roomId, propertyId: property.id },
        select: { id: true, roomTypeId: true, number: true, status: true },
      });
      if (room === null) throw new TenantScopeViolationError('Room');
      if (room.roomTypeId !== command.roomTypeId) {
        throw new ValidationFailedError({
          roomId: 'That room does not belong to the selected room type.',
        });
      }
      if (room.status === 'OUT_OF_ORDER') {
        throw new ValidationFailedError({
          roomId: 'That room is out of order and cannot be sold.',
        });
      }
    }

    // Priced before the transaction opens, from the room type's configured
    // rate. Pure arithmetic — nothing that touches the database belongs inside
    // a lock it does not need.
    const quote = quoteStay({
      arrivalDate: command.arrivalDate,
      departureDate: command.departureDate,
      baseNightlyRateMinor: roomType.baseRateMinor,
      overrideNightlyRateMinor: command.overrideNightlyRateMinor,
      targetTotalMinor: command.targetTotalMinor,
      isTaxExempt: command.isTaxExempt,
      currency: roomType.currency,
      taxSlabs: await this.slabsFor(property),
    });

    /**
     * The company must belong to this property.
     *
     * Checked rather than trusted — a companyId is a client-supplied
     * identifier like any other. The composite foreign key
     * `reservation_same_property_as_company` makes a cross-property reference
     * structurally impossible anyway, but failing here gives a readable error
     * instead of a constraint violation (CLAUDE.md section 3.2).
     */
    if (command.companyId !== null) {
      const company = await this.prisma.client.company.findFirst({
        where: { id: command.companyId, propertyId: property.id },
        select: { id: true },
      });
      if (company === null) throw new TenantScopeViolationError('Company');
    }

    if (command.payment !== null && command.payment.amountMinor > quote.totalMinor) {
      throw new ValidationFailedError({
        payment: 'Payment taken cannot exceed the total owed.',
      });
    }

    return this.withRetry(() => this.commit(userId, property, roomType, command, quote));
  }

  /* -------------------------------------------------------------------- */
  /*  The transaction                                                     */
  /* -------------------------------------------------------------------- */

  private async commit(
    userId: string,
    property: {
      id: string;
      code: string;
      currency: string;
      businessDate: Date;
      taxRatePercent: Prisma.Decimal | null;
    },
    roomType: { id: string; name: string; baseRateMinor: number; currency: string },
    command: CreateReservationCommand,
    quote: ReservationQuote,
  ): Promise<CreatedReservation> {
    const dates = stayDates(command.arrivalDate, command.departureDate);
    const bookingCode = this.generateBookingCode(property.code);

    // Guest 1 is the booker. Their name, email and phone are copied onto the
    // reservation because that is what search, the timeline and every report
    // read — written in the same transaction as the guest rows below, which is
    // the only way the copy and the source stay honest.
    const booker = command.guests[0];
    if (booker === undefined) {
      throw new ValidationFailedError({ guests: 'At least one guest is required.' });
    }

    const status = command.isInstantCheckIn
      ? ReservationStatus.CHECKED_IN
      : ReservationStatus.CONFIRMED;

    return this.prisma.client.$transaction(
      async (tx) => {
        // The RLS backstop. The Prisma extension is the primary tenant
        // control; this is what saves us if someone later writes a raw query
        // and forgets (section 3.2).
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

        /**
         * Lock every stay date's inventory row, ascending.
         *
         * `ORDER BY stay_date` is the deadlock avoidance: two overlapping
         * bookings acquire the shared dates in the same sequence, so one waits
         * rather than both holding half of what the other needs.
         *
         * `FOR UPDATE` is what makes the read-then-increment safe. Without it
         * the CHECK still catches a true oversell, but a lost update — two
         * transactions writing `sold = 3` from the same read — would silently
         * drop a sale instead of failing.
         */
        const locked = await tx.$queryRaw<{ stay_date: Date; sellable: number }[]>`
          SELECT "stayDate" AS stay_date,
                 ("physical" + "overbookingAllowance" - "sold" - "blocked") AS sellable
          FROM inventory_day
          WHERE "propertyId" = ${property.id}::uuid
            AND "roomTypeId" = ${roomType.id}::uuid
            AND "stayDate" IN (${Prisma.join(dates.map((date) => toUtcMidnight(date)))})
          ORDER BY "stayDate" ASC
          FOR UPDATE
        `;

        // A night with no inventory row cannot be sold. That is a real state —
        // the calendar simply does not extend that far — and it must fail
        // rather than quietly booking a night nothing is tracking.
        if (locked.length !== dates.length) {
          throw new RoomUnavailableError({
            reason: 'No inventory is configured for every night of this stay.',
            nightsRequested: dates.length,
            nightsConfigured: locked.length,
          });
        }

        const soldOut = locked.find((row) => row.sellable < 1);
        if (soldOut !== undefined) {
          // A readable refusal for the common case. The CHECK below is still
          // the thing that makes it true under concurrency — this only saves a
          // pointless write when the answer is already known.
          throw new RoomUnavailableError({
            reason: 'No rooms of that type remain on one of these dates.',
            stayDate: soldOut.stay_date.toISOString().slice(0, 10),
          });
        }

        // Sell each night. The CHECK constraint is what enforces the limit; a
        // concurrent winner having taken the last room makes this raise 23514
        // and roll the whole transaction back.
        await tx.inventoryDay.updateMany({
          where: {
            propertyId: property.id,
            roomTypeId: roomType.id,
            stayDate: { in: dates.map((date) => toUtcMidnight(date)) },
          },
          data: { sold: { increment: 1 } },
        });

        const reservation = await tx.reservation.create({
          data: {
            propertyId: property.id,
            confirmationCode: bookingCode,
            status,
            source: command.source,
            arrivalDate: toUtcMidnight(command.arrivalDate),
            departureDate: toUtcMidnight(command.departureDate),
            adults: command.adults,
            children: command.children,
            infants: command.infants,
            guestFirstName: booker.firstName,
            guestLastName: booker.lastName,
            guestEmail: booker.email === '' ? null : booker.email,
            guestPhone: booker.phone,
            govtIdType: booker.govtIdType,
            govtIdNumber: booker.govtIdNumber,
            companyId: command.companyId,
            paymentMethod: command.payment?.method ?? null,
            paymentRemark: command.payment?.remark ?? null,
            mealPlan: command.mealPlan,
            totalAmountMinor: quote.totalMinor,
            taxAmountMinor: quote.taxMinor,
            // Recorded, so an exempt stay is never taxed later by a derivation
            // that cannot tell it apart from one whose tax went unrecorded.
            isTaxExempt: command.isTaxExempt,
            paidAmountMinor: command.payment?.amountMinor ?? 0,
            currency: roomType.currency,
            // An instant check-in really did arrive, so the instant is
            // recorded rather than left null — the hourly calendar view
            // positions blocks against it.
            ...(command.isInstantCheckIn ? { checkedInAt: new Date() } : {}),
            notes: command.notes,
          },
          select: { id: true },
        });

        /**
         * Room collision check.
         *
         * Advisory, exactly like the availability check above: the exclusion
         * constraint on the next statement is what actually guarantees this,
         * and it holds under concurrency where a read never can. What the
         * check buys is a *clear* answer — "room 101 is already booked for
         * those nights" instead of three doomed retries ending in a generic
         * refusal — for the overwhelmingly common case where the room was
         * already taken before this request arrived.
         *
         * Half-open on both sides, matching the constraint's `'[)'` range: a
         * stay departing on this arrival date does not overlap it.
         */
        if (command.roomId !== null) {
          const clash = await tx.reservationRoom.findFirst({
            where: {
              roomId: command.roomId,
              status: { notIn: [ReservationStatus.CANCELLED, ReservationStatus.NO_SHOW] },
              arrivalDate: { lt: toUtcMidnight(command.departureDate) },
              departureDate: { gt: toUtcMidnight(command.arrivalDate) },
            },
            select: { reservation: { select: { confirmationCode: true } } },
          });

          if (clash !== null) {
            throw new RoomUnavailableError({
              reason: 'That room is already booked for those nights.',
              conflictsWith: clash.reservation.confirmationCode,
            });
          }
        }

        // Every guest, booker first. Same transaction as the reservation, so a
        // booking cannot exist with a half-written guest list.
        await tx.reservationGuest.createMany({
          data: command.guests.map((guest, index) => ({
            propertyId: property.id,
            reservationId: reservation.id,
            ordinal: index + 1,
            firstName: guest.firstName,
            lastName: guest.lastName,
            email: guest.email === '' ? null : guest.email,
            phone: guest.phone,
            addressLine1: guest.addressLine1,
            addressLine2: guest.addressLine2,
            city: guest.city,
            state: guest.state,
            postalCode: guest.postalCode,
            countryCode: guest.countryCode,
            gender: guest.gender,
            dateOfBirth:
              guest.dateOfBirth === null ? null : toUtcMidnight(guest.dateOfBirth),
            nationality: guest.nationality,
            occupation: guest.occupation,
            govtIdType: guest.govtIdType,
            govtIdNumber: guest.govtIdNumber,
            specialRequest: guest.specialRequest,
          })),
        });

        // The room assignment. The exclusion constraint fires here if another
        // stay took it between the check above and this write — which is the
        // race the check cannot see and the constraint can.
        await tx.reservationRoom.create({
          data: {
            propertyId: property.id,
            reservationId: reservation.id,
            roomTypeId: roomType.id,
            roomId: command.roomId,
            arrivalDate: toUtcMidnight(command.arrivalDate),
            departureDate: toUtcMidnight(command.departureDate),
            status,
          },
          select: { id: true },
        });

        const room =
          command.roomId === null
            ? null
            : ((await tx.room.findUnique({
                where: { id: command.roomId },
                select: { id: true, number: true, status: true },
              })) ?? null);
        const roomNumber = room?.number ?? null;

        /**
         * "Check in now", through the same code the front desk uses.
         *
         * The status and `checkedInAt` above are only half of a check-in: a
         * guest who is in the house needs an open folio with the arrival night
         * on it, an occupied room, and an audit row. Posting that here rather
         * than re-implementing it is what stops the two pathways drifting
         * until one of them leaves an in-house guest with nothing to charge.
         *
         * Still inside this transaction, so a booking cannot commit with a
         * half-written folio — which is also why `postCheckIn` takes a `tx`
         * and never opens one of its own.
         */
        // The property's open accounting day, used by both branches below.
        const businessDate = property.businessDate.toISOString().slice(0, 10);

        if (command.isInstantCheckIn) {
          const taxOfNight = Math.round(quote.taxMinor / quote.nights);
          const totalOfNight = Math.round(quote.totalMinor / quote.nights);

          await tx.reservation.update({
            where: { id: reservation.id },
            data: { checkedInBy: userId },
          });

          await postCheckIn(tx, {
            propertyId: property.id,
            reservationId: reservation.id,
            staffUserId: userId,
            // The property's business date, never `now()` (section 3.3).
            businessDate,
            // The arrival night, which is what the charge is for.
            roomChargeDate: command.arrivalDate,
            currency: roomType.currency,
            roomChargeMinor: totalOfNight - taxOfNight,
            taxMinor: taxOfNight,
            payment:
              command.payment === null
                ? null
                : {
                    method: command.payment.method,
                    amountMinor: command.payment.amountMinor,
                    remark: command.payment.remark,
                  },
            room,
            // The booking did not exist a moment ago, so there is no prior
            // state — the audit row says so rather than inventing CONFIRMED.
            previousStatus: 'NEW',
            previousRoomId: null,
            keyCardsIssued: 0,
            roomNotCleanAcknowledged:
              room !== null &&
              room.status !== 'VACANT_CLEAN' &&
              room.status !== 'INSPECTED',
          });
        } else if (command.payment !== null) {
          /**
           * An advance taken at booking belongs in the ledger now.
           *
           * ===========================================================================
           * **Money received is a fact the moment it is received.**
           *
           * This used to write `paidAmountMinor` on the reservation and stop
           * there, posting nothing, because the folio was only opened at
           * check-in. The result was 838 bookings carrying a recorded advance
           * and not one folio line in the database: the drawer showed the
           * agreed figures and the billing page showed an empty ledger, which
           * is the discrepancy that surfaced this.
           *
           * It is also an accounting hole rather than a display bug. Cash in
           * the drawer that the books have never heard of cannot be reconciled
           * by a night audit, and the guest's own receipt would disagree with
           * the folio they are handed at check-out.
           *
           * Only the payment is posted. The room charges are *not*: a night is
           * charged when it is consumed, by check-in for the arrival night and
           * by night audit step 3 for each night after (section 3.3). Posting
           * the whole stay up front would have to be unwound every time a
           * guest shortened it, and would collide with
           * `folio_line_one_room_charge_per_date` the moment the audit ran.
           * ===========================================================================
           */
          const folio = await tx.folio.create({
            data: {
              propertyId: property.id,
              reservationId: reservation.id,
              currency: roomType.currency,
              status: 'OPEN',
            },
            select: { id: true },
          });

          await tx.folioLine.create({
            data: {
              propertyId: property.id,
              folioId: folio.id,
              kind: 'PAYMENT',
              description: `Advance at booking (${command.payment.method})`,
              // Negative, so the balance stays one plain sum (section 3.4).
              amountMinor: -command.payment.amountMinor,
              currency: roomType.currency,
              // The business date, never `now()` — an advance taken at 00:30
              // belongs to the open accounting day (section 3.3).
              chargeDate: toUtcMidnight(businessDate),
              paymentMethod: command.payment.method,
              remark: command.payment.remark,
              postedById: userId,
            },
          });

          // In the same transaction as the money it records (section 3.4).
          await tx.auditLog.create({
            data: {
              propertyId: property.id,
              actorUserId: userId,
              event: 'FOLIO_ADVANCE_POSTED',
              entityType: 'folio',
              entityId: reservation.id,
              before: Prisma.JsonNull,
              after: {
                method: command.payment.method,
                amountMinor: command.payment.amountMinor,
                businessDate,
              },
              reason: null,
            },
          });
        }

        return {
          id: reservation.id,
          propertyId: property.id as PropertyId,
          bookingCode,
          status,
          guestName: `${booker.firstName} ${booker.lastName}`.trim(),
          arrivalDate: command.arrivalDate,
          departureDate: command.departureDate,
          nights: quote.nights,
          roomNumber,
          roomTypeName: roomType.name,
          quote,
          paidAmountMinor: command.payment?.amountMinor ?? 0,
          // Derived, never stored as a third number (section 3.4).
          balanceAmountMinor: quote.totalMinor - (command.payment?.amountMinor ?? 0),
          currency: roomType.currency,
        };
      },
      {
        timeout: TRANSACTION_TIMEOUT_MS,
        // Serializable would also be correct, but the CHECK and the exclusion
        // constraint already make this safe at the default level — and they do
        // it without the retry storm that serializable produces under the
        // contention this path sees at check-in time.
        isolationLevel: 'ReadCommitted',
      },
    );
  }

  /* -------------------------------------------------------------------- */
  /*  Retry                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Retries the genuinely retryable, then gives a clean answer.
   *
   * Jittered, so N clients that collided do not re-collide in lockstep on the
   * next attempt. A caller never sees a SQLSTATE: they see
   * `RoomUnavailableError`, because a raw constraint name in a response body
   * is both meaningless to a clerk and a leak of internals (section 5).
   */
  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        /**
         * Any typed refusal is the answer, not a fault.
         *
         * Widened from `RoomUnavailableError` because `sqlState()` falls back
         * to reading the error *message*: a domain error whose text happened
         * to contain something like "Code: 23514" would otherwise be
         * classified as retryable, turning one clean refusal into three and
         * reporting the wrong status.
         */
        if (error instanceof DomainError) throw error;

        if (!isRetryableSqlState(error)) throw error;

        lastError = error;
        this.logger.warn(
          `Booking attempt ${String(attempt)} hit SQLSTATE ${String(sqlState(error))}; retrying.`,
        );

        if (attempt < MAX_ATTEMPTS) {
          const backoff = 25 * attempt + Math.floor(Math.random() * 50);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    this.logger.warn(
      `Booking exhausted ${String(MAX_ATTEMPTS)} attempts: ${String(sqlState(lastError))}`,
    );
    throw new RoomUnavailableError({
      reason: 'The room was taken while this booking was being written.',
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Helpers                                                             */
  /* -------------------------------------------------------------------- */

  /**
   * `SFBOOKING_31336_A7K2P9QX`.
   *
   * Random, not `Date.now()`. Two clerks submitting in the same millisecond
   * would collide on a timestamp, and the unique constraint would turn that
   * into a failed booking for one of them. Collisions here are retried by
   * `withRetry` on 23505, so the window is a genuine accident rather than a
   * predictable one.
   */
  private generateBookingCode(propertyCode: string): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const suffix = Array.from(
      { length: 8 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'X',
    ).join('');
    return `SFBOOKING_${propertyCode}_${suffix}`;
  }

  private assertStayWindow(arrival: string, departure: string): void {
    const nights = nightsBetween(arrival, departure);
    if (nights <= 0) {
      throw new ValidationFailedError({
        departureDate: 'Check-out must be at least one night after check-in.',
      });
    }
    if (nights > 365) {
      throw new ValidationFailedError({
        departureDate: 'A single reservation cannot exceed 365 nights.',
      });
    }
  }

  private async resolveProperty(
    userId: string,
    codeOrId: string,
  ): Promise<{
    id: string;
    code: string;
    currency: string;
    businessDate: Date;
    taxRatePercent: Prisma.Decimal | null;
  }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grant = await this.prisma.client.userPropertyRole.findFirst({
      where: {
        userId,
        property: isUuid ? { id: codeOrId } : { code: codeOrId },
      },
      select: {
        property: {
          select: {
          id: true,
          code: true,
          currency: true,
          businessDate: true,
          taxRatePercent: true,
        },
        },
      },
    });

    if (grant === null) throw new TenantScopeViolationError('Property');
    return grant.property;
  }

  private async loadRoomType(
    propertyId: string,
    roomTypeId: string,
  ): Promise<{ id: string; name: string; baseRateMinor: number; currency: string }> {
    const roomType = await this.prisma.client.roomType.findFirst({
      where: { id: roomTypeId, propertyId },
      select: { id: true, name: true, baseRateMinor: true, currency: true },
    });

    if (roomType === null) throw new EntityNotFoundError('Room type');
    return roomType;
  }
}
