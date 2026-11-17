import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  MAX_ONLINE_NIGHTS,
  availabilityQuerySchema,
  availabilityResponseSchema,
  bookingEnginePropertySchema,
  type AvailabilityResponse,
} from '@repo/types';
import { Badge } from '@repo/ui';

import { BookingApiError, bookingApi } from '@/lib/booking-api';
import { RoomResults } from './room-results';

export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ propertySlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function loadProperty(slug: string) {
  try {
    return await bookingApi(`/${encodeURIComponent(slug)}`, bookingEnginePropertySchema);
  } catch (error) {
    if (error instanceof BookingApiError && error.status === 404) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { propertySlug } = await params;
  const property = await loadProperty(propertySlug);
  return {
    title: property.name,
    description: `Book direct at ${property.name}${property.city ? `, ${property.city}` : ''}.`,
  };
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * A hotel's booking page (BE-02): live availability and real rates.
 *
 * The slug is a lookup key in the path; the API resolves it to a property on
 * the server (BE-05). The search is a plain GET form, so a search is a
 * shareable URL; results are fetched here, on the server.
 */
export default async function PropertyBookingPage({ params, searchParams }: Params) {
  const { propertySlug } = await params;
  const query = await searchParams;
  const property = await loadProperty(propertySlug);

  const arrival = one(query['arrivalDate']) ?? addDays(property.today, 1);
  const departure = one(query['departureDate']) ?? addDays(arrival, 1);
  const adults = one(query['adults']) ?? '2';
  const children = one(query['children']) ?? '0';
  const searched = one(query['arrivalDate']) !== undefined;

  let results: AvailabilityResponse | null = null;
  let problem: string | null = null;
  if (searched) {
    const parsed = availabilityQuerySchema.safeParse({
      arrivalDate: arrival,
      departureDate: departure,
      adults,
      children,
    });
    if (!parsed.success) {
      problem = parsed.error.issues[0]?.message ?? 'Check the dates and guests.';
    } else {
      try {
        const qs = new URLSearchParams({
          arrivalDate: arrival,
          departureDate: departure,
          adults: String(parsed.data.adults),
          children: String(parsed.data.children),
        });
        results = await bookingApi(
          `/${encodeURIComponent(propertySlug)}/availability?${qs.toString()}`,
          availabilityResponseSchema,
        );
      } catch (error) {
        if (!(error instanceof BookingApiError)) throw error;
        problem = error.guestMessage;
      }
    }
  }

  const field = 'h-10 rounded-md border border-input bg-background px-3 text-sm';
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <Badge variant="secondary" className="w-fit">
          Book direct
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight">{property.name}</h1>
        <p className="text-sm text-muted-foreground">
          {property.city ? `${property.city} · ` : ''}Check-in from{' '}
          {property.checkInTime ?? '14:00'}, check-out by {property.checkOutTime ?? '11:00'}
        </p>
      </header>

      <form
        method="get"
        className="grid grid-cols-2 gap-3 rounded-xl border p-4 sm:grid-cols-5 sm:items-end"
      >
        <label className="flex flex-col gap-1 text-xs font-medium">
          Check-in
          <input
            className={field}
            type="date"
            name="arrivalDate"
            defaultValue={arrival}
            min={property.today}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Check-out
          <input
            className={field}
            type="date"
            name="departureDate"
            defaultValue={departure}
            min={addDays(property.today, 1)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Adults
          <input
            className={field}
            type="number"
            name="adults"
            min={1}
            max={20}
            defaultValue={adults}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Children
          <input
            className={field}
            type="number"
            name="children"
            min={0}
            max={20}
            defaultValue={children}
          />
        </label>
        <button
          type="submit"
          className="col-span-2 h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground sm:col-span-1"
        >
          Check availability
        </button>
      </form>
      <p className="-mt-6 text-xs text-muted-foreground">
        Up to {MAX_ONLINE_NIGHTS} nights online. Prices include all taxes shown.
      </p>

      {problem !== null && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {problem}
        </p>
      )}

      {results !== null &&
        (results.rooms.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rooms are available for those dates and guests. Try other dates.
          </p>
        ) : (
          <RoomResults
            slug={propertySlug}
            results={results}
            prepayAvailable={property.prepayAvailable}
          />
        ))}
    </main>
  );
}
