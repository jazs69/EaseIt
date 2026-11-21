import type { Metadata } from 'next';
import { Network } from 'lucide-react';

import { ChannelsScreen } from '@/components/channels/channels-screen';
import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchChannelOverview } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Channels',
  description: 'OTA distribution: connection, mappings, ARI pushes and inbound bookings.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Channels, at `/channels?hotelId=31336` (CM-01 .. CM-05).
 *
 * Reading needs `channels:read`; connecting, mapping and acting on inbound
 * bookings `channels:manage`; "sync now" `channels:sync`. The server enforces
 * all three; the buttons are offered by what the role carries.
 */
export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { session, cookieHeader } = await requireSession();

  let overview;
  try {
    overview = await fetchChannelOverview(hotelId, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={Network}
            title="Channels"
            summary="OTA distribution: connection, mappings, ARI pushes and inbound bookings."
            blockedBy="Your role at this property does not include the channel manager (channels:read)."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Availability, rates and restrictions go out to the OTAs on every change; their bookings
          come back in as reservations.
        </p>
      </header>
      <ChannelsScreen
        hotelId={hotelId}
        initial={overview}
        canManage={session.permissions.includes('channels:manage')}
        canSync={session.permissions.includes('channels:sync')}
      />
    </main>
  );
}
