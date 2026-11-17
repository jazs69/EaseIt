import type { Metadata } from 'next';
import { Activity } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { RevenueScreen } from '@/components/revenue/revenue-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchRevenue } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Revenue',
  description: 'Closed-day revenue, occupancy, ADR and RevPAR, as the night audit froze them.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Revenue, at `/revenue?hotelId=31336` (RP-10).
 *
 * Reads the night audit's closed-day snapshots through the API, so it agrees
 * with the flash report and the dashboard. The first window (the month of the
 * last closed day) is fetched server-side. A user without
 * `financial_reports:read` gets a plain explanation, not an error page.
 */
export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { cookieHeader } = await requireSession();

  let overview;
  try {
    overview = await fetchRevenue(hotelId, {}, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={Activity}
            title="Revenue"
            summary="Closed-day revenue, occupancy, ADR and RevPAR, as the night audit froze them."
            blockedBy="Your role at this property does not include financial reports (financial_reports:read). Ask an administrator to grant it."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Revenue</h1>
        <p className="text-sm text-muted-foreground">
          {overview.propertyName}: closed days as the night audit froze them. Business date{' '}
          {overview.businessDate} ({overview.timeZone}).
        </p>
      </header>
      <RevenueScreen hotelId={hotelId} initial={overview} />
    </main>
  );
}
