import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { TimelineContainer } from '@/components/calendar/timeline/timeline-container';
import {
  fetchTimelineCalendar,
  parseIsoDate,
  parseTimeframe,
  parseViewMode,
} from '@/lib/properties-client';
import { requireCookieHeader } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Reservation calendar',
  description: 'Room by date reservation grid for one property.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Property timeline calendar, at `/calendar?hotelId=31336`.
 *
 * ===========================================================================
 * A server component in the `(property)` shell, rendered full-bleed.
 *
 * The grid is wide and data-dense, so fetching here means the first paint is
 * the real grid rather than a skeleton that reflows once it arrives. Window,
 * timeframe, filters and grouping all live in the URL — each is bookmarkable
 * and survives a refresh — and only the drawer selections are client state.
 *
 * Three things were deliberately removed from this page, and all three were
 * taking space from the thing the page is for:
 *
 *   * The group-calendar back-link. A property-level operational screen should
 *     not offer a route into a portfolio view; the property switcher in the
 *     top bar is the one sanctioned way out, and only for operators entitled
 *     to use it.
 *   * The property header — name, code, timezone, currency. All of it is in
 *     the top bar now, which is present on every property screen, so
 *     repeating it here cost a row and said nothing new.
 *   * The avg-rate / avg-occupancy / total-rooms rollup. Those are reporting
 *     figures on an operational screen: the front desk needs to see which
 *     rooms are free tonight, and the grid's own sticky footer answers that
 *     per column. Portfolio-level rates and occupancy live on
 *     `/group-performance`, computed against closed inventory counters rather
 *     than this window.
 *
 * `hotelId` is an untrusted lookup key. The API resolves it through the
 * caller's own `UserPropertyRole` rows, so a property belonging to somebody
 * else comes back not-found rather than as data (CLAUDE.md section 3.2).
 * ===========================================================================
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = first(params['hotelId']);

  if (hotelId === undefined || hotelId.trim().length === 0) {
    // Nothing to draw without a property. Back to the picker, since choosing
    // one is the operator's next action anyway.
    redirect('/group-dashboard');
  }

  const startDate = parseIsoDate(first(params['startDate']));
  const roomTypeId = first(params['roomTypeId']);
  const floor = first(params['floor']);
  const housekeeping = first(params['housekeeping']);

  const calendar = await fetchTimelineCalendar({
    hotelId,
    ...(startDate === undefined ? {} : { startDate }),
    timeframe: parseTimeframe(first(params['timeframe'])),
    viewMode: parseViewMode(first(params['viewMode'])),
    ...(roomTypeId === undefined ? {} : { roomTypeId }),
    ...(floor === undefined ? {} : { floor }),
    ...(housekeeping === undefined ? {} : { housekeeping }),
    cookieHeader: await requireCookieHeader(),
  });

  return (
    // `min-h-0 flex-1` rather than a natural height: this page fills the shell
    // exactly and never exceeds it, so the shell's own scrollbar stays idle and
    // the only thing that scrolls is the grid body below the pinned headers.
    <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-2 px-2 py-2 sm:px-3">
      <TimelineContainer calendar={calendar} hotelId={hotelId} />
    </main>
  );
}
