'use client';

/**
 * Title, timeframe switch, comparison toggle and property filter.
 *
 * ===========================================================================
 * Every control writes to the **URL**, not to local state.
 *
 * Each one changes the server query, so this is navigation rather than local
 * filtering: a GM can bookmark "YTD, compared, Goa properties only", the back
 * button steps through their own history, and a refresh lands on the same
 * figures. Holding it in `useState` would make all of that impossible and add
 * a loading flash to every click.
 *
 * The date field is `YYYY-MM-DD` throughout and never becomes a `Date`. The
 * obvious `new Date().toISOString().slice(0, 10)` reinterprets a local date
 * through UTC, which east of Greenwich yields yesterday after 05:30 — and an
 * off-by-one business date is exactly the bug CLAUDE.md section 3.3 is written
 * to prevent. "Today" here clears the parameter so the server resolves the
 * reference property's own business date instead.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  PERFORMANCE_TIMEFRAME_LABELS,
  performanceTimeframeSchema,
  type GroupPerformance,
  type GroupProperty,
} from '@repo/types';
import { Funnel, Loader2, TriangleAlert } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { formatLong } from '@/lib/calendar-format';

export interface PerformanceHeaderProps {
  performance: GroupPerformance;
  /**
   * Every property the caller holds a grant at — not just the ones in scope.
   *
   * Taken from the group list rather than from `propertyBreakdown`, which is
   * already narrowed by the filter: driving the filter off its own output
   * would make a selection impossible to widen again.
   */
  allProperties: readonly GroupProperty[];
}

export function PerformanceHeader({ performance, allProperties }: PerformanceHeaderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Keeps the current figures on screen while the next window loads.
  const [pending, startTransition] = useTransition();
  const [filterOpen, setFilterOpen] = useState(false);

  const selectedIds = new Set(
    (searchParams.get('propertyIds') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

  const compared = performance.lastYearComparison !== null;

  function navigate(changes: Record<string, string | null>): void {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    startTransition(() => {
      router.push(`/group-performance?${next.toString()}`, { scroll: false });
    });
  }

  function toggleProperty(propertyId: string): void {
    const next = new Set(selectedIds);
    if (next.has(propertyId)) {
      next.delete(propertyId);
    } else {
      next.add(propertyId);
    }
    // Empty means "all", which is also the absent-parameter meaning, so the
    // key is removed rather than set to an empty string.
    navigate({ propertyIds: next.size === 0 ? null : [...next].join(',') });
  }

  const filterLabel =
    selectedIds.size === 0
      ? 'All properties'
      : `${String(selectedIds.size)} of ${String(allProperties.length)}`;

  const periodLabel =
    performance.periodStart === performance.periodEnd
      ? formatLong(performance.periodStart)
      : `${formatLong(performance.periodStart)} – ${formatLong(performance.periodEnd)}`;

  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-white">Group performance</h1>
          <p className="text-sm text-zinc-400">
            {periodLabel}
            <span className="ml-2 text-xs text-zinc-600">
              {performance.propertiesWithDataCount} of {performance.propertiesCount}{' '}
              {performance.propertiesCount === 1 ? 'property' : 'properties'} with data
              {' · '}
              {performance.reference.timezone}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pending ? (
            <Loader2 className="size-4 animate-spin text-blue-400" aria-hidden="true" />
          ) : null}

          {/* Timeframe. A segmented control rather than a dropdown: three
              stops, and which one is active is the page's main context. */}
          <div
            role="group"
            aria-label="Timeframe"
            className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900/60 p-0.5"
          >
            {performanceTimeframeSchema.options.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={performance.timeframe === option}
                onClick={() => {
                  navigate({ timeframe: option });
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  performance.timeframe === option
                    ? 'bg-white/[0.1] text-white'
                    : 'text-zinc-400 hover:bg-white/[0.05] hover:text-white',
                )}
              >
                {PERFORMANCE_TIMEFRAME_LABELS[option]}
              </button>
            ))}
          </div>

          <label className="relative inline-flex items-center">
            <span className="sr-only">Period end date</span>
            <input
              type="date"
              value={performance.targetDate}
              onChange={(event) => {
                if (event.target.value.length === 0) return;
                navigate({ targetDate: event.target.value });
              }}
              className="tabular rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </label>

          <button
            type="button"
            onClick={() => {
              navigate({ targetDate: null });
            }}
            title={`Back to ${performance.reference.businessDate} (${performance.reference.timezone})`}
            className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-white/25 hover:text-white"
          >
            Today
          </button>

          {/* Comparison is off by default: it doubles the query's work, and
              most visits only want the current window. */}
          <button
            type="button"
            aria-pressed={compared}
            onClick={() => {
              navigate({ compareWithLastYear: compared ? null : 'true' });
            }}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              compared
                ? 'border-blue-400/40 bg-blue-500/[0.12] text-blue-200'
                : 'border-white/10 bg-zinc-900/60 text-zinc-200 hover:border-white/25',
            )}
          >
            Compare to last year
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setFilterOpen((open) => !open);
              }}
              aria-expanded={filterOpen}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                selectedIds.size > 0
                  ? 'border-blue-400/40 bg-blue-500/[0.12] text-blue-200'
                  : 'border-white/10 bg-zinc-900/60 text-zinc-200 hover:border-white/25',
              )}
            >
              <Funnel className="size-3.5" aria-hidden="true" />
              {filterLabel}
            </button>

            {filterOpen ? (
              <>
                {/* Click-away as a transparent sibling rather than a document
                    listener: no global handler to leak, and it cannot swallow
                    keyboard focus. */}
                <button
                  type="button"
                  aria-label="Close property filter"
                  onClick={() => {
                    setFilterOpen(false);
                  }}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div className="absolute right-0 z-20 mt-1.5 max-h-80 w-72 overflow-y-auto rounded-xl border border-white/[0.1] bg-[#0e0e10] p-1.5 shadow-2xl">
                  <button
                    type="button"
                    onClick={() => {
                      navigate({ propertyIds: null });
                    }}
                    className="mb-1 w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-white"
                  >
                    Select all properties
                  </button>
                  {allProperties.map((property) => {
                    const checked = selectedIds.size === 0 || selectedIds.has(property.id);
                    return (
                      <label
                        key={property.id}
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/[0.04]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            toggleProperty(property.id);
                          }}
                          className="peer sr-only"
                        />
                        <span
                          aria-hidden="true"
                          className="grid size-3.5 shrink-0 place-items-center rounded border border-white/15 bg-zinc-900/60 peer-checked:border-blue-500 peer-checked:bg-blue-500 peer-checked:[&>svg]:scale-100"
                        >
                          <svg
                            viewBox="0 0 12 12"
                            className="size-2.5 scale-0 text-white transition-transform"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            strokeLinecap="round"
                          >
                            <path d="M2.5 6.5 5 9l4.5-5.5" />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                          {property.name}
                        </span>
                        <span className="tabular shrink-0 text-[9px] text-zinc-600">
                          {property.currency}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Mixed currencies are reported, then flagged — never silently summed.
          Adding rupees to Sri Lankan rupees produces a number that looks fine
          and means nothing, so the totals say so out loud until exchange rates
          exist (CLAUDE.md section 3.4). */}
      {performance.hasMixedCurrencies ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-200/90">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            These properties do not share one currency. Revenue, ADR and RevPAR below are
            added as raw amounts and labelled {performance.currency} — they are not
            converted. Filter to a single currency for a figure you can trust.
          </span>
        </p>
      ) : null}
    </header>
  );
}
