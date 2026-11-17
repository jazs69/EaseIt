import type { Metadata } from 'next';
import { ArrowDownUp } from 'lucide-react';
import { Permission } from '@repo/types';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { DataExchangeScreen } from '@/components/data-exchange/data-exchange-screen';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Import & export',
  description: 'Bulk-load room types, rooms and rates from CSV, and download the property’s data.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Import & export, at `/data-exchange?hotelId=31336` (IE-01, IE-02).
 *
 * Each part is offered by what the caller's role carries: room types and
 * rooms need `rooms:manage`, rates `rates:manage`, export `data:export`. The
 * server enforces all three; this only decides what to show.
 */
export default async function DataExchangePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { session } = await requireSession();
  const has = (permission: Permission) => session.permissions.includes(permission);
  const canRooms = has(Permission.ROOMS_MANAGE);
  const canRates = has(Permission.RATES_MANAGE);
  const canExport = has(Permission.DATA_EXPORT);

  if (!canRooms && !canRates && !canExport) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
        <PlaceholderScreen
          icon={ArrowDownUp}
          title="Import & export"
          summary="Bulk-load room types, rooms and rates from CSV, and download the property’s data."
          blockedBy="Your role at this property includes none of rooms:manage, rates:manage or data:export."
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import &amp; export</h1>
        <p className="text-sm text-muted-foreground">
          Check a file first: nothing is written until you import a clean check, and then all of it
          is written or none of it.
        </p>
      </header>
      <DataExchangeScreen
        hotelId={hotelId}
        canRooms={canRooms}
        canRates={canRates}
        canExport={canExport}
      />
    </main>
  );
}
