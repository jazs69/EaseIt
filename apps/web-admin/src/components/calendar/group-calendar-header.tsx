'use client';

/**
 * Title, date stepper and property filter.
 *
 * ===========================================================================
 * Window and filter changes are pushed into the **URL**, not held in state.
 *
 * Each change is a different server query, so this is navigation rather than
 * local filtering. Routing it through the URL means a clerk can bookmark "next
 * week", the back button steps through their own history, and a refresh lands
 * on the same window.
 *
 * Date arithmetic is done on `YYYY-MM-DD` strings, never on a `Date`. The
 * obvious implementation — `d.setDate(d.getDate() - 7)` then
 * `toISOString().split('T')[0]` — reinterprets a local date through UTC, so
 * east of Greenwich it lands a day early (CLAUDE.md section 3.3). String
 * arithmetic through UTC midnight has no local component to misread.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import type { GroupCalendarResponse } from '@repo/types';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Funnel,
  Loader2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { formatLong, formatShort, shiftIsoDate } from '@/lib/calendar-format';

export interface GroupCalendarHeaderProps {
  calendar: GroupCalendarResponse;
}

export function GroupCalendarHeader({ calendar }: GroupCalendarHeaderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Keeps the current window on screen while the next one loads, rather than
  // blanking the page on every step.
  const [pending, startTransition] = useTransition();
  const [filterOpen, setFilterOpen] = useState(false);

  const { startDate, endDate, totalDays } = calendar.dateRange;

  const selectedIds = new Set(
    (searchParams.get('propertyIds') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

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
      router.push(`/group-calendar?${next.toString()}`, { scroll: false });
    });
  }

  /** Steps by the window's own length, so a 31-day view pages by 31 days. */
  function step(direction: -1 | 1): void {
    const nextStart = shiftIsoDate(startDate, direction * totalDays);
    navigate({
      startDate: nextStart,
      endDate: shiftIsoDate(nextStart, totalDays - 1),
    });
  }

  function toggleProperty(propertyId: string): void {
    const next = new Set(selectedIds);
    if (next.has(propertyId)) {
      next.delete(propertyId);
    } else {
      next.add(propertyId);
    }
    // An empty selection means "all", which is also the absent-parameter
    // meaning — so the key is removed rather than set to an empty string.
    navigate({ propertyIds: next.size === 0 ? null : [...next].join(',') });
  }

  const filterLabel =
    selectedIds.size === 0
      ? 'All selected'
      : `${String(selectedIds.size)} of ${String(calendar.properties.length)}`;

  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Group reservation calendar
        </h1>
        <p className="text-sm text-zinc-400">
          Inventory from {formatLong(startDate)} to {formatLong(endDate)}
          <span className="ml-2 text-xs text-zinc-600">
            {calendar.reference.timezone}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pending ? (
          <Loader2 className="size-4 animate-spin text-blue-400" aria-hidden="true" />
        ) : null}

        {/* Stepper */}
        <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900/60 p-0.5">
          <button
            type="button"
            onClick={() => {
              step(-1);
            }}
            aria-label={`Previous ${String(totalDays)} days`}
            className="grid size-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>

          <span className="tabular flex items-center gap-1.5 px-2 text-xs font-medium text-white">
            <CalendarDays className="size-3.5 text-zinc-500" aria-hidden="true" />
            {formatShort(startDate)} &ndash; {formatShort(endDate)}
          </span>

          <button
            type="button"
            onClick={() => {
              step(1);
            }}
            aria-label={`Next ${String(totalDays)} days`}
            className="grid size-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* Explicit start date, for jumping further than a step */}
        <label className="relative inline-flex items-center">
          <input
            type="date"
            value={startDate}
            onChange={(event) => {
              if (event.target.value.length === 0) return;
              navigate({
                startDate: event.target.value,
                endDate: shiftIsoDate(event.target.value, totalDays - 1),
              });
            }}
            aria-label="Window start date"
            className="tabular rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </label>

        {/* Snaps to the reference property's own business date, not the
            browser's idea of today. */}
        <button
          type="button"
          onClick={() => {
            navigate({ startDate: null, endDate: null });
          }}
          title={`Jump to ${calendar.reference.businessDate} (${calendar.reference.timezone})`}
          className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-white/25 hover:text-white"
        >
          Today
        </button>

        {/* Property filter */}
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
              {/* Click-away. A transparent sibling rather than a document
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
                {calendar.properties.map((property) => {
                  const checked = selectedIds.size === 0 || selectedIds.has(property.propertyId);
                  return (
                    <label
                      key={property.propertyId}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/[0.04]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          toggleProperty(property.propertyId);
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
                        {property.propertyName}
                      </span>
                      {!property.hasInventory ? (
                        <span className="shrink-0 text-[9px] text-amber-400/70">no rooms</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
