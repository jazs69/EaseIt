'use client';

/**
 * Choose a room and rate, see the held price, enter details, book.
 *
 * The quote is held in component state (it can run to several kilobytes for a
 * long stay, too much for a URL or a cookie) and sent back exactly as the API
 * signed it. After booking, the guest lands on their confirmation page, whose
 * address carries the booking's access token.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  QUOTE_HOLD_MINUTES,
  format,
  money,
  type AvailabilityResponse,
  type PaymentChoice,
  type PublicQuote,
} from '@repo/types';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@repo/ui';

import { bookStay, quoteStay } from './actions';

const price = (minor: number, currency: string) => format(money(minor, currency));
const input = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

export function RoomResults({
  slug,
  results,
  prepayAvailable,
}: {
  slug: string;
  results: AvailabilityResponse;
  prepayAvailable: boolean;
}) {
  const router = useRouter();
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<PaymentChoice>('PAY_AT_HOTEL');

  const select = (roomTypeId: string, ratePlanId: string | null) => {
    setError(null);
    start(async () => {
      const result = await quoteStay(slug, {
        roomTypeId,
        ratePlanId,
        arrivalDate: results.arrivalDate,
        departureDate: results.departureDate,
        adults: results.adults,
        children: results.children,
      });
      if (result.ok) setQuote(result.value);
      else setError(result.message);
    });
  };

  const book = (form: FormData) => {
    if (quote === null) return;
    setError(null);
    start(async () => {
      const text = (key: string) => String(form.get(key) ?? '').trim();
      const result = await bookStay(slug, {
        quoteToken: quote.quoteToken,
        guest: {
          firstName: text('firstName'),
          lastName: text('lastName'),
          email: text('email'),
          phone: text('phone'),
        },
        specialRequests: text('specialRequests') === '' ? null : text('specialRequests'),
        paymentChoice: choice,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const booking = result.value;
      if (choice === 'PAY_NOW' && booking.payment?.url) {
        window.location.assign(booking.payment.url);
        return;
      }
      router.push(
        `/${encodeURIComponent(slug)}/booking/${encodeURIComponent(booking.bookingCode)}?access=${encodeURIComponent(booking.accessToken)}`,
      );
    });
  };

  if (quote !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {quote.roomTypeName} · {quote.ratePlanName}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {quote.arrivalDate} to {quote.departureDate} · {quote.nights} night
            {quote.nights === 1 ? '' : 's'} · {quote.adults} adult{quote.adults === 1 ? '' : 's'}
            {quote.children > 0
              ? `, ${String(quote.children)} child${quote.children === 1 ? '' : 'ren'}`
              : ''}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-muted-foreground">Room</dt>
            <dd className="tabular text-right">{price(quote.exTaxMinor, quote.currency)}</dd>
            <dt className="text-muted-foreground">Taxes</dt>
            <dd className="tabular text-right">{price(quote.taxMinor, quote.currency)}</dd>
            <dt className="font-medium">Total</dt>
            <dd className="tabular text-right text-lg font-semibold">
              {price(quote.totalMinor, quote.currency)}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            This price is held for {QUOTE_HOLD_MINUTES} minutes. The room is confirmed when you
            book.
          </p>

          <form action={book} className="grid gap-3 sm:grid-cols-2">
            <input
              className={input}
              name="firstName"
              placeholder="First name"
              autoComplete="given-name"
              required
              maxLength={80}
            />
            <input
              className={input}
              name="lastName"
              placeholder="Last name"
              autoComplete="family-name"
              required
              maxLength={80}
            />
            <input
              className={input}
              name="email"
              type="email"
              placeholder="Email"
              autoComplete="email"
              required
              maxLength={160}
            />
            <input
              className={input}
              name="phone"
              type="tel"
              placeholder="Phone"
              autoComplete="tel"
              required
              maxLength={32}
            />
            <textarea
              className={`${input} h-20 py-2 sm:col-span-2`}
              name="specialRequests"
              placeholder="Special requests (optional)"
              maxLength={500}
            />
            <fieldset className="flex flex-col gap-2 text-sm sm:col-span-2">
              <legend className="mb-1 font-medium">Payment</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="payment"
                  checked={choice === 'PAY_AT_HOTEL'}
                  onChange={() => setChoice('PAY_AT_HOTEL')}
                />
                Pay at the hotel
              </label>
              <label className={`flex items-center gap-2 ${prepayAvailable ? '' : 'opacity-50'}`}>
                <input
                  type="radio"
                  name="payment"
                  disabled={!prepayAvailable}
                  checked={choice === 'PAY_NOW'}
                  onChange={() => setChoice('PAY_NOW')}
                />
                Pay now online (card, UPI, netbanking)
                {prepayAvailable ? '' : ' — not available at this hotel'}
              </label>
            </fieldset>
            {error !== null && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {error}
              </p>
            )}
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={pending}>
                {pending ? 'Booking…' : choice === 'PAY_NOW' ? 'Book and pay' : 'Book now'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setQuote(null)}
              >
                Back to rooms
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}
      {results.rooms.map((room) => (
        <Card key={room.roomTypeId}>
          <CardHeader>
            <CardTitle>{room.name}</CardTitle>
            <p className="text-sm text-muted-foreground">
              Sleeps {room.maxGuests}
              {room.roomsLeft <= 3 ? ` · only ${String(room.roomsLeft)} left` : ''}
            </p>
            {room.description && <p className="text-sm">{room.description}</p>}
          </CardHeader>
          <CardContent className="flex flex-col divide-y">
            {room.offers.map((offer) => (
              <div
                key={offer.ratePlanId ?? 'standard'}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{offer.ratePlanName}</span>
                  {offer.promotionName && (
                    <span className="text-xs text-emerald-700">{offer.promotionName}</span>
                  )}
                  {offer.description && (
                    <span className="text-xs text-muted-foreground">{offer.description}</span>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="tabular text-lg font-semibold">
                      {price(offer.totalMinor, results.currency)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {results.nights} night{results.nights === 1 ? '' : 's'}, taxes included
                    </div>
                  </div>
                  <Button
                    disabled={pending}
                    onClick={() => select(room.roomTypeId, offer.ratePlanId)}
                  >
                    Select
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
