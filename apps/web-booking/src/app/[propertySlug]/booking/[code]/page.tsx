import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { format, money, publicBookingSchema } from '@repo/types';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@repo/ui';

import { BookingApiError, bookingApi } from '@/lib/booking-api';
import { PayButton } from './pay-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your booking',
  robots: { index: false, follow: false },
};

/**
 * A guest's confirmation page. Reachable only with the booking's access
 * token in the address; without it, or with another hotel's slug, the API
 * answers not-found and so does this page.
 */
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertySlug: string; code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { propertySlug, code } = await params;
  const accessParam = (await searchParams)['access'];
  const access = Array.isArray(accessParam) ? accessParam[0] : accessParam;
  if (access === undefined) notFound();

  let booking;
  try {
    booking = await bookingApi(
      `/${encodeURIComponent(propertySlug)}/bookings/${encodeURIComponent(code)}?access=${encodeURIComponent(access)}`,
      publicBookingSchema,
    );
  } catch (error) {
    if (error instanceof BookingApiError && (error.status === 404 || error.status === 400))
      notFound();
    throw error;
  }

  const price = (minor: number) => format(money(minor, booking.currency));
  const owed = booking.balanceMinor > 0 && booking.status === 'CONFIRMED';

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <Badge variant="secondary" className="w-fit">
          {booking.status === 'CONFIRMED'
            ? 'Confirmed'
            : booking.status.replaceAll('_', ' ').toLowerCase()}
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Thank you, {booking.guestName}</h1>
        <p className="text-sm text-muted-foreground">
          Booking reference{' '}
          <span className="font-mono font-medium text-foreground">{booking.bookingCode}</span>. A
          confirmation has been emailed to you.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{booking.roomTypeName}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {booking.arrivalDate} to {booking.departureDate} · {booking.nights} night
            {booking.nights === 1 ? '' : 's'}
          </p>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-muted-foreground">Total</dt>
            <dd className="tabular text-right">{price(booking.totalMinor)}</dd>
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="tabular text-right">{price(booking.paidMinor)}</dd>
            <dt className="font-medium">{owed ? 'To pay' : 'Balance'}</dt>
            <dd className="tabular text-right font-semibold">{price(booking.balanceMinor)}</dd>
          </dl>
        </CardContent>
      </Card>
      {owed && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {booking.paymentChoice === 'PAY_NOW'
              ? 'Your payment has not been received yet. You can pay now, or at the hotel.'
              : 'You chose to pay at the hotel. You can also pay now online.'}
          </p>
          <PayButton
            slug={propertySlug}
            code={booking.bookingCode}
            access={access}
            existingUrl={booking.payment?.url ?? null}
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Keep this page’s address: it is how you can see this booking again.
      </p>
    </main>
  );
}
