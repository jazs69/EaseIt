'use client';

/**
 * How far ahead this property can sell, and the control to push it further.
 *
 * ===========================================================================
 * This is the one genuinely truthful inventory control that exists: a night
 * with no `inventory_day` row cannot be booked at all, and until now the
 * window was whatever the seed wrote at seed time -- a fixed date that shrank
 * by a day every day.
 *
 * TWO HORIZONS, SHOWN SEPARATELY AND ON PURPOSE.
 * `lastConfiguredDate` is the furthest row that exists anywhere.
 * `fullyConfiguredThrough` is the last date before any room type's first hole.
 * They differ exactly when there is a gap, and only the second governs what
 * can be sold. Showing just the maximum would tell an operator they are
 * covered until March while a category silently refuses from tomorrow, so the
 * headline here is the *selling* horizon and the maximum is secondary.
 * ===========================================================================
 */

import { useState, useTransition } from 'react';
import { CalendarRange, AlertTriangle, Check } from 'lucide-react';

import type { InventoryHorizon } from '@repo/types';

import { extendInventoryHorizon } from '@/lib/properties-client';

interface Props {
  hotelId: string;
  horizon: InventoryHorizon;
  /** True when the signed-in user holds `property:settings`. */
  canExtend: boolean;
}

export function InventoryHorizonCard({ hotelId, horizon, canExtend }: Props) {
  const [current, setCurrent] = useState(horizon);
  const [throughDate, setThroughDate] = useState(current.maxExtendableThrough);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await extendInventoryHorizon(hotelId, throughDate);
          setCurrent((previous) => ({
            ...previous,
            lastConfiguredDate:
              previous.lastConfiguredDate !== null &&
              previous.lastConfiguredDate > result.throughDate
                ? previous.lastConfiguredDate
                : result.throughDate,
            fullyConfiguredThrough: result.fullyConfiguredThrough,
            gaps: [],
          }));
          setMessage({
            tone: 'ok',
            text:
              result.rowsCreated === 0
                ? `Already covered through ${result.throughDate}. Nothing to add.`
                : `Added ${String(result.rowsCreated)} night-categor${
                    result.rowsCreated === 1 ? 'y' : 'ies'
                  } through ${result.throughDate}. ` +
                  `${String(result.rowsSkipped)} already existed.`,
          });
        } catch (error) {
          // The API's typed body carries a readable message; anything else is
          // reported as-is rather than swallowed.
          setMessage({
            tone: 'error',
            text: error instanceof Error ? error.message : 'The calendar could not be extended.',
          });
        }
      })();
    });
  }

  const sellingThrough = current.fullyConfiguredThrough;
  const hasGaps = current.gaps.length > 0;

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <header className="mb-4 flex items-center gap-2">
        <CalendarRange className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">Availability calendar</h2>
      </header>

      <dl className="mb-4 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Sellable through</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {sellingThrough ?? <span className="text-destructive">not configured</span>}
          </dd>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {sellingThrough === null
              ? 'At least one room type has no inventory from today.'
              : `${String(current.daysRemaining)} day${current.daysRemaining === 1 ? '' : 's'} ahead`}
          </p>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Furthest row</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {current.lastConfiguredDate ?? '—'}
          </dd>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Not proof every earlier date exists
          </p>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Room types</dt>
          <dd className="text-lg font-semibold tabular-nums">{current.roomTypeCount}</dd>
          <p className="mt-0.5 text-xs text-muted-foreground">Each needs every date</p>
        </div>
      </dl>

      {hasGaps ? (
        <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3.5" aria-hidden />
            {current.gaps.length} room type
            {current.gaps.length === 1 ? '' : 's'} cannot sell every date
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {current.gaps.map((gap) => (
              <li key={gap.roomTypeId} className="tabular-nums">
                <span className="font-medium text-foreground">{gap.code}</span>{' '}
                {gap.configuredThrough === null
                  ? 'has no inventory from today'
                  : `stops at ${gap.configuredThrough}`}
                {gap.missingDates > 0 ? ` — ${String(gap.missingDates)} date(s) missing` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canExtend ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Extend through</span>
            <input
              type="date"
              value={throughDate}
              min={current.today}
              max={current.maxExtendableThrough}
              onChange={(event) => {
                setThroughDate(event.target.value);
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm tabular-nums"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={pending || throughDate.length === 0}
            className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending ? 'Extending…' : 'Extend calendar'}
          </button>
          <p className="text-xs text-muted-foreground">
            Safe to repeat — existing nights are never changed.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Extending the calendar needs the property-settings permission.
        </p>
      )}

      {message !== null ? (
        <p
          className={`mt-3 flex items-center gap-2 text-xs ${
            message.tone === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'
          }`}
          role="status"
        >
          {message.tone === 'ok' ? <Check className="size-3.5" aria-hidden /> : null}
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
