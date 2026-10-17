import { OPERABLE_PROPERTY_STATUSES } from '@repo/types';
import type { Metadata } from 'next';

import { BookingSourcePerformance } from '@/components/performance/booking-source-performance';
import { KpiMetricCards } from '@/components/performance/kpi-metric-cards';
import { MonthlyPerformanceChart } from '@/components/performance/monthly-performance-chart';
import { PerformanceHeader } from '@/components/performance/performance-header';
import { PropertyPerformanceTable } from '@/components/performance/property-performance-table';
import { TopLowRankings } from '@/components/performance/top-low-rankings';
import { formatLong } from '@/lib/calendar-format';
import {
  fetchGroupPerformance,
  fetchMyGroup,
  parseIsoDate,
  parsePerformanceTimeframe,
} from '@/lib/properties-client';
import { requireCookieHeader } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Group performance',
  description: 'Revenue, occupancy, ADR and RevPAR across every property in your group.',
  robots: { index: false, follow: false },
};

// Per-user and per-window. Never statically rendered or cached.
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Group performance analytics.
 *
 * ===========================================================================
 * **These figures are live aggregates, not closed-day snapshots.**
 *
 * CLAUDE.md section 3.3 requires reported figures to agree with the closed
 * books by reading the night audit's immutable daily snapshots. That table
 * does not exist yet, so occupancy here is computed from `inventory_day` — the
 * same counters the oversell CHECK guards — and revenue from reservation
 * totals. The consequence is worth stating plainly: a day that has not yet
 * been closed by the night audit can still move, so today's row is provisional
 * in a way a snapshot would not be. Historical months are stable because their
 * reservations are settled.
 *
 * Occupancy deliberately uses historical `physical` counts rather than today's
 * room list. Counting current rooms would rewrite last March's occupancy every
 * time a room is added or taken out of order.
 *
 * Both requests are issued in parallel: the performance payload, and the group
 * list that populates the property filter. The filter needs every property the
 * caller can see, and the payload is already narrowed by the filter — deriving
 * the options from it would make a selection impossible to widen again.
 *
 * The group list is fetched with `status: 'ALL'` and then narrowed to the
 * operable statuses *here*, so the filter's options are exactly the set the
 * performance query scopes over. Taking the endpoint's default instead would
 * list only ACTIVE properties while the figures also include ONBOARDING ones —
 * a property in the breakdown that the filter could never select.
 * ===========================================================================
 */
export default async function GroupPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const timeframe = parsePerformanceTimeframe(first(params['timeframe']));
  const targetDate = parseIsoDate(first(params['targetDate']));
  const propertyIds = (first(params['propertyIds']) ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const compareWithLastYear = first(params['compareWithLastYear']) === 'true';

  const cookieHeader = await requireCookieHeader();

  const [performance, group] = await Promise.all([
    fetchGroupPerformance({
      timeframe,
      ...(targetDate === undefined ? {} : { targetDate }),
      ...(propertyIds.length === 0 ? {} : { propertyIds }),
      compareWithLastYear,
      cookieHeader,
    }),
    fetchMyGroup({ status: 'ALL', cookieHeader }),
  ]);

  const filterableProperties = group.properties.filter((property) =>
    OPERABLE_PROPERTY_STATUSES.includes(property.status),
  );

  const periodLabel =
    performance.periodStart === performance.periodEnd
      ? formatLong(performance.periodStart)
      : `${formatLong(performance.periodStart)} – ${formatLong(performance.periodEnd)}`;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
      <PerformanceHeader performance={performance} allProperties={filterableProperties} />
      <KpiMetricCards performance={performance} />
      <TopLowRankings rankings={performance.rankings} />
      {/* Side by side above 1280px: both answer "where did the money come
          from", one over time and one by channel, and they are read together.
          They stack below that, because a 110px label gutter plus eight bars
          does not survive being squeezed into half a tablet. */}
      <div className="grid gap-7 xl:grid-cols-2">
        <MonthlyPerformanceChart
          monthlyData={performance.monthlyData}
          currency={performance.currency}
        />
        {/* No props for timeframe or property: the payload is already scoped
            by both, so the widget cannot disagree with the cards above it. */}
        <BookingSourcePerformance
          bookingSources={performance.bookingSources}
          currency={performance.currency}
          periodLabel={periodLabel}
        />
      </div>
      <PropertyPerformanceTable
        rows={performance.propertyBreakdown}
        compared={performance.lastYearComparison !== null}
      />
    </main>
  );
}
