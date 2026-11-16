import type { Metadata } from 'next';
import { ConciergeBell } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { FrontDeskBoardView } from '@/components/frontdesk/front-desk-board';
import { ApiRequestError } from '@/lib/api';
import { fetchFrontDeskBoard } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Arrivals & departures',
  description: "Today's arrivals, departures and in-house guests.",
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Arrivals and departures, at `/front-desk?hotelId=31336` (FD-09).
 *
 * Fetched server-side so the first paint carries the board. A user without
 * reservations:read gets a plain explanation, not an error page.
 */
export default async function FrontDeskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { cookieHeader } = await requireSession();

  let board;
  try {
    board = await fetchFrontDeskBoard(hotelId, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={ConciergeBell}
            title="Arrivals & departures"
            summary="Today's arrivals, departures and in-house guests."
            blockedBy="Your role at this property does not include reservations:read. Ask an administrator to grant it."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Arrivals &amp; departures</h1>
        <p className="text-sm text-muted-foreground">
          Business date {board.businessDate}. Overdue arrivals and overstays are listed first.
        </p>
      </header>
      <FrontDeskBoardView hotelId={hotelId} initial={board} />
    </main>
  );
}
