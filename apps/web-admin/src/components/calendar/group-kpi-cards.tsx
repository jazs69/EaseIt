import type { GroupCalendarResponse } from '@repo/types';
import { Building, Percent, TrendingDown, TrendingUp } from 'lucide-react';

import { formatShort } from '@/lib/calendar-format';

/**
 * The three window-level figures.
 *
 * A server component: nothing here is interactive, so there is no reason to
 * ship it to the browser.
 */
export interface GroupKpiCardsProps {
  metrics: GroupCalendarResponse['metrics'];
  dateRange: GroupCalendarResponse['dateRange'];
}

export function GroupKpiCards({ metrics, dateRange }: GroupKpiCardsProps) {
  // Zero is neither up nor down, so it gets the neutral treatment rather than
  // an arrow implying a direction it does not have.
  const trendUp = metrics.occupancyTrend > 0;
  const flat = metrics.occupancyTrend === 0;
  const TrendIcon = trendUp ? TrendingUp : TrendingDown;

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <article className="flex flex-col gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <span className="flex items-center gap-1.5 text-sm text-zinc-400">
          <Percent className="size-3.5 text-zinc-600" aria-hidden="true" />
          Average occupancy
        </span>
        <span className="tabular text-3xl font-bold text-white">
          {metrics.averageOccupancy}%
        </span>
        {flat ? (
          <span className="text-xs text-zinc-400">Level with the first day</span>
        ) : (
          <span
            className={`flex items-center gap-1 text-xs ${
              trendUp ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            <TrendIcon className="size-3" aria-hidden="true" />
            {metrics.occupancyTrend > 0 ? '+' : ''}
            {metrics.occupancyTrend}% vs first day
          </span>
        )}
      </article>

      <article className="flex flex-col gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <span className="flex items-center gap-1.5 text-sm text-zinc-400">
          <Building className="size-3.5 text-zinc-600" aria-hidden="true" />
          Properties
        </span>
        <span className="tabular text-3xl font-bold text-white">
          {metrics.propertiesCount}
        </span>
        {/* Honest about the difference: "showing data" is misleading when most
            of the portfolio has no room types configured yet. */}
        <span className="text-xs text-zinc-400">
          {metrics.propertiesWithInventoryCount === metrics.propertiesCount
            ? 'Showing data'
            : `${String(metrics.propertiesWithInventoryCount)} with inventory set up`}
        </span>
      </article>

      <article className="flex flex-col gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <span className="text-sm text-zinc-400">Date range</span>
        <span className="tabular text-3xl font-bold text-white">
          {formatShort(dateRange.startDate)} &ndash; {formatShort(dateRange.endDate)}
        </span>
        <span className="text-xs text-zinc-400">
          {dateRange.totalDays} day{dateRange.totalDays === 1 ? '' : 's'}
        </span>
      </article>
    </div>
  );
}
