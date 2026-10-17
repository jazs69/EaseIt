'use client';

/**
 * The global reservation omnibar.
 *
 * ===========================================================================
 * Hand-rolled rather than `cmdk`.
 *
 * The brief offered "cmdk or a custom floating popover". This is one listbox
 * with arrow-key navigation over at most ten rows; `cmdk` brings a filtering
 * engine we do not want — the server does the matching, including fields no
 * client-side filter could see, like a government ID the browser must never
 * receive. CLAUDE.md section 6.4 asks what the existing stack cannot do, and
 * the answer here is nothing.
 *
 * Three behaviours earn their complexity:
 *
 *   * **Debounced at 300ms, with cancellation.** Every superseded keystroke
 *     aborts its own request. Without that, typing "Malhotra" fires eight
 *     queries whose responses can arrive out of order, and the list ends up
 *     showing results for "Malhot".
 *   * **A request counter guards the state write.** AbortController alone is
 *     not enough: a response can already be in flight when the next keystroke
 *     fires, and `abort()` does not un-resolve a promise that has already
 *     settled. The sequence check is what actually prevents a stale list.
 *   * **Keyboard-first.** A front desk under pressure types, arrows and
 *     presses Enter. The mouse is the fallback, not the path.
 *
 * On highlighting: the server says which field matched and with what text, so
 * the UI never guesses. For a government ID it highlights nothing — the value
 * shown is masked, so there is no honest substring to mark.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  BOOKING_SOURCE_BUCKET,
  BOOKING_SOURCE_LABELS,
  MATCHED_FIELD_LABELS,
  ReservationStatus,
  type ReservationSearchHit,
} from '@repo/types';
import {
  CreditCard,
  DoorOpen,
  Globe,
  Loader2,
  Mail,
  Phone,
  Search,
  Ticket,
  User,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { formatMoneyRounded } from '@/lib/money';
import { searchReservations } from '@/lib/properties-client';

const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

/** The icon that leads the matched-key row, per match type. */
const MATCH_ICON: Record<ReservationSearchHit['matchedField'], LucideIcon> = {
  MATCHED_BY_BOOKING_CODE: Ticket,
  MATCHED_BY_OTA_ID: Globe,
  MATCHED_BY_ROOM: DoorOpen,
  MATCHED_BY_PHONE: Phone,
  MATCHED_BY_GOVT_ID: CreditCard,
  MATCHED_BY_EMAIL: Mail,
  MATCHED_BY_NAME: User,
};

/** Operational status colours. Checked-in is the "here now" state. */
function statusTone(status: ReservationSearchHit['status']): string {
  switch (status) {
    case ReservationStatus.CHECKED_IN:
      return 'border-emerald-400/30 bg-emerald-500/[0.12] text-emerald-300';
    case ReservationStatus.CONFIRMED:
      return 'border-amber-400/30 bg-amber-500/[0.12] text-amber-200';
    case ReservationStatus.CHECKED_OUT:
      return 'border-white/[0.12] bg-white/[0.05] text-zinc-400';
    case ReservationStatus.CANCELLED:
    case ReservationStatus.NO_SHOW:
      return 'border-rose-400/30 bg-rose-500/[0.1] text-rose-300';
    default:
      return 'border-white/[0.12] bg-white/[0.05] text-zinc-300';
  }
}

/** `2026-10-16` -> `Oct 16`. Parsed as UTC, never through local time. */
function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Marks the matched substring inside a value.
 *
 * Case-insensitive, first occurrence only. Returns the string untouched when
 * the query is not present — which is the normal case for a masked ID or a
 * name matched token-by-token, and must not throw or mangle the text.
 */
function Highlighted({ value, query }: { value: string; query: string }) {
  const at = value.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || query.length === 0) return <>{value}</>;

  return (
    <>
      {value.slice(0, at)}
      <mark className="rounded bg-blue-500/30 px-0.5 text-blue-100">
        {value.slice(at, at + query.length)}
      </mark>
      {value.slice(at + query.length)}
    </>
  );
}

export interface OmnibarSearchProps {
  /** Property code or uuid. Null disables the box — nothing to search. */
  hotelId: string | null;
}

export function OmnibarSearch({ hotelId }: OmnibarSearchProps) {
  const router = useRouter();
  const listId = useId();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly ReservationSearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic request id. Only the newest response may write state.
  const sequenceRef = useRef(0);

  /* -- Cmd/Ctrl+K ------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // `event.code`, not `event.key`: on a non-QWERTY layout `key` is
      // whatever letter that physical key produces, and the shortcut would
      // move around the keyboard.
      if (event.code !== 'KeyK' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  /* -- Debounced query -------------------------------------------------- */

  /**
   * Fires the request; writes no state synchronously.
   *
   * The spinner and the cleared list are set in `onQueryChange` instead —
   * `react-hooks/set-state-in-effect` is right to reject setting them here,
   * because an effect that sets state on every keystroke renders twice per
   * character. State belongs where the event is: the change handler knows the
   * query is too short, or that a request is about to start, without a render
   * pass in between. Everything this effect writes happens after an `await`,
   * which is a genuine asynchronous result rather than a cascade.
   */
  useEffect(() => {
    const trimmed = query.trim();
    if (hotelId === null || trimmed.length < MIN_QUERY) return;

    const controller = new AbortController();
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await searchReservations({
            hotelId,
            q: trimmed,
            limit: 10,
            signal: controller.signal,
          });
          // A response that is no longer the newest is discarded rather than
          // rendered. `abort()` cannot recall a promise that already settled.
          if (sequenceRef.current !== sequence) return;
          setHits(response.hits);
          setTruncated(response.truncated);
          setActiveIndex(0);
          setLoading(false);
        } catch (caught) {
          if (sequenceRef.current !== sequence) return;
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          // Surfaced, not swallowed (CLAUDE.md section 5). The clerk needs to
          // know the list is empty because the request failed, not because
          // there are no bookings.
          setError('Search is unavailable right now.');
          setHits([]);
          setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, hotelId]);

  /* -- Selection -------------------------------------------------------- */

  /**
   * One place where typing changes state.
   *
   * Short queries clear the list rather than leaving the previous result set
   * on screen under a new query — a list that disagrees with the box reads as
   * a stale cache. Long enough queries show the spinner immediately, before
   * the 300ms debounce has even elapsed, so the box acknowledges the keystroke
   * rather than sitting still for a third of a second.
   */
  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      setOpen(true);

      if (value.trim().length < MIN_QUERY) {
        setHits([]);
        setTruncated(false);
        setLoading(false);
        setError(null);
        setActiveIndex(0);
        return;
      }

      setLoading(true);
      setError(null);
    },
    [],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setActiveIndex(0);
    // The effect no longer resets this, so closing must: otherwise the
    // spinner outlives the panel it belonged to.
    setLoading(false);
    setError(null);
  }, []);

  /**
   * Opens the booking on the reservation calendar.
   *
   * Navigation rather than a drawer on whatever screen the clerk happens to be
   * on: the reservation drawer is driven by a timeline block, and the grid is
   * also where the next action — moving or extending the stay — happens. The
   * window is set to the arrival date so the booking is actually on screen,
   * and `focus` carries the reservation id, which is the same id the timeline
   * uses for its blocks.
   */
  const select = useCallback(
    (hit: ReservationSearchHit) => {
      if (hotelId === null) return;
      const params = new URLSearchParams({
        hotelId,
        startDate: hit.arrivalDate,
        focus: hit.id,
      });
      close();
      router.push(`/calendar?${params.toString()}`);
    },
    [hotelId, router, close],
  );

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      inputRef.current?.blur();
      return;
    }
    if (hits.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % hits.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[activeIndex];
      if (hit !== undefined) select(hit);
    }
  }

  const showPanel =
    open && (loading || hits.length > 0 || error !== null || query.trim().length >= MIN_QUERY);

  return (
    <div className="relative mx-auto hidden w-72 md:w-96 lg:block">
      <div
        className={cn(
          'relative flex items-center rounded-full',
          'border border-white/[0.08] bg-zinc-900/60',
          'transition-colors focus-within:border-blue-500/50',
        )}
      >
        <Search
          className="pointer-events-none absolute left-4 size-4 text-zinc-600"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={hotelId === null}
          value={query}
          placeholder="Search for reservation"
          aria-label="Search reservations by name, phone, booking code, OTA reference, ID or room"
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
          className="w-full rounded-full bg-transparent py-1.5 pr-20 pl-10 text-sm text-white placeholder:text-zinc-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />

        <span className="absolute right-3 flex items-center gap-1.5">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin text-blue-400" aria-hidden="true" />
          ) : null}
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                close();
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="grid size-4 place-items-center rounded text-zinc-500 transition-colors hover:text-white"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : (
            // The shortcut hint. `aria-hidden` because it is a visual
            // affordance, not information a screen-reader user needs read out
            // between the field and its results.
            <kbd
              aria-hidden="true"
              className="tabular rounded border border-white/[0.1] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-500"
            >
              Ctrl K
            </kbd>
          )}
        </span>
      </div>

      {showPanel ? (
        <>
          {/* Click-away. Transparent sibling, no document listener. */}
          <button
            type="button"
            aria-label="Close search"
            onClick={close}
            className="fixed inset-0 z-40 cursor-default"
          />

          <div
            className={cn(
              'absolute top-full left-0 z-50 mt-2 w-[26rem] overflow-hidden rounded-xl',
              'border border-white/10 bg-[#0c0f17] shadow-2xl backdrop-blur-xl',
            )}
          >
            <ul id={listId} role="listbox" aria-label="Reservation search results">
              {loading && hits.length === 0 ? (
                // Skeleton rows rather than a bare spinner: the panel keeps
                // its height, so the list does not jump when results land.
                <>
                  {[0, 1, 2].map((row) => (
                    <li key={row} className="border-b border-white/[0.05] px-3 py-2.5">
                      <div className="h-3 w-32 animate-pulse rounded bg-white/[0.07]" />
                      <div className="mt-2 h-2.5 w-44 animate-pulse rounded bg-white/[0.05]" />
                    </li>
                  ))}
                </>
              ) : error !== null ? (
                <li className="px-3 py-4 text-center text-xs text-rose-300">{error}</li>
              ) : hits.length === 0 ? (
                <li className="px-3 py-4 text-center text-xs text-zinc-500">
                  No reservation matches &ldquo;{query.trim()}&rdquo;. Try a phone number,
                  booking code, OTA reference or room.
                </li>
              ) : (
                hits.map((hit, index) => {
                  const MatchIcon = MATCH_ICON[hit.matchedField];
                  const sourceLabel =
                    BOOKING_SOURCE_LABELS[BOOKING_SOURCE_BUCKET[hit.source]];
                  const active = index === activeIndex;
                  // A masked ID has no honest substring to mark.
                  const highlightQuery =
                    hit.matchedField === 'MATCHED_BY_GOVT_ID' ? '' : query.trim();

                  return (
                    <li key={hit.id} role="option" aria-selected={active}>
                      <button
                        type="button"
                        onMouseEnter={() => {
                          setActiveIndex(index);
                        }}
                        onClick={() => {
                          select(hit);
                        }}
                        className={cn(
                          'flex w-full flex-col gap-1 border-b border-white/[0.05] px-3 py-2.5 text-left transition-colors last:border-b-0',
                          active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]',
                        )}
                      >
                        {/* Guest, status, source */}
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white">
                            <Highlighted value={hit.guestName} query={highlightQuery} />
                          </span>
                          <span
                            className={cn(
                              'shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide',
                              statusTone(hit.status),
                            )}
                          >
                            {hit.status.replace('_', '-')}
                          </span>
                          <span className="shrink-0 rounded border border-white/[0.1] bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">
                            {sourceLabel}
                          </span>
                        </span>

                        {/* Why it matched */}
                        <span className="flex items-center gap-1.5 text-[11px] text-zinc-300">
                          <MatchIcon
                            className="size-3 shrink-0 text-zinc-500"
                            aria-hidden="true"
                          />
                          <span className="shrink-0 text-zinc-600">
                            {MATCHED_FIELD_LABELS[hit.matchedField]}:
                          </span>
                          <span className="tabular min-w-0 truncate">
                            <Highlighted value={hit.matchedValue} query={highlightQuery} />
                          </span>
                        </span>

                        {/* Stay, category, money */}
                        <span className="flex items-center gap-2 text-[10px] text-zinc-500">
                          <span className="tabular shrink-0">
                            {shortDate(hit.arrivalDate)} &ndash; {shortDate(hit.departureDate)}
                          </span>
                          <span aria-hidden="true">&middot;</span>
                          <span className="min-w-0 flex-1 truncate">
                            {hit.roomNumber === null
                              ? `${hit.roomTypeName} · unassigned`
                              : `${hit.roomTypeName} · Room ${hit.roomNumber}`}
                          </span>
                          <span className="tabular shrink-0 font-semibold text-zinc-300">
                            {formatMoneyRounded(hit.totalAmountMinor, hit.currency)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>

            {truncated ? (
              <p className="border-t border-white/[0.06] px-3 py-1.5 text-[10px] text-zinc-600">
                Showing the first 10 matches. Narrow the search to see the rest.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
