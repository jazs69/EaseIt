import type { Metadata } from 'next';
import { UsersRound } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { GuestProfilesScreen } from '@/components/guests/guest-profiles-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchGuestProfiles } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Guest profiles',
  description: 'Reusable guest profiles: stay history, preferences and notes.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Guest profiles, at `/guests?hotelId=31336` (GP-02).
 *
 * The first page is fetched server-side. Reading needs `reservations:read`
 * and editing `reservations:edit`; the server enforces both.
 */
export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { session, cookieHeader } = await requireSession();

  let page;
  try {
    page = await fetchGuestProfiles(hotelId, {}, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={UsersRound}
            title="Guest profiles"
            summary="Reusable guest profiles: stay history, preferences and notes."
            blockedBy="Your role at this property does not include reading reservations (reservations:read)."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Guest profiles</h1>
        <p className="text-sm text-muted-foreground">
          One profile per guest at this property. Link a booking&apos;s guest to it to build their
          stay history; matching emails and phones are suggested, never merged.
        </p>
      </header>
      <GuestProfilesScreen
        hotelId={hotelId}
        initial={page}
        canEdit={session.permissions.includes('reservations:edit')}
      />
    </main>
  );
}
