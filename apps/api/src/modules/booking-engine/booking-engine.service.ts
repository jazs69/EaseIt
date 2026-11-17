/**
 * The public booking engine (BE-01, BE-03, BE-04, AV-08).
 *
 * ===========================================================================
 * SEARCH (AV-08) answers which categories can be sold for the whole stay and
 * at what price: every night must have an inventory row with physical stock
 * left (the overbooking allowance is not sold publicly), the category must fit
 * the party, and it must be priced by a public plan whose restrictions allow
 * the stay — or, for a category no plan prices at all, at its standard rate.
 * Cached for 30 s (AV-09); advisory, like every availability answer.
 *
 * QUOTE re-checks availability uncached and prices the stay through the SAME
 * pricing as staff bookings (`quoteForProperty`), then signs it: that signed
 * quote is the 15-minute price hold. The room is not held.
 *
 * BOOK verifies the signature, the property and the expiry, then books through
 * `CreateReservationService.createForGuest`: the staff transaction itself —
 * ascending `inventory_day` lock, oversell CHECK, bounded retries — at the
 * held price. Its first step is a per-quote advisory lock and a look for an
 * earlier booking of the same quote, so a double submit returns the first
 * booking rather than selling a second room. In the same transaction it
 * records the online booking, an audit row (no staff actor) and, for "pay
 * now", an open folio. The confirmation email is the existing outbox row.
 *
 * PAY (BE-04) asks Razorpay for a link for the balance AFTER the booking has
 * committed, outside any transaction (section 3.1). A failed link never
 * undoes a booking: the guest is told to pay at the hotel or try again.
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_ONLINE_LEAD_DAYS,
  MAX_ONLINE_NIGHTS,
  QUOTE_HOLD_MINUTES,
  availabilityResponseSchema,
  businessDateSchema,
  reservationQuoteRequestSchema,
  createReservationSchema,
  type AvailabilityQuery,
  type AvailabilityResponse,
  type BookingEngineProperty,
  type PaymentChoice,
  type PaymentLink,
  type PublicBookRequest,
  type PublicBooking,
  type PublicQuote,
  type PublicQuoteRequest,
  type PublicRateOffer,
  type PublicRoomOffer,
} from '@repo/types';

import {
  DomainError,
  EntityNotFoundError,
  RateLimitedError,
  RoomUnavailableError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { ClockService } from '../platform/clock.service.js';
import { RateLimiterService } from '../platform/rate-limiter.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { CreateReservationService } from '../reservations/create-reservation.service.js';
import { AvailabilityCache } from './availability.cache.js';
import { BookingEngineRepository } from './booking-engine.repository.js';
import { BookingTokens, type QuotePayload } from './booking-tokens.js';
import type { PublicPropertyContext } from './public-property.guard.js';

const DAY = 86_400_000;
const days = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;

/** Per client address: generous for browsing, tight for writing. */
const LIMITS = {
  search: { limit: 120, windowSeconds: 60 },
  quote: { limit: 60, windowSeconds: 600 },
  book: { limit: 10, windowSeconds: 600 },
  pay: { limit: 20, windowSeconds: 600 },
} as const;

/** Thrown from inside the booking transaction when this quote was already booked. */
class AlreadyBooked extends Error {
  constructor(readonly reservationId: string) {
    super('This quote has already been booked.');
  }
}

@Injectable()
export class BookingEngineService {
  private readonly logger = new Logger(BookingEngineService.name);

  constructor(
    private readonly repository: BookingEngineRepository,
    private readonly reservations: CreateReservationService,
    private readonly payments: PaymentsService,
    private readonly tokens: BookingTokens,
    private readonly cache: AvailabilityCache,
    private readonly limiter: RateLimiterService,
    private readonly clock: ClockService,
  ) {}

  /* ------------------------------------------------------------ profile -- */

  async profile(ctx: PublicPropertyContext): Promise<BookingEngineProperty> {
    const [types, prepay] = await Promise.all([
      this.repository.roomTypes(ctx.id),
      this.payments.canTakeOnlinePayments(ctx.id),
    ]);
    return {
      slug: ctx.slug,
      name: ctx.name,
      city: ctx.city,
      currency: ctx.currency,
      today: businessDateSchema.parse(ctx.businessDate),
      checkInTime: ctx.checkInTime,
      checkOutTime: ctx.checkOutTime,
      prepayAvailable: prepay,
      roomTypes: types.map((t) => ({
        roomTypeId: t.id,
        name: t.name,
        description: t.description,
        maxGuests: t.maxGuests,
        maxAdults: t.maxAdults,
      })),
    };
  }

  /* ------------------------------------------------------------- search -- */

  async search(
    ctx: PublicPropertyContext,
    query: AvailabilityQuery,
    client: string,
  ): Promise<AvailabilityResponse> {
    this.throttle('search', ctx.id, client);
    this.assertWindow(ctx, query.arrivalDate, query.departureDate);

    const key = this.cache.key(ctx.id, [
      query.arrivalDate,
      query.departureDate,
      query.adults,
      query.children,
    ]);
    const cached = await this.cache.get(key);
    if (cached !== null) {
      const parsed = availabilityResponseSchema.safeParse(JSON.parse(cached));
      if (parsed.success) return parsed.data;
    }

    const nights = days(query.arrivalDate, query.departureDate);
    const [types, stock, plans, priced] = await Promise.all([
      this.repository.roomTypes(ctx.id),
      this.repository.sellable(ctx.id, query.arrivalDate, query.departureDate),
      this.repository.publicPlans(ctx.id),
      this.repository.pricedRoomTypes(ctx.id),
    ]);

    const rooms: PublicRoomOffer[] = [];
    for (const type of types) {
      if (type.maxGuests < query.adults + query.children) continue;
      if (type.maxAdults !== null && type.maxAdults < query.adults) continue;
      const left = stock.get(type.id);
      if (left === undefined || left.nights !== nights || left.left < 1) continue;

      const offers: PublicRateOffer[] = [];
      const candidates = plans.filter((p) => p.roomTypeIds.includes(type.id));
      const tries: { id: string | null; name: string; description: string | null }[] =
        candidates.length > 0
          ? candidates.map((p) => ({ id: p.id, name: p.name, description: p.description }))
          : priced.has(type.id)
            ? [] // priced only by non-public plans (corporate, complimentary): not sold here
            : [{ id: null, name: 'Standard rate', description: null }];
      for (const plan of tries) {
        const quote = await this.priceOrNull(ctx.id, {
          roomTypeId: type.id,
          ratePlanId: plan.id,
          arrivalDate: query.arrivalDate,
          departureDate: query.departureDate,
          adults: query.adults,
          children: query.children,
        });
        if (quote === null) continue;
        offers.push({
          ratePlanId: plan.id,
          ratePlanName: plan.name,
          description: plan.description,
          exTaxMinor: quote.exTaxMinor,
          taxMinor: quote.taxMinor,
          totalMinor: quote.totalMinor,
          nightlyFromMinor: quote.nightlyRateMinor,
          promotionName: quote.promotion?.promotionName ?? null,
        });
      }
      if (offers.length === 0) continue;
      offers.sort((a, b) => a.totalMinor - b.totalMinor);
      rooms.push({
        roomTypeId: type.id,
        name: type.name,
        description: type.description,
        maxGuests: type.maxGuests,
        roomsLeft: Math.min(5, left.left),
        offers,
      });
    }

    const response: AvailabilityResponse = {
      arrivalDate: query.arrivalDate,
      departureDate: query.departureDate,
      nights,
      adults: query.adults,
      children: query.children,
      currency: ctx.currency,
      rooms,
    };
    await this.cache.set(key, JSON.stringify(response));
    return response;
  }

  /**
   * A price, or null when the plan cannot sell this stay — a closed arrival,
   * a minimum stay, an occupancy limit. Those are expected answers to a
   * search (an offer that is not available), so they are a result here, not
   * an error; anything else is a fault and propagates.
   */
  private async priceOrNull(
    propertyId: string,
    request: {
      roomTypeId: string;
      ratePlanId: string | null;
      arrivalDate: string;
      departureDate: string;
      adults: number;
      children: number;
      promoCode?: string;
    },
  ) {
    try {
      return await this.reservations.quoteForProperty(
        propertyId,
        reservationQuoteRequestSchema.parse({
          roomTypeId: request.roomTypeId,
          arrivalDate: request.arrivalDate,
          departureDate: request.departureDate,
          adults: request.adults,
          children: request.children,
          infants: 0,
          isTaxExempt: false,
          ...(request.ratePlanId === null ? {} : { ratePlanId: request.ratePlanId }),
          ...(request.promoCode === undefined ? {} : { promoCode: request.promoCode }),
        }),
      );
    } catch (error) {
      if (error instanceof DomainError) return null;
      throw error;
    }
  }

  /* -------------------------------------------------------------- quote -- */

  async quote(
    ctx: PublicPropertyContext,
    request: PublicQuoteRequest,
    client: string,
  ): Promise<PublicQuote> {
    this.throttle('quote', ctx.id, client);
    this.assertWindow(ctx, request.arrivalDate, request.departureDate);

    const types = await this.repository.roomTypes(ctx.id);
    const type = types.find((t) => t.id === request.roomTypeId);
    if (type === undefined) throw new EntityNotFoundError('Room type');
    if (
      type.maxGuests < request.adults + request.children ||
      (type.maxAdults !== null && type.maxAdults < request.adults)
    ) {
      throw new ValidationFailedError({
        adults: `${type.name} sleeps at most ${String(type.maxGuests)}.`,
      });
    }

    let planName = 'Standard rate';
    if (request.ratePlanId !== null) {
      const plan = (await this.repository.publicPlans(ctx.id)).find(
        (p) => p.id === request.ratePlanId && p.roomTypeIds.includes(type.id),
      );
      if (plan === undefined) throw new EntityNotFoundError('Rate');
      planName = plan.name;
    } else if ((await this.repository.pricedRoomTypes(ctx.id)).has(type.id)) {
      throw new ValidationFailedError({
        ratePlanId: 'Choose one of the rates offered for this room.',
      });
    }

    // Fresh, uncached: a guest should not fill a form for a room that is gone.
    const stock = (
      await this.repository.sellable(ctx.id, request.arrivalDate, request.departureDate)
    ).get(type.id);
    if (
      stock === undefined ||
      stock.nights !== days(request.arrivalDate, request.departureDate) ||
      stock.left < 1
    ) {
      throw new RoomUnavailableError({
        reason: `${type.name} is no longer available for these dates.`,
      });
    }

    // Pricing refusals (closed to arrival, minimum stay, a bad promo code) are
    // typed errors and reach the guest as such.
    const quote = await this.reservations.quoteForProperty(
      ctx.id,
      reservationQuoteRequestSchema.parse({
        roomTypeId: type.id,
        arrivalDate: request.arrivalDate,
        departureDate: request.departureDate,
        adults: request.adults,
        children: request.children,
        infants: 0,
        isTaxExempt: false,
        ...(request.ratePlanId === null ? {} : { ratePlanId: request.ratePlanId }),
        ...(request.promoCode === undefined ? {} : { promoCode: request.promoCode }),
      }),
    );

    const expiresAt = this.clock.nowMs() + QUOTE_HOLD_MINUTES * 60_000;
    const payload: QuotePayload = {
      quoteId: randomUUID(),
      propertyId: ctx.id,
      roomTypeId: type.id,
      roomTypeName: type.name,
      ratePlanId: request.ratePlanId,
      ratePlanName: planName,
      arrivalDate: request.arrivalDate,
      departureDate: request.departureDate,
      adults: request.adults,
      children: request.children,
      promoCode: request.promoCode ?? null,
      quote,
      expiresAt,
    };
    return {
      quoteToken: this.tokens.signQuote(payload),
      expiresAt: new Date(expiresAt).toISOString(),
      roomTypeName: type.name,
      ratePlanName: planName,
      arrivalDate: request.arrivalDate,
      departureDate: request.departureDate,
      nights: quote.nights,
      adults: request.adults,
      children: request.children,
      nightly: quote.nightly.map((n) => ({
        stayDate: n.stayDate,
        rateMinor: n.nightlyRateMinor,
        taxMinor: n.taxMinor,
      })),
      exTaxMinor: quote.exTaxMinor,
      taxMinor: quote.taxMinor,
      totalMinor: quote.totalMinor,
      currency: quote.currency,
      promotionName: quote.promotion?.promotionName ?? null,
    };
  }

  /* --------------------------------------------------------------- book -- */

  async book(
    ctx: PublicPropertyContext,
    request: PublicBookRequest,
    client: string,
  ): Promise<PublicBooking> {
    this.throttle('book', ctx.id, client);
    const held = this.tokens.verifyQuote(request.quoteToken);
    if (held === null || held.propertyId !== ctx.id) {
      throw new ValidationFailedError({
        quoteToken: 'This price could not be verified. Please search again.',
      });
    }
    if (held.expiresAt <= this.clock.nowMs()) {
      throw new ValidationFailedError({
        quoteToken: `This price was held for ${String(QUOTE_HOLD_MINUTES)} minutes and has expired. Please search again for the current price.`,
      });
    }
    if (
      request.paymentChoice === 'PAY_NOW' &&
      !(await this.payments.canTakeOnlinePayments(ctx.id))
    ) {
      throw new ValidationFailedError({
        paymentChoice: 'Online payment is not available at this hotel. Choose to pay at the hotel.',
      });
    }

    const command = createReservationSchema.parse({
      roomTypeId: held.roomTypeId,
      roomId: null,
      arrivalDate: held.arrivalDate,
      departureDate: held.departureDate,
      adults: held.adults,
      children: held.children,
      source: 'DIRECT_WEB',
      guests: [
        {
          firstName: request.guest.firstName,
          lastName: request.guest.lastName,
          email: request.guest.email,
          phone: request.guest.phone,
        },
      ],
      ...(held.ratePlanId === null ? {} : { ratePlanId: held.ratePlanId }),
      ...(held.promoCode === null ? {} : { promoCode: held.promoCode }),
      notes:
        request.specialRequests === null
          ? null
          : `Guest request (online): ${request.specialRequests}`,
    });

    let reservationId: string;
    let replayed = false;
    try {
      const created = await this.reservations.createForGuest(ctx.id, command, held.quote, {
        before: async (tx) => {
          await this.repository.lockQuote(tx, ctx.id, held.quoteId);
          const earlier = await this.repository.existingForQuote(tx, ctx.id, held.quoteId);
          if (earlier !== null) throw new AlreadyBooked(earlier.reservationId);
        },
        after: async (tx, reservation) => {
          await this.repository.recordOnline(
            tx,
            {
              propertyId: ctx.id,
              reservationId: reservation.id,
              quoteId: held.quoteId,
              paymentChoice: request.paymentChoice,
            },
            {
              bookingCode: reservation.bookingCode,
              quoteId: held.quoteId,
              ratePlanId: held.ratePlanId,
              totalMinor: held.quote.totalMinor,
              currency: held.quote.currency,
              paymentChoice: request.paymentChoice,
            },
            request.paymentChoice === 'PAY_NOW' ? held.quote.currency : null,
          );
        },
      });
      reservationId = created.id;
    } catch (error) {
      if (!(error instanceof AlreadyBooked)) throw error;
      reservationId = error.reservationId;
      replayed = true;
    }

    const row = await this.repository.bookingById(ctx.id, reservationId);
    if (row === null) throw new EntityNotFoundError('Booking');
    if (request.paymentChoice === 'PAY_NOW') await this.linkFor(ctx.id, reservationId);
    return { ...(await this.view(ctx, row.confirmationCode)), replayed };
  }

  /* --------------------------------------------------------- view & pay -- */

  async read(
    ctx: PublicPropertyContext,
    bookingCode: string,
    access: string,
  ): Promise<PublicBooking> {
    await this.authorise(ctx, bookingCode, access);
    return { ...(await this.view(ctx, bookingCode)), replayed: false };
  }

  async pay(
    ctx: PublicPropertyContext,
    bookingCode: string,
    access: string,
    client: string,
  ): Promise<PublicBooking> {
    this.throttle('pay', ctx.id, client);
    const reservationId = await this.authorise(ctx, bookingCode, access);
    if (!(await this.payments.canTakeOnlinePayments(ctx.id))) {
      throw new ValidationFailedError({
        payment: 'Online payment is not available at this hotel.',
      });
    }
    // Asked for explicitly, so a failure is the guest's answer: not absorbed.
    const link = await this.payments.sendGuestLink(ctx.id, reservationId);
    if (link === null)
      throw new ValidationFailedError({ payment: 'Nothing is owed on this booking.' });
    return { ...(await this.view(ctx, bookingCode)), replayed: false };
  }

  /**
   * The payment link straight after booking. The room is already booked, so a
   * failure here must not look like a failed booking: it is logged with the
   * ids (never the guest) and the guest sees no link. They can ask again from
   * the confirmation page, where a failure IS reported (`pay`).
   */
  private async linkFor(propertyId: string, reservationId: string): Promise<PaymentLink | null> {
    try {
      return await this.payments.sendGuestLink(propertyId, reservationId);
    } catch (error) {
      this.logger.warn(
        `Online payment link not created for reservation ${reservationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** The booking's id, when the access token is right; not-found otherwise (never 403). */
  private async authorise(
    ctx: PublicPropertyContext,
    bookingCode: string,
    access: string,
  ): Promise<string> {
    const row = await this.repository.booking(ctx.id, bookingCode);
    if (row === null || !this.tokens.verifyAccess(ctx.id, row.id, access))
      throw new EntityNotFoundError('Booking');
    return row.id;
  }

  private async view(
    ctx: PublicPropertyContext,
    bookingCode: string,
  ): Promise<Omit<PublicBooking, 'replayed'>> {
    const row = await this.repository.booking(ctx.id, bookingCode);
    if (row === null) throw new EntityNotFoundError('Booking');
    const lines = row.folio?.lines ?? [];
    const paid = -lines
      .filter((l) => l.kind === 'PAYMENT' || l.kind === 'REFUND')
      .reduce((s, l) => s + l.amountMinor, 0);
    const link = row.folio?.paymentLinks[0] ?? null;
    const choice = (row.onlineBooking[0]?.paymentChoice ?? 'PAY_AT_HOTEL') as PaymentChoice;
    return {
      bookingCode: row.confirmationCode,
      accessToken: this.tokens.access(ctx.id, row.id),
      status: String(row.status),
      guestName: `${row.guestFirstName} ${row.guestLastName}`.trim(),
      roomTypeName: row.rooms[0]?.roomType.name ?? '',
      arrivalDate: businessDateSchema.parse(row.arrivalDate.toISOString().slice(0, 10)),
      departureDate: businessDateSchema.parse(row.departureDate.toISOString().slice(0, 10)),
      nights: days(
        row.arrivalDate.toISOString().slice(0, 10),
        row.departureDate.toISOString().slice(0, 10),
      ),
      adults: row.adults,
      children: row.children,
      currency: row.currency.trim(),
      totalMinor: row.totalAmountMinor,
      paidMinor: paid,
      balanceMinor: row.totalAmountMinor - paid,
      paymentChoice: choice,
      payment:
        link === null
          ? null
          : {
              url: link.status === 'ACTIVE' ? link.shortUrl : null,
              status: String(link.status),
              amountMinor: link.amountMinor,
            },
    };
  }

  /* ------------------------------------------------------------ helpers -- */

  private assertWindow(ctx: PublicPropertyContext, arrival: string, departure: string): void {
    const nights = days(arrival, departure);
    if (nights < 1)
      throw new ValidationFailedError({ departureDate: 'Check-out must be after check-in.' });
    if (nights > MAX_ONLINE_NIGHTS) {
      throw new ValidationFailedError({
        departureDate: `Online bookings are for up to ${String(MAX_ONLINE_NIGHTS)} nights. Please contact the hotel for longer stays.`,
      });
    }
    // The hotel's own date (section 3.3), never the server's.
    if (arrival < ctx.businessDate)
      throw new ValidationFailedError({ arrivalDate: 'Check-in cannot be in the past.' });
    if (days(ctx.businessDate, arrival) > MAX_ONLINE_LEAD_DAYS) {
      throw new ValidationFailedError({
        arrivalDate: `Bookings open ${String(MAX_ONLINE_LEAD_DAYS)} days ahead.`,
      });
    }
  }

  private throttle(kind: keyof typeof LIMITS, propertyId: string, client: string): void {
    const { limit, windowSeconds } = LIMITS[kind];
    const decision = this.limiter.consume(
      `booking-engine:${kind}:${propertyId}:${client}`,
      limit,
      windowSeconds,
    );
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }
}
