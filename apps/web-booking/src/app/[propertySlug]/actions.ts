'use server';

/**
 * The booking site's writes, run on the server (BE-02/BE-03/BE-04).
 *
 * Each returns a plain result rather than throwing, so the form can show the
 * API's own sentence ("that room has just been booked", "the price hold has
 * expired") next to the button the guest pressed.
 */

import {
  publicBookingSchema,
  publicQuoteSchema,
  type PaymentChoice,
  type PublicBooking,
  type PublicQuote,
} from '@repo/types';

import { BookingApiError, bookingApi } from '@/lib/booking-api';

export type ActionResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function attempt<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof BookingApiError) return { ok: false, message: error.guestMessage };
    // A network failure or an unexpected response: nothing was booked that we know of.
    return { ok: false, message: 'We could not reach the hotel just now. Please try again.' };
  }
}

const slugPath = (slug: string) => `/${encodeURIComponent(slug)}`;

export async function quoteStay(
  slug: string,
  request: {
    roomTypeId: string;
    ratePlanId: string | null;
    arrivalDate: string;
    departureDate: string;
    adults: number;
    children: number;
  },
): Promise<ActionResult<PublicQuote>> {
  return attempt(() =>
    bookingApi(`${slugPath(slug)}/quotes`, publicQuoteSchema, { method: 'POST', body: request }),
  );
}

export async function bookStay(
  slug: string,
  request: {
    quoteToken: string;
    guest: { firstName: string; lastName: string; email: string; phone: string };
    specialRequests: string | null;
    paymentChoice: PaymentChoice;
  },
): Promise<ActionResult<PublicBooking>> {
  return attempt(() =>
    bookingApi(`${slugPath(slug)}/bookings`, publicBookingSchema, {
      method: 'POST',
      body: request,
    }),
  );
}

export async function payForBooking(
  slug: string,
  bookingCode: string,
  access: string,
): Promise<ActionResult<PublicBooking>> {
  return attempt(() =>
    bookingApi(
      `${slugPath(slug)}/bookings/${encodeURIComponent(bookingCode)}/pay?access=${encodeURIComponent(access)}`,
      publicBookingSchema,
      { method: 'POST' },
    ),
  );
}
