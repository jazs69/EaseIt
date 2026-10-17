'use client';

/**
 * The operations dashboard body: greeting, date picker, the eight KPI tabs,
 * the filter toolbar and the reservation feed.
 *
 * ===========================================================================
 * Metric and date changes are **URL state**, not component state.
 *
 * Each tab selects a different slice of the database — `ARRIVALS` and
 * `DEPARTURES` differ by which date column they match, `NEW_BOOKINGS` by
 * creation instant — so switching tabs is a new server query, not a filter
 * over data already in hand. Driving that through the URL means a clerk can
 * bookmark "departures today", the back button works through their own tab
 * history, and a refresh lands on the same view. Holding it in `useState`
 * would lose all three.
 *
 * The free-text search is the opposite case: it runs over the rows already
 * loaded, so it stays local and filters on every keystroke with no round trip.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  DASHBOARD_METRIC_LABELS,
  type DashboardMetric,
  type PropertyDashboard,
} from '@repo/types';
import { CalendarDays, Download, Funnel, Loader2, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import { ReservationCard } from './reservation-card';

/** Tab order and colour, matching the reference screen. */
const METRIC_ORDER: readonly DashboardMetric[] = [
  'NEW_BOOKINGS',
  'IN_HOUSE',
  'ARRIVALS',
  'DEPARTURES',
  'CANCELLATIONS',
  'ON_HOLD',
  'NO_SHOWS',
  'MAGIC_LINK',
];

const METRIC_TONE: Record<DashboardMetric, { idle: string; active: string; value: string }> = {
  NEW_BOOKINGS: {
    idle: 'border-blue-400/15 bg-blue-500/[0.07] hover:border-blue-400/35',
    active: 'border-blue-400 bg-blue-500/[0.16]',
    value: 'text-blue-200',
  },
  IN_HOUSE: {
    idle: 'border-emerald-400/15 bg-emerald-500/[0.07] hover:border-emerald-400/35',
    active: 'border-emerald-400 bg-emerald-500/[0.16]',
    value: 'text-emerald-200',
  },
  ARRIVALS: {
    idle: 'border-amber-400/15 bg-amber-500/[0.07] hover:border-amber-400/35',
    active: 'border-amber-400 bg-amber-500/[0.16]',
    value: 'text-amber-200',
  },
  DEPARTURES: {
    idle: 'border-sky-400/15 bg-sky-500/[0.07] hover:border-sky-400/35',
    active: 'border-sky-400 bg-sky-500/[0.16]',
    value: 'text-sky-200',
  },
  CANCELLATIONS: {
    idle: 'border-rose-400/15 bg-rose-500/[0.07] hover:border-rose-400/35',
    active: 'border-rose-400 bg-rose-500/[0.16]',
    value: 'text-rose-200',
  },
  ON_HOLD: {
    idle: 'border-slate-400/15 bg-slate-500/[0.07] hover:border-slate-400/35',
    active: 'border-slate-400 bg-slate-500/[0.16]',
    value: 'text-slate-200',
  },
  NO_SHOWS: {
    idle: 'border-zinc-400/15 bg-zinc-500/[0.07] hover:border-zinc-400/35',
    active: 'border-zinc-400 bg-zinc-500/[0.16]',
    value: 'text-zinc-200',
  },
  MAGIC_LINK: {
    idle: 'border-violet-400/15 bg-violet-500/[0.07] hover:border-violet-400/35',
    active: 'border-violet-400 bg-violet-500/[0.16]',
    value: 'text-violet-200',
  },
};

const METRIC_COUNT_KEY: Record<DashboardMetric, keyof PropertyDashboard['metrics']> = {
  NEW_BOOKINGS: 'newBookingsCount',
  IN_HOUSE: 'inHouseCount',
  ARRIVALS: 'arrivalsCount',
  DEPARTURES: 'departuresCount',
  CANCELLATIONS: 'cancellationsCount',
  ON_HOLD: 'onHoldCount',
  NO_SHOWS: 'noShowsCount',
  MAGIC_LINK: 'magicLinkCount',
};

/** `2026-10-16` -> `16 Oct 2026`. */
function formatLongDate(isoDate: string): string {
  const [year = '', month = '01', day = '01'] = isoDate.split('-');
  const monthName =
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      Number(month) - 1
    ] ?? month;
  return `${day} ${monthName} ${year}`;
}

/**
 * Greeting from the property's own wall clock.
 *
 * Takes the hour as an argument rather than reading `new Date()` so that the
 * caller decides which clock applies — a hotel in Asia/Kolkata should not be
 * greeted "good evening" because the browser is in London.
 */
function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export interface PropertyDashboardViewProps {
  dashboard: PropertyDashboard;
  /** Hour 0-23 at the property, resolved server-side from its timezone. */
  localHour: number;
}

export function PropertyDashboardView({ dashboard, localHour }: PropertyDashboardViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `useTransition` keeps the current rows on screen while the new slice
  // loads, instead of blanking the feed on every tab click.
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return dashboard.reservations;

    return dashboard.reservations.filter((reservation) =>
      [
        reservation.guestName,
        reservation.bookingCode,
        reservation.roomNumber,
        reservation.guestPhone,
        reservation.roomTypeName,
      ]
        .filter((field): field is string => field !== null)
        .some((field) => field.toLowerCase().includes(needle)),
    );
  }, [dashboard.reservations, search]);

  /** Pushes one changed parameter, preserving the rest. */
  function navigate(changes: Record<string, string>): void {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      next.set(key, value);
    }
    startTransition(() => {
      router.push(`/property-dashboard?${next.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Greeting and date */}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          {greetingFor(localHour)}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
          <span>Here is what is going on with your property on</span>
          <label className="relative inline-flex items-center">
            <CalendarDays
              className="pointer-events-none absolute left-2.5 size-3.5 text-zinc-500"
              aria-hidden="true"
            />
            <input
              type="date"
              value={dashboard.targetDate}
              onChange={(event) => {
                if (event.target.value.length > 0) navigate({ date: event.target.value });
              }}
              aria-label="Operational date"
              className="tabular rounded-lg border border-white/10 bg-zinc-900/60 py-1.5 pr-2 pl-8 text-xs font-medium text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </label>
          <span className="tabular text-xs text-zinc-600">
            {formatLongDate(dashboard.targetDate)}
            {dashboard.targetDate !== dashboard.property.businessDate ? (
              <span className="ml-1.5 rounded border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                business date {dashboard.property.businessDate}
              </span>
            ) : null}
          </span>
        </div>
      </header>

      {/* KPI tabs */}
      <div
        role="tablist"
        aria-label="Operational metrics"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"
      >
        {METRIC_ORDER.map((metric) => {
          const active = dashboard.activeMetric === metric;
          const tone = METRIC_TONE[metric];
          const count = dashboard.metrics[METRIC_COUNT_KEY[metric]];

          return (
            <button
              key={metric}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                navigate({ metric });
              }}
              className={cn(
                'flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors',
                active ? tone.active : tone.idle,
              )}
            >
              <span className="flex w-full items-center justify-between gap-1">
                <span className={cn('tabular text-xl font-bold', tone.value)}>{count}</span>
                {active ? (
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-current opacity-80"
                  />
                ) : null}
              </span>
              <span className="text-[11px] leading-tight font-medium text-zinc-300">
                {DASHBOARD_METRIC_LABELS[metric]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Search tags..."
            aria-label="Filter the loaded reservations by guest, room, booking code or category"
            className="w-56 rounded-lg border border-white/10 bg-zinc-900/60 py-2 pr-3 pl-9 text-xs text-white placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <button
          type="button"
          disabled
          title="Alternative sort orders arrive with the reporting module"
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400 opacity-70"
        >
          <Funnel className="size-3.5" aria-hidden="true" />
          Booking made on
        </button>

        <button
          type="button"
          disabled
          title="CSV export arrives with the reporting module"
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400 opacity-70"
        >
          <Download className="size-3.5" aria-hidden="true" />
          Download
        </button>

        <span className="tabular ml-auto flex items-center gap-2 text-xs text-zinc-500">
          {pending ? (
            <Loader2 className="size-3.5 animate-spin text-blue-400" aria-hidden="true" />
          ) : null}
          {visible.length} result{visible.length === 1 ? '' : 's'} found
        </span>
      </div>

      {/* Feed */}
      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/[0.1] px-6 py-14 text-center">
          <Search className="size-5 text-zinc-600" aria-hidden="true" />
          <p className="text-sm font-medium text-zinc-300">
            {dashboard.reservations.length === 0
              ? `No ${DASHBOARD_METRIC_LABELS[dashboard.activeMetric].toLowerCase()} on ${formatLongDate(dashboard.targetDate)}.`
              : 'No reservations match your search.'}
          </p>
          <p className="max-w-sm text-xs leading-relaxed text-zinc-600">
            {dashboard.reservations.length === 0
              ? 'Try another metric above, or pick a different date.'
              : 'Clear the search box to see the full list again.'}
          </p>
        </div>
      ) : (
        <ul className={cn('flex flex-col gap-2.5', pending && 'opacity-60')}>
          {visible.map((reservation) => (
            <ReservationCard key={reservation.id} reservation={reservation} />
          ))}
        </ul>
      )}
    </div>
  );
}
