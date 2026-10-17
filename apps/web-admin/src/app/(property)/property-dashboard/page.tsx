import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AvailabilityPanel } from '@/components/property-dashboard/availability-panel';
import { PropertyDashboardView } from '@/components/property-dashboard/property-dashboard-view';
import {
  fetchPropertyDashboard,
  parseIsoDate,
  parseMetric,
} from '@/lib/properties-client';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Property dashboard',
  description: 'Daily front-desk operations for one property.',
  robots: { index: false, follow: false },
};

// Per-request and per-property. Never statically rendered or cached.
export const dynamic = 'force-dynamic';

/** One `?key=` value, ignoring a repeated parameter's extras. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The hour of day at the property, for the greeting.
 *
 * Formatted through `Intl` in the property's own IANA zone rather than read
 * off the server's clock: a hotel in Asia/Kolkata must not be greeted "good
 * evening" because the process happens to run in London
 * (CLAUDE.md section 3.3).
 */
function localHourAt(timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  const parsed = Number.parseInt(hour, 10);
  return Number.isNaN(parsed) ? 9 : parsed % 24;
}

/**
 * Property operations dashboard.
 *
 * Reached as `/property-dashboard?hotelId=31336`. `hotelId` is an untrusted
 * lookup key, exactly like the `:propertyId` path segment it replaces: the API
 * resolves it through the caller's own `UserPropertyRole` rows, so an id
 * belonging to another hotel comes back as not-found rather than as data
 * (CLAUDE.md section 3.2). Nothing here needs to re-check that — but nothing
 * here may assume it either, which is why the id is only ever passed through.
 */
export default async function PropertyDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = first(params['hotelId']);

  if (hotelId === undefined || hotelId.trim().length === 0) {
    // No property named, so there is nothing to show. Back to the picker
    // rather than an error page: the operator's next action is to choose one.
    redirect('/group-dashboard');
  }

  const { cookieHeader } = await requireSession();

  const metric = parseMetric(first(params['metric']));
  const date = parseIsoDate(first(params['date']));

  const dashboard = await fetchPropertyDashboard({
    hotelId,
    metric,
    ...(date === undefined ? {} : { date }),
    cookieHeader,
  });

  return (
    <>
      {/* The top bar is rendered once by `(property)/layout.tsx`, so it is not
          repeated here — a second copy would double the row and remount on
          every navigation. */}
      <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6 px-4 py-6 sm:px-6 xl:flex-row">
        {/* `min-w-0` is load-bearing: without it the feed refuses to shrink
            inside the flex row and pushes the sidebar off-screen. */}
        <main className="min-w-0 flex-1">
          <PropertyDashboardView
            dashboard={dashboard}
            localHour={localHourAt(dashboard.property.timezone)}
          />
        </main>

        <AvailabilityPanel
          availability={dashboard.availability}
          alerts={dashboard.alerts}
          targetDate={dashboard.targetDate}
        />
      </div>
    </>
  );
}
