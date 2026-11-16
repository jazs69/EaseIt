/**
 * Sends the booking confirmation email (NO-04), from the worker.
 *
 * ===========================================================================
 * **Enqueued once, in the booking's own transaction.** `CreateReservationService`
 * writes the outbox row beside the reservation with a `UNIQUE_FOREVER` key per
 * reservation, so a booking either commits with its promise to confirm or not
 * at all, and no second row can ever be written for it (section 3.1: no mail
 * inside a transaction; the outbox carries it out).
 *
 * **Read at send time.** The payload is only the id. The handler reads the stay
 * as it is now: a booking cancelled or marked no-show before the worker got
 * to it is not confirmed, and a guest with no email address is skipped. Both
 * are a completed delivery, not a failure — there is nothing to retry.
 *
 * **Sent once, as far as SMTP allows.** After the relay accepts the message an
 * audit row records it, and a retried delivery that finds that row does not
 * send again. The one window left is a crash between the relay accepting and
 * that row committing; the message carries a stable Message-ID, so a mail
 * client shows a duplicate from that window as the same message.
 *
 * A relay failure is thrown and retried by the outbox with its bounded backoff,
 * ending DEAD (and the worker's dead-letter warning) if it never recovers.
 * ===========================================================================
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { reservationConfirmationPayloadSchema, ReservationStatus, type OutboxEventType } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';
import { MAILER, type Mailer } from '../platform/mail/mailer.js';
import {
  OutboxHandlerRegistry,
  OutboxPermanentError,
  type OutboxHandler,
  type OutboxHandlerContext,
} from '../platform/outbox/outbox-handler.registry.js';
import { renderBookingConfirmation } from './booking-confirmation.email.js';

export const CONFIRMATION_SENT_EVENT = 'RESERVATION_CONFIRMATION_SENT';

/** Statuses for which a confirmation would be wrong to send. */
const NOT_CONFIRMABLE: ReadonlySet<string> = new Set([ReservationStatus.CANCELLED, ReservationStatus.NO_SHOW]);

const DAY_MS = 86_400_000;

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** What one delivery did, for the log and for tests. */
export type ConfirmationOutcome = 'SENT' | 'ALREADY_SENT' | 'NOT_CONFIRMABLE' | 'NO_EMAIL';

@Injectable()
export class BookingConfirmationHandler implements OutboxHandler {
  readonly eventType: OutboxEventType = 'RESERVATION_CONFIRMATION_EMAIL';
  private readonly logger = new Logger(BookingConfirmationHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async handle(context: OutboxHandlerContext): Promise<void> {
    const outcome = await this.deliver(context);
    // Ids only: no guest name or address in the log (section 5).
    this.logger.log(`Confirmation for reservation ${this.reservationIdOf(context)}: ${outcome}`);
  }

  async deliver(context: OutboxHandlerContext): Promise<ConfirmationOutcome> {
    const parsed = reservationConfirmationPayloadSchema.safeParse(context.payload);
    if (!parsed.success) throw new OutboxPermanentError('Malformed RESERVATION_CONFIRMATION_EMAIL payload.');
    const { reservationId } = parsed.data;

    // Scoped by the event's own property: a payload naming another property's
    // stay finds nothing and is not sent.
    const stay = await this.prisma.client.reservation.findFirst({
      where: { id: reservationId, propertyId: context.propertyId },
      select: {
        confirmationCode: true,
        status: true,
        guestFirstName: true,
        guestLastName: true,
        guestEmail: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        mealPlan: true,
        totalAmountMinor: true,
        paidAmountMinor: true,
        currency: true,
        rooms: { select: { roomType: { select: { name: true } } } },
        property: {
          select: {
            name: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            postalCode: true,
            phone: true,
            email: true,
            checkInTime: true,
            checkOutTime: true,
            settings: { select: { standardCheckInTime: true, standardCheckOutTime: true } },
          },
        },
      },
    });
    if (stay === null) throw new OutboxPermanentError('No such reservation for this property.');

    const alreadySent = await this.prisma.client.auditLog.count({
      where: { propertyId: context.propertyId, entityId: reservationId, event: CONFIRMATION_SENT_EVENT },
    });
    if (alreadySent > 0) return 'ALREADY_SENT';
    if (NOT_CONFIRMABLE.has(stay.status)) return 'NOT_CONFIRMABLE';
    const to = stay.guestEmail?.trim() ?? '';
    if (to === '') return 'NO_EMAIL';

    const p = stay.property;
    const place = [p.city, [p.state, p.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const nights = Math.max(1, Math.round((stay.departureDate.getTime() - stay.arrivalDate.getTime()) / DAY_MS));
    const email = renderBookingConfirmation({
      propertyName: p.name,
      propertyAddressLines: [p.addressLine1, p.addressLine2, place].filter(
        (line): line is string => line !== null && line !== '',
      ),
      propertyPhone: p.phone,
      propertyEmail: p.email,
      guestName: `${stay.guestFirstName} ${stay.guestLastName}`.trim(),
      bookingCode: stay.confirmationCode,
      arrivalDate: toBusinessDate(stay.arrivalDate),
      departureDate: toBusinessDate(stay.departureDate),
      nights,
      checkInTime: p.settings?.standardCheckInTime ?? p.checkInTime,
      checkOutTime: p.settings?.standardCheckOutTime ?? p.checkOutTime,
      roomTypeName: stay.rooms[0]?.roomType.name ?? 'Room',
      roomCount: Math.max(1, stay.rooms.length),
      adults: stay.adults,
      children: stay.children,
      mealPlan: stay.mealPlan,
      totalMinor: stay.totalAmountMinor,
      paidMinor: stay.paidAmountMinor,
      currency: stay.currency,
    });

    const delivery = await this.mailer.send({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: { 'Message-ID': `<reservation-confirmation.${reservationId}@easeit.invalid>` },
    });

    await this.prisma.client.auditLog.create({
      data: {
        propertyId: context.propertyId,
        actorUserId: null,
        event: CONFIRMATION_SENT_EVENT,
        entityType: 'reservation',
        entityId: reservationId,
        before: Prisma.JsonNull,
        // The relay's id and the outbox row, never the address (section 5).
        after: {
          messageId: delivery.messageId,
          loggedOnly: delivery.loggedOnly,
          outboxEventId: context.outboxEventId,
          attempt: context.attempt,
        },
        reason: null,
      },
    });
    return 'SENT';
  }

  private reservationIdOf(context: OutboxHandlerContext): string {
    const parsed = reservationConfirmationPayloadSchema.safeParse(context.payload);
    return parsed.success ? parsed.data.reservationId : 'unknown';
  }
}

/** Registers the handler once per process, before the worker drains. */
@Injectable()
export class BookingConfirmationRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly handler: BookingConfirmationHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.handler);
  }
}
