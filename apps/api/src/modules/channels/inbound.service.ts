/**
 * Inbound OTA bookings (CM-04), from the worker. Two steps, never one.
 *
 * ===========================================================================
 * 1. PULL -- store first. New revisions are fetched and written to
 *    `channel_inbound_message` exactly as received (card data removed) in
 *    one transaction, keyed by the provider's message id so a re-fetch is a
 *    no-op. Only AFTER that commit is each one acknowledged to the provider.
 *    Nothing here parses a booking, so a parser bug cannot lose one: the raw
 *    row is already safe, and the provider resends anything unacknowledged.
 *
 * 2. APPLY -- normalise separately. Stored messages are read through the
 *    adapter and applied in arrival order:
 *
 *      NEW        one reservation per room, through
 *                 `CreateReservationService.createForChannel` -- the staff
 *                 booking transaction itself (ascending inventory lock,
 *                 oversell CHECK, bounded retries) at the OTA's nightly price.
 *                 Its first step is an advisory lock on the provider booking,
 *                 taken before any inventory lock and nowhere else, then a
 *                 look at `channel_reservation`: a room already booked is
 *                 skipped. That unique row, written in the same transaction,
 *                 is the idempotency on the channel's reservation id.
 *      CANCELLED  every reservation the booking became, through
 *                 `CancelReservationService.cancelAsSystem` -- the clerk's
 *                 path (reservation row lock first, release from the actual
 *                 room rows), idempotent on an already-cancelled stay.
 *      MODIFIED   applied only when nothing about the stay changed; anything
 *                 else is handed to a person (see below).
 *
 *    Anything the system will not guess about -- an unmapped room type, no
 *    room left even with the overbooking allowance, a cancellation of a guest
 *    already in house, a real modification -- becomes NEEDS_ATTENTION with a
 *    code, shown on the Channels screen. Never a silent oversell, never a
 *    dropped booking. Later revisions of the same booking wait behind it.
 *
 *    A transient failure (a lock timeout, a deadlock budget exhausted) stops
 *    the run with the message still RECEIVED; the outbox retries the apply.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { createReservationSchema, type ChannelAttentionCode } from '@repo/types';

import {
  DomainError,
  InvalidStateTransitionError,
  InventoryNotConfiguredError,
  RoomUnavailableError,
  TransactionConflictError,
} from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { OutboxPermanentError } from '../platform/outbox/outbox-handler.registry.js';
import { CancelReservationService } from '../reservations/cancel-reservation.service.js';
import { CreateReservationService } from '../reservations/create-reservation.service.js';
import {
  ChannelPayloadError,
  ChannelProviderError,
  type ChannelAdapter,
  type ChannelBooking,
  type ChannelProviderCode,
  type ProviderCall,
} from './channel-adapter.js';
import { ChannelAdapters, ChannelSyncLog } from './channel-adapters.js';

/** How many stored messages one apply run takes; the rest wait for the next. */
const APPLY_BATCH = 100;

const iso = (date: Date): string => date.toISOString().slice(0, 10);

/** A failure a later attempt can get past. Leaves the message RECEIVED. */
export class ApplyDeferred extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyDeferred';
  }
}

/** Thrown inside the booking transaction when this room was already booked. */
class AlreadyBooked extends Error {
  constructor(readonly reservationId: string) {
    super('This room of the channel booking was already booked.');
  }
}

type Verdict =
  | { status: 'APPLIED' | 'IGNORED'; outcome: string }
  | { status: 'NEEDS_ATTENTION'; code: ChannelAttentionCode; outcome: string };

interface ConnectionContext {
  id: string;
  propertyId: string;
  externalPropertyId: string;
  adapter: ChannelAdapter;
  roomTypes: Map<
    string,
    { roomTypeId: string; currency: string; ratePlans: Map<string, { id: string; code: string }> }
  >;
}

export interface PullOutcome {
  fetched: number;
  stored: number;
  acknowledged: number;
}

export interface ApplyOutcome {
  processed: number;
  applied: number;
  ignored: number;
  needsAttention: number;
}

@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ChannelAdapters,
    private readonly log: ChannelSyncLog,
    private readonly bookings: CreateReservationService,
    private readonly cancellations: CancelReservationService,
    private readonly clock: ClockService,
  ) {}

  /* ---------------------------------------------------------------- pull -- */

  async pull(propertyId: string, connectionId: string): Promise<PullOutcome> {
    const connection = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, propertyId },
      select: { id: true, provider: true, status: true, externalPropertyId: true },
    });
    if (connection === null || connection.status !== 'ACTIVE') {
      return { fetched: 0, stored: 0, acknowledged: 0 };
    }
    const adapter = this.adapters.get(connection.provider as ChannelProviderCode);
    const target = { connectionId, externalPropertyId: connection.externalPropertyId };
    if (!adapter.configured()) {
      await this.notePull(connectionId, 'The provider is not configured on this server.', false);
      throw new OutboxPermanentError(`${connection.provider} is not configured on this server.`);
    }

    let fetched;
    try {
      fetched = await adapter.fetchBookings(target);
    } catch (cause) {
      if (!(cause instanceof ChannelProviderError)) throw cause;
      await this.log.record(propertyId, connectionId, cause.calls);
      await this.notePull(connectionId, cause.message, false);
      if (!cause.retryable)
        throw new OutboxPermanentError(`Booking pull refused: ${cause.message}`);
      throw new Error(`Booking pull failed: ${cause.message}`);
    }
    await this.log.record(propertyId, connectionId, [fetched.call]);

    // Store first, in one transaction, before anything reads or acknowledges.
    let stored = 0;
    if (fetched.messages.length > 0) {
      const written = await this.prisma.client.channelInboundMessage.createMany({
        data: fetched.messages.map((message) => ({
          propertyId,
          connectionId,
          externalMessageId: message.externalMessageId.slice(0, 200),
          externalBookingId: message.externalBookingId?.slice(0, 200) ?? null,
          rawPayload: (message.raw ?? {}) as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      stored = written.count;
    }

    // Acknowledge only what is now safely stored (new, or stored earlier and
    // re-sent because a previous acknowledgement was lost).
    const ackCalls: ProviderCall[] = [];
    let acknowledged = 0;
    for (const message of fetched.messages) {
      try {
        ackCalls.push(await adapter.acknowledge(target, message.externalMessageId));
        acknowledged += 1;
      } catch (cause) {
        if (!(cause instanceof ChannelProviderError)) throw cause;
        // Not fatal: unacknowledged, it is fetched again and the insert is a no-op.
        ackCalls.push(...cause.calls);
      }
    }
    await this.log.record(propertyId, connectionId, ackCalls);
    await this.notePull(connectionId, null, true);

    if (fetched.messages.length > 0) {
      this.logger.log(
        `Booking pull for connection ${connectionId}: ${String(fetched.messages.length)} fetched, ` +
          `${String(stored)} new, ${String(acknowledged)} acknowledged.`,
      );
    }
    return { fetched: fetched.messages.length, stored, acknowledged };
  }

  /* --------------------------------------------------------------- apply -- */

  async apply(propertyId: string, connectionId: string): Promise<ApplyOutcome> {
    const context = await this.context(propertyId, connectionId);
    const outcome: ApplyOutcome = { processed: 0, applied: 0, ignored: 0, needsAttention: 0 };
    if (context === null) return outcome;

    const messages = await this.prisma.client.channelInboundMessage.findMany({
      where: { propertyId, connectionId, status: 'RECEIVED' },
      orderBy: { sequence: 'asc' },
      take: APPLY_BATCH,
      select: { id: true, sequence: true, rawPayload: true, externalBookingId: true },
    });

    for (const message of messages) {
      await this.prisma.client.channelInboundMessage.updateMany({
        where: { id: message.id, propertyId },
        data: { attempts: { increment: 1 } },
      });
      // ApplyDeferred propagates: the run stops, this message stays RECEIVED.
      const verdict = await this.applyOne(context, message);
      await this.record(propertyId, message.id, verdict);
      outcome.processed += 1;
      if (verdict.status === 'APPLIED') outcome.applied += 1;
      else if (verdict.status === 'IGNORED') outcome.ignored += 1;
      else outcome.needsAttention += 1;
    }
    return outcome;
  }

  private async applyOne(
    context: ConnectionContext,
    message: {
      id: string;
      sequence: bigint;
      rawPayload: Prisma.JsonValue;
      externalBookingId: string | null;
    },
  ): Promise<Verdict> {
    let booking: ChannelBooking;
    try {
      booking = context.adapter.readBooking(message.rawPayload);
    } catch (cause) {
      if (!(cause instanceof ChannelPayloadError)) throw cause;
      return {
        status: 'NEEDS_ATTENTION',
        code: 'UNREADABLE',
        outcome: `Could not read the booking: ${cause.message}`,
      };
    }

    await this.prisma.client.channelInboundMessage.updateMany({
      where: { id: message.id, propertyId: context.propertyId },
      data: {
        revisionKind: booking.kind,
        externalBookingId: booking.externalBookingId.slice(0, 200),
      },
    });

    // Revisions of one booking apply in order: one waiting for a person
    // holds back the ones after it.
    const blocked = await this.prisma.client.channelInboundMessage.findFirst({
      where: {
        propertyId: context.propertyId,
        connectionId: context.id,
        externalBookingId: booking.externalBookingId,
        sequence: { lt: message.sequence },
        status: 'NEEDS_ATTENTION',
      },
      select: { id: true },
    });
    if (blocked !== null) {
      return {
        status: 'NEEDS_ATTENTION',
        code: 'EARLIER_REVISION',
        outcome: 'An earlier revision of this booking needs attention first.',
      };
    }

    switch (booking.kind) {
      case 'NEW':
        return this.applyNew(context, booking);
      case 'CANCELLED':
        return this.applyCancel(context, booking, message.sequence);
      case 'MODIFIED':
        return this.applyModification(context, booking);
    }
  }

  /** NEW: one reservation per room, each in the staff booking transaction. */
  private async applyNew(context: ConnectionContext, booking: ChannelBooking): Promise<Verdict> {
    // Every room is checked before any is booked, so a mapping gap never
    // leaves a half-booked group.
    const planned = [];
    for (const [index, room] of booking.rooms.entries()) {
      const mapped = context.roomTypes.get(room.externalRoomTypeId);
      if (mapped === undefined) {
        return {
          status: 'NEEDS_ATTENTION',
          code: 'UNMAPPED_ROOM_TYPE',
          outcome: `Room ${String(index + 1)}: the provider room type ${room.externalRoomTypeId} is not mapped.`,
        };
      }
      const plan =
        room.externalRatePlanId === null
          ? undefined
          : mapped.ratePlans.get(room.externalRatePlanId);
      if (plan === undefined) {
        return {
          status: 'NEEDS_ATTENTION',
          code: 'UNMAPPED_RATE_PLAN',
          outcome: `Room ${String(index + 1)}: the provider rate plan ${room.externalRatePlanId ?? '(none)'} is not mapped to this room type.`,
        };
      }
      if (mapped.currency !== booking.currency) {
        return {
          status: 'NEEDS_ATTENTION',
          code: 'CURRENCY_MISMATCH',
          outcome: `The booking is in ${booking.currency}; the room type sells in ${mapped.currency}.`,
        };
      }
      planned.push({ roomIndex: index + 1, room, roomTypeId: mapped.roomTypeId, plan });
    }

    const booked: string[] = [];
    for (const { roomIndex, room, roomTypeId, plan } of planned) {
      try {
        const code = await this.bookRoom(context, booking, roomIndex, room, roomTypeId, plan);
        booked.push(code);
      } catch (cause) {
        const refusal = this.refusalFor(cause);
        const done = booked.length === 0 ? '' : ` Rooms already booked: ${booked.join(', ')}.`;
        return {
          status: 'NEEDS_ATTENTION',
          code: booked.length > 0 ? 'PARTIAL' : refusal.code,
          outcome:
            `Room ${String(roomIndex)} of ${String(planned.length)}: ${refusal.message}${done}`.slice(
              0,
              500,
            ),
        };
      }
    }
    return { status: 'APPLIED', outcome: `Booked ${booked.join(', ')}.`.slice(0, 500) };
  }

  /** Books one room, or returns the code it was already booked under. */
  private async bookRoom(
    context: ConnectionContext,
    booking: ChannelBooking,
    roomIndex: number,
    room: ChannelBooking['rooms'][number],
    roomTypeId: string,
    plan: { id: string; code: string },
  ): Promise<string> {
    const existing = await this.linked(context, booking.externalBookingId, roomIndex);
    if (existing !== null) return existing.confirmationCode;

    const quote = await this.bookings.quoteForChannel(context.propertyId, {
      roomTypeId,
      ratePlan: plan,
      arrivalDate: room.arrivalDate,
      departureDate: room.departureDate,
      nights: room.nights.map((night) => ({
        stayDate: night.stayDate,
        rateMinor: night.amountMinor,
      })),
    });
    const reference = booking.otaReservationCode ?? booking.externalBookingId;
    const label = booking.otaName ?? 'the channel';
    const command = createReservationSchema.parse({
      roomTypeId,
      roomId: null,
      arrivalDate: room.arrivalDate,
      departureDate: room.departureDate,
      adults: room.adults,
      children: room.children,
      infants: room.infants,
      source: booking.source,
      guests: [
        {
          firstName: booking.booker.firstName,
          lastName: booking.booker.lastName,
          email: booking.booker.email,
          phone: booking.booker.phone,
          countryCode: booking.booker.countryCode,
        },
      ],
      notes: [`Booked on ${label}, reference ${reference}.`, booking.notes]
        .filter(Boolean)
        .join(' ')
        .slice(0, 1000),
    });

    try {
      const created = await this.bookings.createForChannel(context.propertyId, command, quote, {
        before: async (tx) => {
          // One booking of the provider booking at a time; taken before any
          // inventory lock and by nothing else, so it adds no lock cycle.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel-booking:${context.propertyId}:${context.id}:${booking.externalBookingId}`}))`;
          const earlier = await tx.channelReservation.findFirst({
            where: {
              propertyId: context.propertyId,
              connectionId: context.id,
              externalBookingId: booking.externalBookingId,
              roomIndex,
            },
            select: { reservationId: true },
          });
          if (earlier !== null) throw new AlreadyBooked(earlier.reservationId);
        },
        after: async (tx, reservation) => {
          await tx.channelReservation.create({
            data: {
              propertyId: context.propertyId,
              connectionId: context.id,
              externalBookingId: booking.externalBookingId,
              roomIndex,
              reservationId: reservation.id,
            },
            select: { id: true },
          });
          await tx.auditLog.create({
            data: {
              propertyId: context.propertyId,
              actorUserId: null,
              event: 'CHANNEL_BOOKING_RECEIVED',
              entityType: 'reservation',
              entityId: reservation.id,
              before: Prisma.JsonNull,
              after: {
                bookingCode: reservation.bookingCode,
                source: booking.source,
                otaReservationCode: booking.otaReservationCode,
                externalBookingId: booking.externalBookingId,
                roomIndex,
                totalMinor: quote.totalMinor,
                currency: quote.currency,
              },
              reason: `Received from ${label}`,
            },
          });
        },
        ota: {
          otaBookingId: roomIndex === 1 ? reference : `${reference}/${String(roomIndex)}`,
          // Booking-level figures sit on the first room only, so a group is
          // never counted twice.
          otaCommissionMinor: roomIndex === 1 ? booking.otaCommissionMinor : 0,
          otaPrepaidAmountMinor:
            roomIndex === 1 && booking.collectedByOta ? (booking.totalMinor ?? 0) : 0,
        },
      });
      return created.bookingCode;
    } catch (cause) {
      if (cause instanceof AlreadyBooked) {
        const row = await this.linked(context, booking.externalBookingId, roomIndex);
        return row?.confirmationCode ?? cause.reservationId;
      }
      throw cause;
    }
  }

  /** CANCELLED: every reservation the booking became, by the clerk's path. */
  private async applyCancel(
    context: ConnectionContext,
    booking: ChannelBooking,
    sequence: bigint,
  ): Promise<Verdict> {
    const links = await this.prisma.client.channelReservation.findMany({
      where: {
        propertyId: context.propertyId,
        connectionId: context.id,
        externalBookingId: booking.externalBookingId,
      },
      orderBy: { roomIndex: 'asc' },
      select: { reservationId: true, reservation: { select: { confirmationCode: true } } },
    });
    if (links.length === 0) {
      const handled = await this.prisma.client.channelInboundMessage.findFirst({
        where: {
          propertyId: context.propertyId,
          connectionId: context.id,
          externalBookingId: booking.externalBookingId,
          sequence: { lt: sequence },
          status: 'RESOLVED',
        },
        select: { id: true },
      });
      return handled === null
        ? {
            status: 'IGNORED',
            outcome: 'No reservation was made for this booking; nothing to cancel.',
          }
        : {
            status: 'NEEDS_ATTENTION',
            code: 'REFUSED',
            outcome: 'This booking was handled by hand; cancel its reservation by hand too.',
          };
    }

    const cancelled: string[] = [];
    for (const link of links) {
      try {
        await this.cancellations.cancelAsSystem(
          context.propertyId,
          link.reservationId,
          `Cancelled on ${booking.otaName ?? 'the channel'}`,
        );
        cancelled.push(link.reservation.confirmationCode);
      } catch (cause) {
        if (cause instanceof TransactionConflictError) throw new ApplyDeferred(cause.message);
        if (cause instanceof InvalidStateTransitionError) {
          return {
            status: 'NEEDS_ATTENTION',
            code: 'GUEST_IN_HOUSE',
            outcome:
              `${link.reservation.confirmationCode} cannot be cancelled: ${cause.message}`.slice(
                0,
                500,
              ),
          };
        }
        if (cause instanceof DomainError) {
          return {
            status: 'NEEDS_ATTENTION',
            code: 'REFUSED',
            outcome: cause.message.slice(0, 500),
          };
        }
        throw cause;
      }
    }
    return { status: 'APPLIED', outcome: `Cancelled ${cancelled.join(', ')}.`.slice(0, 500) };
  }

  /**
   * MODIFIED: applied only when the stay itself is unchanged -- the same rooms,
   * category, dates and nightly prices as what was booked (an OTA resends a
   * booking for a guest's phone number). Anything else changes inventory or
   * money and goes to a person, who applies it with the date-change and room
   * tools and marks it resolved.
   */
  private async applyModification(
    context: ConnectionContext,
    booking: ChannelBooking,
  ): Promise<Verdict> {
    const links = await this.prisma.client.channelReservation.findMany({
      where: {
        propertyId: context.propertyId,
        connectionId: context.id,
        externalBookingId: booking.externalBookingId,
      },
      orderBy: { roomIndex: 'asc' },
      select: {
        roomIndex: true,
        reservation: {
          select: {
            confirmationCode: true,
            status: true,
            arrivalDate: true,
            departureDate: true,
            rooms: { select: { roomTypeId: true } },
            pricedNights: {
              orderBy: { stayDate: 'asc' },
              select: { stayDate: true, rateMinor: true },
            },
          },
        },
      },
    });
    const unchanged =
      links.length === booking.rooms.length &&
      booking.rooms.every((room, index) => {
        const link = links[index];
        const mapped = context.roomTypes.get(room.externalRoomTypeId);
        if (link === undefined || mapped === undefined || link.roomIndex !== index + 1)
          return false;
        const stay = link.reservation;
        return (
          stay.status !== 'CANCELLED' &&
          stay.rooms.length === 1 &&
          stay.rooms[0]?.roomTypeId === mapped.roomTypeId &&
          iso(stay.arrivalDate) === room.arrivalDate &&
          iso(stay.departureDate) === room.departureDate &&
          stay.pricedNights.length === room.nights.length &&
          stay.pricedNights.every(
            (night, n) =>
              iso(night.stayDate) === room.nights[n]?.stayDate &&
              night.rateMinor === room.nights[n]?.amountMinor,
          )
        );
      });
    if (unchanged) {
      return {
        status: 'APPLIED',
        outcome: 'Modification changes nothing about the stay; nothing to do.',
      };
    }
    const codes = links.map((link) => link.reservation.confirmationCode);
    return {
      status: 'NEEDS_ATTENTION',
      code: 'MODIFICATION',
      outcome: (codes.length === 0
        ? 'Modified at the OTA, but no reservation was made from this booking.'
        : `Modified at the OTA: dates, rooms or prices differ from ${codes.join(', ')}. Apply the change at the desk.`
      ).slice(0, 500),
    };
  }

  /* ------------------------------------------------------------- helpers -- */

  private refusalFor(cause: unknown): { code: ChannelAttentionCode; message: string } {
    if (cause instanceof TransactionConflictError) throw new ApplyDeferred(cause.message);
    if (cause instanceof RoomUnavailableError || cause instanceof InventoryNotConfiguredError) {
      return {
        code: 'NO_AVAILABILITY',
        message: `${cause.message} Overbooked: rehouse the guest or contact the OTA.`,
      };
    }
    if (cause instanceof DomainError) return { code: 'REFUSED', message: cause.message };
    throw cause;
  }

  private async linked(
    context: ConnectionContext,
    externalBookingId: string,
    roomIndex: number,
  ): Promise<{ confirmationCode: string } | null> {
    const row = await this.prisma.client.channelReservation.findFirst({
      where: {
        propertyId: context.propertyId,
        connectionId: context.id,
        externalBookingId,
        roomIndex,
      },
      select: { reservation: { select: { confirmationCode: true } } },
    });
    return row === null ? null : { confirmationCode: row.reservation.confirmationCode };
  }

  private async context(
    propertyId: string,
    connectionId: string,
  ): Promise<ConnectionContext | null> {
    const connection = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, propertyId },
      select: {
        id: true,
        provider: true,
        externalPropertyId: true,
        roomTypeMappings: {
          select: {
            roomTypeId: true,
            externalRoomTypeId: true,
            roomType: { select: { currency: true } },
            ratePlans: {
              select: {
                externalRatePlanId: true,
                ratePlanId: true,
                ratePlan: { select: { code: true } },
              },
            },
          },
        },
      },
    });
    // A paused connection still applies what was already received: those
    // bookings were sold by the OTA and must reach the front desk.
    if (connection === null) return null;
    return {
      id: connection.id,
      propertyId,
      externalPropertyId: connection.externalPropertyId,
      adapter: this.adapters.get(connection.provider as ChannelProviderCode),
      roomTypes: new Map(
        connection.roomTypeMappings.map((mapping) => [
          mapping.externalRoomTypeId,
          {
            roomTypeId: mapping.roomTypeId,
            currency: mapping.roomType.currency,
            ratePlans: new Map(
              mapping.ratePlans.map((plan) => [
                plan.externalRatePlanId,
                { id: plan.ratePlanId, code: plan.ratePlan.code },
              ]),
            ),
          },
        ]),
      ),
    };
  }

  private async record(propertyId: string, messageId: string, verdict: Verdict): Promise<void> {
    await this.prisma.client.channelInboundMessage.updateMany({
      where: { id: messageId, propertyId },
      data: {
        status: verdict.status,
        attentionCode: verdict.status === 'NEEDS_ATTENTION' ? verdict.code : null,
        outcome: verdict.outcome.slice(0, 500),
        appliedAt: verdict.status === 'NEEDS_ATTENTION' ? null : this.clock.now(),
      },
    });
  }

  private async notePull(
    connectionId: string,
    error: string | null,
    succeeded: boolean,
  ): Promise<void> {
    await this.prisma.client.channelConnection.updateMany({
      where: { id: connectionId },
      data: {
        lastPullError: error === null ? null : error.slice(0, 500),
        ...(succeeded ? { lastPulledAt: this.clock.now() } : {}),
      },
    });
  }
}
