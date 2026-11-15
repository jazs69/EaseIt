import type { Metadata } from 'next';
import { Moon } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { NightAuditScreen } from '@/components/night-audit/night-audit-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchNightAuditOverview } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Night audit',
  description: 'Run the audit, review each step and close the business date.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Night audit, at `/night-audit?hotelId=31336` (NA-07).
 *
 * The first paint carries the business date and recent runs, fetched
 * server-side. The screen enqueues a run and polls its steps; it never runs
 * the audit itself (CLAUDE.md section 3.3). A user without
 * `night_audit:read` gets a plain explanation rather than an error page.
 */
export default async function NightAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { cookieHeader } = await requireSession();

  let overview;
  try {
    overview = await fetchNightAuditOverview(hotelId, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={Moon}
            title="Night audit"
            summary="Run the audit, review each step and close the business date."
            blockedBy="Your role at this property does not include night audit access (night_audit:read). Ask an administrator to grant it."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Night audit</h1>
        <p className="text-sm text-muted-foreground">
          Closes the business date: no-shows, room charges, settlement, the day&apos;s figures and the date roll.
        </p>
      </header>
      <NightAuditScreen hotelId={hotelId} initial={overview} />
    </main>
  );
}
