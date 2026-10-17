/**
 * Best and weakest property in the window, by revenue.
 *
 * ===========================================================================
 * Ranked on revenue, and the card says so.
 *
 * "Top performing" is ambiguous on its own — the highest-revenue hotel is
 * often not the one with the best RevPAR, and a 200-room property will
 * out-earn a 20-room one while performing worse per room. The measure is named
 * on the card so nobody reads it as a judgement it isn't, and RevPAR sits
 * beside it as the comparable figure.
 *
 * With one property in scope, top and low are necessarily the same hotel. The
 * API flags that rather than leaving the UI to show one property as both the
 * best and the worst and look broken.
 * ===========================================================================
 */

import type { PerformanceRank, PerformanceRankings } from '@repo/types';
import { Award, TrendingDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { formatMoney, formatMoneyRounded } from '@/lib/money';

interface RankCardProps {
  title: string;
  icon: LucideIcon;
  /** Border and icon tint. Status-adjacent, so it is not a series hue. */
  tone: 'positive' | 'negative';
  rank: PerformanceRank | null;
}

function RankCard({ title, icon: Icon, tone, rank }: RankCardProps) {
  const accent =
    tone === 'positive'
      ? 'border-emerald-400/20 bg-emerald-500/[0.04]'
      : 'border-amber-400/20 bg-amber-500/[0.04]';
  const iconTint = tone === 'positive' ? 'text-emerald-400' : 'text-amber-400';

  return (
    <article className={`flex flex-col gap-3 rounded-xl border p-4 ${accent}`}>
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm text-zinc-300">
          <Icon className={`size-3.5 ${iconTint}`} aria-hidden="true" />
          {title}
        </span>
        <span className="text-[10px] tracking-wider text-zinc-600 uppercase">by revenue</span>
      </header>

      {rank === null ? (
        <p className="text-sm text-zinc-500">No property recorded revenue in this period.</p>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <p className="truncate text-base font-semibold text-white">{rank.name}</p>
            <p className="tabular text-[11px] text-zinc-500">{rank.propertyCode}</p>
          </div>

          <dl className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-0.5">
              <dt className="text-[10px] tracking-wider text-zinc-600 uppercase">Revenue</dt>
              <dd className="tabular text-sm font-semibold text-white">
                {formatMoneyRounded(rank.revenueMinor, rank.currency)}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[10px] tracking-wider text-zinc-600 uppercase">Occupancy</dt>
              <dd className="tabular text-sm font-semibold text-white">{rank.occupancy}%</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[10px] tracking-wider text-zinc-600 uppercase">RevPAR</dt>
              <dd className="tabular text-sm font-semibold text-white">
                {formatMoney(rank.revParMinor, rank.currency)}
              </dd>
            </div>
          </dl>
        </>
      )}
    </article>
  );
}

export interface TopLowRankingsProps {
  rankings: PerformanceRankings;
}

export function TopLowRankings({ rankings }: TopLowRankingsProps) {
  // Nothing earned anywhere. Checked before the single-property case, because
  // two cards both reading "no revenue" is a worse way to say it once.
  if (rankings.topPerforming === null && rankings.lowPerforming === null) {
    return (
      <article className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <p className="text-sm text-zinc-500">
          No property recorded revenue in this period, so there is nothing to rank.
        </p>
      </article>
    );
  }

  if (rankings.isSingleProperty) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <RankCard
          title="Property performance"
          icon={Award}
          tone="positive"
          rank={rankings.topPerforming}
        />
        <article className="flex items-center rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
          <p className="text-sm text-zinc-500">
            Only one property is in scope, so there is nothing to rank against. Widen the
            property filter to compare.
          </p>
        </article>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <RankCard
        title="Top performing"
        icon={Award}
        tone="positive"
        rank={rankings.topPerforming}
      />
      <RankCard
        title="Needs attention"
        icon={TrendingDown}
        tone="negative"
        rank={rankings.lowPerforming}
      />
    </div>
  );
}
