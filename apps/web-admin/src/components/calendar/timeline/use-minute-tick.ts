'use client';

/**
 * A clock that ticks once a minute, shared by every subscriber.
 *
 * ===========================================================================
 * An external store rather than `useEffect` + `setInterval` + `setState`.
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. **One timer, not one per component.** A module-level interval is
 *      started by the first subscriber and cleared by the last. Ten markers
 *      on a page share one timer instead of ten drifting ones.
 *   2. **No hydration mismatch.** `getServerSnapshot` returns null, so the
 *      server renders no time at all and the client fills it in after
 *      hydrating. Reading `Date.now()` during render would produce different
 *      HTML on each side and a hydration error.
 *   3. **It satisfies the react-hooks rule.** Calling `setState` in an effect
 *      *body* is the cascading render the lint rule rejects — and it has
 *      already failed this repo's lint twice. Subscribing to an external
 *      system is the documented alternative, and this is literally that.
 *
 * The snapshot is floored to the minute so it only changes when the displayed
 * value would, rather than re-rendering every subscriber on every tick of a
 * millisecond clock.
 * ===========================================================================
 */

import { useSyncExternalStore } from 'react';

const MINUTE_MS = 60_000;

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  if (timer === null) {
    timer = setInterval(() => {
      const next = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
      // Guarded, so a tick that lands inside the same minute (clock drift, a
      // tab waking from sleep) does not re-render every subscriber for nothing.
      if (next === snapshot) return;
      snapshot = next;
      for (const notify of listeners) notify();
    }, MINUTE_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return snapshot;
}

/** Null on the server, so nothing time-dependent is rendered before hydration. */
function getServerSnapshot(): number | null {
  return null;
}

/**
 * Epoch milliseconds, floored to the minute. Null until hydrated.
 *
 * Callers must handle null by rendering nothing — that is the server pass, and
 * also the first client render before `useSyncExternalStore` swaps in the real
 * value.
 */
export function useMinuteTick(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Minutes past midnight at `timeZone` for a given instant.
 *
 * Resolved through `Intl` in the *property's* zone, never the viewer's. A front
 * desk in Asia/Kolkata and an owner viewing from London must see the marker on
 * the same place on the grid, because it marks the hotel's working day — not
 * the observer's (CLAUDE.md section 3.3).
 *
 * `hourCycle: 'h23'` matters: without it some locales render midnight as hour
 * 24, which would push the marker a full day off the end of the grid.
 */
export function minutesPastMidnightAt(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

  if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
  return Math.max(0, Math.min(hour * 60 + minute, 1439));
}
