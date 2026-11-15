import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { RoomsScreen } from '@/components/rooms/rooms-screen';
import { fetchRoomTypes, fetchRooms } from '@/lib/properties-client';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Rooms',
  description: 'Room categories, physical rooms and housekeeping status for one property.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Rooms, at `/rooms?hotelId=31336`.
 *
 * ===========================================================================
 * A route in the `(property)` group, so it inherits the unified top bar from
 * `(property)/layout.tsx` -- the only layout that renders it.
 *
 * READ-ONLY IN THIS RELEASE. The create and edit endpoints exist and are
 * permission-gated, but their integration tests have not been run, so no write
 * control is surfaced here yet. A form that posts to an unverified write path
 * is worse than a table.
 *
 * NO AVAILABILITY IS SHOWN, and the screen says so. Room blocks have no read
 * endpoint in this release, so this page cannot know whether a room is
 * withheld from sale -- and a Blocked column rendering nothing would read as
 * "not blocked". See `RoomsScreen` for the full reasoning.
 *
 * Both fetches are server-side so the first paint already carries the data,
 * and both go through `requireSession`, so an expired session redirects rather
 * than rendering an empty screen.
 * ===========================================================================
 */
export default async function RoomsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = first(params['hotelId']);

  // Property-scoped, so it needs a property. Same contract as `/calendar` and
  // `/rates-inventory`: back to the picker rather than guessing a hotel the
  // caller may hold no grant at (CLAUDE.md section 3.2).
  if (hotelId === undefined || hotelId.trim().length === 0) {
    redirect('/group-dashboard');
  }

  const { cookieHeader } = await requireSession();

  // Sequential rather than parallel on purpose: the room list is the larger
  // query and there is no benefit to racing it against a list of at most a
  // handful of categories.
  const roomTypes = await fetchRoomTypes(hotelId, { cookieHeader });
  const rooms = await fetchRooms(hotelId, { limit: 200 }, { cookieHeader });

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Rooms</h1>
        <p className="text-sm text-muted-foreground">
          Categories, physical rooms and housekeeping status for this property.
        </p>
      </header>

      <RoomsScreen roomTypes={roomTypes} rooms={rooms} />
    </main>
  );
}
