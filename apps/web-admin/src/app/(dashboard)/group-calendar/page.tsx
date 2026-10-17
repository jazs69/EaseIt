import type { Metadata } from 'next';

import { DailyOccupancyStrip } from '@/components/calendar/daily-occupancy-strip';
import { GroupCalendarHeader } from '@/components/calendar/group-calendar-header';
import { GroupKpiCards } from '@/components/calendar/group-kpi-cards';
import { PropertiesOverviewAccordion } from '@/components/calendar/properties-overview-accordion';
import { fetchGroupCalendar, parseIsoDate } from '@/lib/properties-client';
import { requireCookieHeader } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Group reservation calendar',
  description: 'Occupancy across every property in your group.',
  robots: { index: false, follow: false },
};

// Per-user and per-window. Never statically rendered or cached.
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Group reservation calendar.
 *
 * ===========================================================================
 * A server component, not the client page the spec sketched. That sketch had
 * three problems worth naming, because each is a live bug rather than a style
 * preference:
 *
 *   1. `localStorage.getItem('token')` — there is no token in localStorage.
 *      The session is an httpOnly cookie precisely so that page scripts
 *      cannot read it, so that call returns null and sends `Bearer null`.
 *      `apiFetch` sends the cookie with `credentials: 'include'` instead.
 *   2. `new Date().toISOString().split('T')[0]` — converts a *local* date
 *      through UTC. At 02:00 in Asia/Kolkata that yields yesterday, so a night
 *      auditor would open the wrong week (CLAUDE.md section 3.3). The window
 *      now defaults to the reference property's own business date, resolved
 *      server-side.
 *   3. `useEffect` + `setState` to fetch — the cascading render the
 *      react-hooks rule rejects, and a guaranteed loading flash on every
 *      step. Fetching here means the first paint already has data.
 *
 * Window and filter state lives in the URL, so stepping weeks is navigable,
 * bookmarkable and survives a refresh.
 * ===========================================================================
 */
export default async function GroupCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const startDate = parseIsoDate(first(params['startDate']));
  const endDate = parseIsoDate(first(params['endDate']));
  const propertyIds = (first(params['propertyIds']) ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  const calendar = await fetchGroupCalendar({
    ...(startDate === undefined ? {} : { startDate }),
    ...(endDate === undefined ? {} : { endDate }),
    ...(propertyIds.length === 0 ? {} : { propertyIds }),
    cookieHeader: await requireCookieHeader(),
  });

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
      <GroupCalendarHeader calendar={calendar} />
      <GroupKpiCards metrics={calendar.metrics} dateRange={calendar.dateRange} />
      <DailyOccupancyStrip dailyOccupancy={calendar.dailyOccupancy} />
      <PropertiesOverviewAccordion properties={calendar.properties} />
    </main>
  );
}
