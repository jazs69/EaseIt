import type { Metadata } from 'next';
import { BrushCleaning } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { HousekeepingBoardView } from '@/components/housekeeping/housekeeping-board';
import { ApiRequestError } from '@/lib/api';
import { fetchHousekeepingBoard } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Housekeeping',
  description: 'Room status, cleaning and inspection tasks.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Housekeeping, at `/housekeeping?hotelId=31336` (HK-02).
 *
 * The board is fetched server-side so the first paint carries it. A user
 * without housekeeping:read gets a plain explanation, not an error page.
 */
export default async function HousekeepingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { cookieHeader } = await requireSession();

  let board;
  try {
    board = await fetchHousekeepingBoard(hotelId, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={BrushCleaning}
            title="Housekeeping"
            summary="Room status, cleaning and inspection tasks."
            blockedBy="Your role at this property does not include housekeeping access (housekeeping:read). Ask an administrator to grant it."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Housekeeping</h1>
        <p className="text-sm text-muted-foreground">
          Business date {board.businessDate}. Status, arrivals and departures, and the work on each room.
        </p>
      </header>
      <HousekeepingBoardView hotelId={hotelId} initial={board} />
    </main>
  );
}
