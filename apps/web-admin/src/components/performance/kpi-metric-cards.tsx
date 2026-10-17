/**
 * The four headline measures.
 *
 * ===========================================================================
 * A server component. Nothing here is interactive, so none of it ships to the
 * browser.
 *
 * Each card carries the same hue the chart uses for that measure, so switching
 * the chart's metric never changes what a colour means. Per the visualisation
 * method, the chip carries identity and the number stays in ink — a revenue
 * figure printed in blue is harder to read and says nothing the chip hasn't.
 *
 * Occupancy's delta is in **percentage points**, not percent: 12% to 18% is
 * +6 points, and calling it "+50%" is the other true statement that nobody
 * means. ADR, RevPAR and revenue are genuine percent changes.
 * ===========================================================================
 */

import type { GroupPerformance } from '@repo/types';
import { BedDouble, IndianRupee, Percent, TrendingDown, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { formatMoney, formatMoneyRounded } from '@/lib/money';

/** Same hues as the chart, one per measure. */
const METRIC_COLOUR = {
  revenue: '#3987e5',
  occupancy: '#199e70',
  adr: '#c98500',
  revpar: '#d55181',
} as const;

interface CardProps {
  label: string;
  value: string;
  colour: string;
  icon: LucideIcon;
  /** Signed change against the same period last year. Null = nothing to say. */
  delta: number | null;
  /** `%` for a percent change, ` pts` for an occupancy-point change. */
  deltaUnit: string;
  /** Shown instead of a delta: the sub-measure the number came from. */
  footnote: string;
  compared: boolean;
}

function MetricCard({
  label,
  value,
  colour,
  icon: Icon,
  delta,
  deltaUnit,
  footnote,
  compared,
}: CardProps) {
  // Zero is neither up nor down, so it gets no arrow.
  const up = delta !== null && delta > 0;
  const flat = delta === 0;
  const TrendIcon = up ? TrendingUp : TrendingDown;

  return (
    <article className="flex flex-col gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <span className="flex items-center gap-1.5 text-sm text-zinc-400">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: colour }}
        />
        <Icon className="size-3.5 text-zinc-600" aria-hidden="true" />
        {label}
      </span>

      <span className="tabular text-3xl font-bold text-white">{value}</span>

      {compared && delta !== null ? (
        <span
          className={
            flat
              ? 'flex items-center gap-1 text-xs text-zinc-400'
              : up
                ? 'flex items-center gap-1 text-xs text-emerald-400'
                : 'flex items-center gap-1 text-xs text-rose-400'
          }
        >
          {flat ? null : <TrendIcon className="size-3" aria-hidden="true" />}
          {up ? '+' : ''}
          {delta.toFixed(1)}
          {deltaUnit} vs last year
        </span>
      ) : compared ? (
        // A prior period with nothing in it. "+∞%" and "+100%" are both lies;
        // saying there was no base is the only honest option.
        <span className="text-xs text-zinc-500">No prior-year base</span>
      ) : (
        <span className="text-xs text-zinc-400">{footnote}</span>
      )}
    </article>
  );
}

export interface KpiMetricCardsProps {
  performance: GroupPerformance;
}

export function KpiMetricCards({ performance }: KpiMetricCardsProps) {
  const { metrics, currency, lastYearComparison } = performance;
  const compared = lastYearComparison !== null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Total revenue"
        value={formatMoneyRounded(metrics.totalRevenueMinor, currency)}
        colour={METRIC_COLOUR.revenue}
        icon={IndianRupee}
        delta={lastYearComparison?.revenueGrowthPercent ?? null}
        deltaUnit="%"
        footnote={`${String(metrics.roomNightsSold)} room-nights sold`}
        compared={compared}
      />

      <MetricCard
        label="Occupancy"
        value={`${String(metrics.avgOccupancy)}%`}
        colour={METRIC_COLOUR.occupancy}
        icon={Percent}
        delta={lastYearComparison?.occupancyDeltaPoints ?? null}
        deltaUnit=" pts"
        footnote={`of ${String(metrics.roomNightsAvailable)} room-nights available`}
        compared={compared}
      />

      <MetricCard
        label="ADR"
        // Null, not zero: an ADR of zero claims we sold rooms and charged
        // nothing for them. Nothing sold has no average rate at all.
        value={metrics.adrMinor === null ? '—' : formatMoney(metrics.adrMinor, currency)}
        colour={METRIC_COLOUR.adr}
        icon={BedDouble}
        delta={lastYearComparison?.adrGrowthPercent ?? null}
        deltaUnit="%"
        footnote="Revenue per room-night sold"
        compared={compared}
      />

      <MetricCard
        label="RevPAR"
        value={formatMoney(metrics.revParMinor, currency)}
        colour={METRIC_COLOUR.revpar}
        icon={BedDouble}
        delta={lastYearComparison?.revParGrowthPercent ?? null}
        deltaUnit="%"
        footnote="Revenue per available room-night"
        compared={compared}
      />
    </div>
  );
}
