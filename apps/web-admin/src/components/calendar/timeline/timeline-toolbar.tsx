'use client';

/**
 * Date stepping, filters, room grouping and the timeframe switcher.
 *
 * Every control writes to the **URL**, because each one changes what the server
 * must return — a different window, a different axis, a different room set.
 * Holding any of it in component state would mean a bookmarked calendar opens
 * on the wrong week and the back button does nothing.
 *
 * Stepping follows the timeframe: `>` advances by exactly one screenful, so a
 * month view pages by a month and the Day view by a day.
 */

import { cn } from '@repo/ui';
import {
  TIMEFRAME_DAYS,
  TIMEFRAME_LABELS,
  timelineTimeframeSchema,
  type TimelineCalendar,
  type TimelineTimeframe,
} from '@repo/types';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Funnel,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { formatShort, shiftIsoDate } from '@/lib/calendar-format';
import { CreateMenu, type BookingModal } from './create-menu';

const TIMEFRAMES = timelineTimeframeSchema.options;

export interface TimelineToolbarProps {
  calendar: TimelineCalendar;
  hotelId: string;
  onOpenModal: (modal: BookingModal) => void;
  onOpenUnassigned: () => void;
}

export function TimelineToolbar({
  calendar,
  hotelId,
  onOpenModal,
  onOpenUnassigned,
}: TimelineToolbarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const startDate = calendar.windowStart;
  const stride = TIMEFRAME_DAYS[calendar.timeframe];

  // Whole days between the ledger position and the calendar. Both are plain
  // `YYYY-MM-DD`, so this never goes through a local-time Date (section 3.3).
  const auditDaysBehind = Math.max(
    0,
    Math.round(
      (Date.parse(`${calendar.property.today}T00:00:00Z`) -
        Date.parse(`${calendar.property.businessDate}T00:00:00Z`)) /
        86_400_000,
    ),
  );

  function navigate(changes: Record<string, string | null>): void {
    const next = new URLSearchParams(searchParams.toString());
    next.set('hotelId', hotelId);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    startTransition(() => {
      router.push(`/calendar?${next.toString()}`, { scroll: false });
    });
  }

  const activeFilterCount =
    (searchParams.get('roomTypeId') === null ? 0 : 1) +
    (searchParams.get('floor') === null ? 0 : 1) +
    (searchParams.get('housekeeping') === null ||
    searchParams.get('housekeeping') === 'all'
      ? 0
      : 1);

  return (
    // `shrink-0`: the toolbar is layer 2 of the pinned header block and must
    // keep its height when the grid below it is competing for space.
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {/* Date stepping */}
      <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900/60 p-0.5">
        <button
          type="button"
          onClick={() => {
            navigate({ startDate: shiftIsoDate(startDate, -stride) });
          }}
          aria-label={`Previous ${String(stride)} day${stride === 1 ? '' : 's'}`}
          className="grid size-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <label className="relative inline-flex items-center">
          <CalendarDays
            className="pointer-events-none absolute left-2 size-3.5 text-zinc-500"
            aria-hidden="true"
          />
          <input
            type="date"
            value={startDate}
            onChange={(event) => {
              if (event.target.value.length > 0) navigate({ startDate: event.target.value });
            }}
            aria-label="First day shown"
            className="tabular rounded-md bg-transparent py-1 pr-1 pl-7 text-xs font-medium text-white focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            navigate({ startDate: shiftIsoDate(startDate, stride) });
          }}
          aria-label={`Next ${String(stride)} day${stride === 1 ? '' : 's'}`}
          className="grid size-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => {
          navigate({ startDate: null });
        }}
        title={`Jump to ${calendar.property.today} (${calendar.property.timezone})`}
        className="rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-white/25"
      >
        Today
      </button>

      {/*
        The books are behind the calendar.

        `businessDate` only moves when night audit step 7 runs, so a gap here
        means an audit did not. That is worth a line on the busiest screen in
        the building: the grid is showing the clerk today, while every charge
        posted today lands on an older date, and nobody should have to work
        that out from a folio. Silent when the two agree, which is the normal
        state.
      */}
      {auditDaysBehind > 0 ? (
        <span
          title={`Night audit has not run since ${calendar.property.businessDate}. Charges post to that date until it does.`}
          className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-200"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Books on {formatShort(calendar.property.businessDate)}
          <span className="text-amber-200/60">
            · audit {auditDaysBehind} day{auditDaysBehind === 1 ? '' : 's'} behind
          </span>
        </span>
      ) : null}

      {/* Filters */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setFiltersOpen((open) => !open);
          }}
          aria-expanded={filtersOpen}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
            activeFilterCount > 0
              ? 'border-blue-400/40 bg-blue-500/[0.12] text-blue-200'
              : 'border-white/10 bg-zinc-900/60 text-zinc-200 hover:border-white/25',
          )}
        >
          <Funnel className="size-3.5" aria-hidden="true" />
          Filters: {activeFilterCount === 0 ? 'All' : String(activeFilterCount)}
        </button>

        {filtersOpen ? (
          <>
            <button
              type="button"
              aria-label="Close filters"
              onClick={() => {
                setFiltersOpen(false);
              }}
              className="fixed inset-0 z-30 cursor-default"
            />
            <div className="absolute left-0 z-40 mt-1.5 w-60 rounded-xl border border-white/[0.1] bg-[#0e0e10] p-2 shadow-2xl">
              <FilterSelect
                label="Room category"
                value={searchParams.get('roomTypeId') ?? ''}
                options={[
                  { value: '', label: 'All categories' },
                  ...calendar.categories.map((category) => ({
                    value: category.id,
                    label: category.name,
                  })),
                ]}
                onChange={(value) => {
                  navigate({ roomTypeId: value === '' ? null : value });
                }}
              />
              <FilterSelect
                label="Floor"
                value={searchParams.get('floor') ?? ''}
                options={[
                  { value: '', label: 'All floors' },
                  ...calendar.availableFloors.map((floor) => ({
                    value: floor,
                    label: `Floor ${floor}`,
                  })),
                ]}
                onChange={(value) => {
                  navigate({ floor: value === '' ? null : value });
                }}
              />
              <FilterSelect
                label="Condition"
                value={searchParams.get('housekeeping') ?? 'all'}
                options={[
                  { value: 'all', label: 'Any condition' },
                  { value: 'clean', label: 'Clean or inspected' },
                  { value: 'dirty', label: 'Needs cleaning' },
                  { value: 'blocked', label: 'Out of service or order' },
                ]}
                onChange={(value) => {
                  navigate({ housekeeping: value === 'all' ? null : value });
                }}
              />
              {activeFilterCount > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    navigate({ roomTypeId: null, floor: null, housekeeping: null });
                  }}
                  className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-white/[0.05] hover:text-white"
                >
                  Clear all filters
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {/* Room grouping */}
      <div
        role="group"
        aria-label="Room grouping"
        className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900/60 p-0.5"
      >
        {(['flat', 'by-category'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={calendar.viewMode === mode}
            onClick={() => {
              navigate({ viewMode: mode });
            }}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
              calendar.viewMode === mode
                ? 'bg-white/[0.1] text-white'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            {mode === 'flat' ? 'Full view' : 'Roomtype view'}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {pending ? (
          <Loader2 className="size-4 animate-spin text-blue-400" aria-hidden="true" />
        ) : null}

        <UnassignedButton count={calendar.unassignedCount} onOpen={onOpenUnassigned} />

        <CreateMenu onOpenModal={onOpenModal} />

        {/* Timeframe */}
        <div
          role="group"
          aria-label="Timeframe"
          className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900/60 p-0.5"
        >
          {TIMEFRAMES.map((timeframe: TimelineTimeframe) => (
            <button
              key={timeframe}
              type="button"
              aria-pressed={calendar.timeframe === timeframe}
              onClick={() => {
                navigate({ timeframe });
              }}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                calendar.timeframe === timeframe
                  ? 'bg-white/[0.1] text-white'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {TIMEFRAME_LABELS[timeframe]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="mb-1 flex flex-col gap-1 px-1">
      <span className="text-[9px] font-semibold tracking-wider text-zinc-600 uppercase">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-white focus:border-blue-500 focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-zinc-900">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The `UA (n)` drawer trigger.
 *
 * Zero is shown too: "UA (0)" is the reassuring state, and hiding the pill
 * when the count is zero would make its absence ambiguous — a clerk cannot
 * tell "nothing unassigned" from "the badge is broken". It stays a button at
 * zero as well, so the control does not move or change shape as bookings come
 * and go; it just opens onto an empty list that explains itself.
 */
function UnassignedButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      title={
        count === 0
          ? 'Every booking in this window has a room'
          : `${String(count)} booking(s) in this window have no room assigned`
      }
      className={cn(
        'relative inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
        count > 0
          ? 'border-amber-400/40 bg-amber-500/[0.12] text-amber-200 hover:bg-amber-500/[0.2]'
          : 'border-white/[0.1] bg-zinc-900/80 text-zinc-400 hover:border-white/25 hover:text-zinc-200',
      )}
    >
      {count > 0 ? (
        <>
          <TriangleAlert className="size-3" aria-hidden="true" />
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-500"
          />
        </>
      ) : null}
      UA ({count})
    </button>
  );
}
