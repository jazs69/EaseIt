'use client';

/**
 * The date-wise rate calendar for one room type under one rate plan (F2).
 *
 * ===========================================================================
 * WHAT AN OPERATOR DOES HERE: pick a plan, pick a category, see 30/60/90
 * nights, click the ones to reprice, type one number, apply. Plus: change the
 * category's default, or clear a selection back to it.
 *
 * DEFAULT VERSUS OVERRIDE IS THE WHOLE POINT, so it is the loudest thing on
 * the screen. An overridden night is tinted and carries a dot; a default night
 * is plain. Without that distinction the grid is just a wall of numbers and an
 * operator cannot tell which prices they have actually set — which is the one
 * question they came to answer.
 *
 * NOTHING IS COMPUTED LOCALLY. `effectiveRateMinor` arrives from the server
 * for every date, including nights with no override, and the grid renders what
 * it is given. The client never re-derives a price: one effective-rate rule
 * exists and it lives in `rate-calendar.policy.ts` on the server, so a UI bug
 * cannot invent a price that disagrees with what F9 will later quote.
 *
 * DATES ARE STRINGS, `YYYY-MM-DD`, END TO END. They are never put through
 * `new Date()` for arithmetic or display, because a `@db.Date` night rendered
 * via a browser-local Date shifts by one day for anyone east or west of UTC —
 * the exact bug that makes a hotel sell 24 December at 23 December's price.
 * `shiftDate` and `window` below do their arithmetic at UTC noon, which cannot
 * cross a day boundary under any zone offset, and the label formatter is given
 * the parts explicitly.
 *
 * WRITES REDRAW FROM THE RESPONSE, never optimistically. Every write returns
 * the refreshed window and the grid is replaced with it, so what is on screen
 * is what the database holds.
 * ===========================================================================
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Info,
  Loader2,
  Pencil,
  RotateCw,
  X,
} from 'lucide-react';

import type {
  RateCalendarDay,
  RateCalendarResponse,
  RatePlanRoomTypeView,
  RatePlanView,
} from '@repo/types';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';

import { ApiRequestError } from '@/lib/api';
import {
  clearRateCalendar,
  fetchRateCalendar,
  updateRateCalendar,
  updateRatePlanRoomTypeRate,
} from '@/lib/properties-client';

const WINDOW_LENGTHS = [30, 60, 90] as const;
type WindowLength = (typeof WINDOW_LENGTHS)[number];

/* -------------------------------------------------------------------------- */
/*  Date helpers — string in, string out, never a local Date                   */
/* -------------------------------------------------------------------------- */

/**
 * `YYYY-MM-DD` shifted by whole days.
 *
 * Anchored at UTC **noon**, not midnight. Midnight plus a negative offset can
 * land on the previous day in some environments; noon has twelve hours of slack
 * either side and cannot cross a boundary for any real zone.
 */
function shiftDate(date: string, days: number): string {
  const anchor = new Date(`${date}T12:00:00.000Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** Today at the viewer's own location, as `YYYY-MM-DD`. */
function todayLocal(): string {
  // en-CA formats as YYYY-MM-DD, which is why it is used here and in
  // `currentDateInTimeZone` in packages/types.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** "Mon 22 Dec" from the date string, without constructing a local Date. */
function formatDayLabel(date: string): { weekday: string; day: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).formatToParts(new Date(`${date}T12:00:00.000Z`));

  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return { weekday: find('weekday'), day: find('day'), month: find('month') };
}

/**
 * A `YYYY-MM-DD` string as the branded calendar date the DTOs require.
 *
 * `businessDateSchema` brands its output so a bare string cannot be passed
 * where a validated stay date belongs — which is the point of the brand, and
 * why it has to be shed deliberately rather than by `as` scattered at four
 * call sites.
 *
 * SAFE because every string reaching this function comes from `shiftDate`,
 * `todayLocal` or a server response, all three of which produce exactly
 * `YYYY-MM-DD`; and because the server re-validates with the same schema
 * regardless, so a malformed value is refused with a field-named 400 rather
 * than trusted. The brand is a compile-time aid here, not the check.
 */
function asCalendarDate(date: string): RateCalendarDay['stayDate'] {
  return date as RateCalendarDay['stayDate'];
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

function formatMoney(amountMinor: number, currency: string): string {
  // Integer minor units in, formatted once for display. No arithmetic is done
  // on this value anywhere in the UI (CLAUDE.md section 3.4).
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

/** Field-keyed messages the API returned, if any. */
function issuesFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiRequestError)) return {};
  const issues = error.details?.['issues'];
  if (typeof issues !== 'object' || issues === null) return {};

  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(issues as Record<string, unknown>)) {
    if (typeof value === 'string') mapped[key] = value;
  }
  return mapped;
}

function firstMessage(error: unknown, fallback: string): string {
  const issues = issuesFrom(error);
  const first = Object.values(issues)[0];
  if (first !== undefined) return first;
  return error instanceof Error ? error.message : fallback;
}

/* -------------------------------------------------------------------------- */

interface Props {
  hotelId: string;
  /** Only plans that can be priced: active, not archived, with assignments. */
  plans: RatePlanView[];
  currency: string;
  /** True when the signed-in user holds `rates:manage`. */
  canManage: boolean;
  /** Reflects a changed default rate back into the plans list. */
  onPlanChanged: (plan: RatePlanView) => void;
  /**
   * F3: the operator asked to inspect the rule behind a date. The parent owns
   * the rules panel, so the request is handed upward rather than this
   * component growing a second rule editor.
   */
  onInspectRule: (ruleId: string) => void;
  /**
   * Bumped by the parent whenever a pricing rule changes, so the grid re-reads
   * rather than showing effective prices resolved against the old rules.
   */
  reloadKey: number;
  /** Which rate plan the parent currently has selected, if any. */
  selectedPlanId: string | null;
  onPlanSelected: (planId: string) => void;
}

export function RateCalendar({
  hotelId,
  plans,
  currency,
  canManage,
  onPlanChanged,
  onInspectRule,
  reloadKey,
  selectedPlanId,
  onPlanSelected,
}: Props) {
  const firstPlan = plans[0];

  // The plan is the parent's state, so the rules panel and the calendar are
  // always looking at the same plan. A local copy would let them drift.
  const planId = selectedPlanId ?? firstPlan?.id ?? '';
  const [roomTypeId, setRoomTypeId] = useState<string>(firstPlan?.roomTypes[0]?.roomTypeId ?? '');
  const [length, setLength] = useState<WindowLength>(30);
  const [fromDate, setFromDate] = useState<string>(() => todayLocal());

  const [calendar, setCalendar] = useState<RateCalendarResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [bulkRate, setBulkRate] = useState('');
  const [confirming, setConfirming] = useState<{ amountMinor: number; dates: string[] } | null>(
    null,
  );
  const [editingDefault, setEditingDefault] = useState(false);
  const [defaultDraft, setDefaultDraft] = useState('');

  const plan = plans.find((entry) => entry.id === planId) ?? null;
  const assignment: RatePlanRoomTypeView | null =
    plan?.roomTypes.find((entry) => entry.roomTypeId === roomTypeId) ?? null;

  const toDate = shiftDate(fromDate, length - 1);

  // Supersedes an in-flight read when the selection changes again, so a slow
  // earlier response cannot overwrite a newer one.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (next: { planId: string; roomTypeId: string; fromDate: string; toDate: string }) => {
      if (next.planId === '' || next.roomTypeId === '') {
        setCalendar(null);
        return;
      }

      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setLoading(true);
      setError(null);
      try {
        const response = await fetchRateCalendar(
          hotelId,
          next.planId,
          {
            roomTypeId: next.roomTypeId,
            fromDate: asCalendarDate(next.fromDate),
            toDate: asCalendarDate(next.toDate),
          },
          { signal: controller.signal },
        );
        setCalendar(response);
      } catch (cause) {
        // An abort is this component superseding itself, not a failure.
        if (controller.signal.aborted) return;
        setCalendar(null);
        setError(firstMessage(cause, 'The rate calendar could not be loaded.'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [hotelId],
  );

  /**
   * Loads the window when the selection changes, through a short timer.
   *
   * The timer is not decoration. Holding the next-window button fires a
   * selection change per click, and each would otherwise be a request whose
   * only purpose is to be superseded by the following one. 150 ms collapses a
   * burst of navigation into the one window the operator actually stopped on.
   *
   * It also keeps `setLoading` out of the effect's synchronous body, which is
   * what the cascading-render lint rule is about and which the sibling
   * `RatePlansScreen` handles the same way.
   */
  useEffect(() => {
    if (planId === '' || roomTypeId === '') return;

    const timer = setTimeout(() => {
      void load({ planId, roomTypeId, fromDate, toDate });
    }, 150);

    return () => {
      clearTimeout(timer);
    };
    // `reloadKey` is in the dependency list on purpose: when the parent
    // reports that a pricing rule changed, every matching night's effective
    // price has moved and the grid must re-resolve rather than keep showing
    // prices computed against the old rules.
  }, [planId, roomTypeId, fromDate, toDate, reloadKey, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  /** Keeps the room-type choice valid when the plan changes. */
  function choosePlan(nextPlanId: string): void {
    const next = plans.find((entry) => entry.id === nextPlanId) ?? null;
    onPlanSelected(nextPlanId);
    setRoomTypeId(next?.roomTypes[0]?.roomTypeId ?? '');
    setSelected(new Set());
    setNotice(null);
    setEditingDefault(false);
  }

  function chooseRoomType(nextRoomTypeId: string): void {
    setRoomTypeId(nextRoomTypeId);
    setSelected(new Set());
    setNotice(null);
    setEditingDefault(false);
  }

  function toggleDate(date: string): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  /** Absorbs a write's refreshed window and reports what happened. */
  function absorb(response: RateCalendarResponse, message: string): void {
    setCalendar((previous) => {
      // The write returns only the window it touched, which may be narrower
      // than what is on screen. Re-reading the visible window keeps the grid
      // whole rather than shrinking it to the edited span.
      if (previous === null) return response;
      const byDate = new Map(response.days.map((day) => [day.stayDate, day]));
      return {
        ...previous,
        days: previous.days.map((day) => byDate.get(day.stayDate) ?? day),
        overrideCount: previous.days.filter((day) => (byDate.get(day.stayDate) ?? day).hasOverride)
          .length,
      };
    });
    setSelected(new Set());
    setNotice(message);
  }

  function applyBulk(amountMinor: number, dates: string[]): void {
    setError(null);
    setNotice(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await updateRateCalendar(hotelId, planId, {
            roomTypeId,
            entries: dates.map((stayDate) => ({
              stayDate: asCalendarDate(stayDate),
              amountMinor,
            })),
          });
          absorb(
            result.calendar,
            `${result.datesWritten} night${result.datesWritten === 1 ? '' : 's'} set to ` +
              `${formatMoney(amountMinor, currency)} — ${result.created} new, ${result.updated} changed.`,
          );
          setBulkRate('');
        } catch (cause) {
          setError(firstMessage(cause, 'Those rates could not be saved.'));
        } finally {
          setConfirming(null);
        }
      })();
    });
  }

  function clearSelection(): void {
    const dates = [...selected];
    if (dates.length === 0) return;

    setError(null);
    setNotice(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await clearRateCalendar(hotelId, planId, {
            roomTypeId,
            stayDates: dates.map(asCalendarDate),
          });
          absorb(
            result.calendar,
            result.cleared === 0
              ? 'Those nights were already at the default rate.'
              : `${result.cleared} override${result.cleared === 1 ? '' : 's'} cleared — ` +
                  'those nights now use the default rate.',
          );
        } catch (cause) {
          setError(firstMessage(cause, 'Those overrides could not be cleared.'));
        }
      })();
    });
  }

  function saveDefault(): void {
    const major = Number(defaultDraft);
    if (defaultDraft.trim().length === 0 || !Number.isFinite(major)) {
      setError('Enter a default nightly rate.');
      return;
    }

    setError(null);
    setNotice(null);
    startTransition(() => {
      void (async () => {
        try {
          const saved = await updateRatePlanRoomTypeRate(hotelId, planId, roomTypeId, {
            defaultRate: { amountMinor: Math.round(major * 100), currency },
          });
          onPlanChanged(saved);
          setEditingDefault(false);
          setNotice(
            'Default rate updated. Dated prices were not changed — only nights without one.',
          );
          // Re-read, because every non-overridden night's effective rate just
          // moved and the grid must not keep showing the old figure.
          await load({ planId, roomTypeId, fromDate, toDate });
        } catch (cause) {
          setError(firstMessage(cause, 'The default rate could not be saved.'));
        }
      })();
    });
  }

  const busy = pending || loading;

  if (plans.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
            Rate calendar
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-xs text-muted-foreground">
          There are no active rate plans with room types assigned. Create one above, then its
          date-wise prices can be set here.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
          Rate calendar
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Nightly prices per date. A night with no dated price uses the room type&apos;s default.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* -- Selectors --------------------------------------------------- */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Rate plan</span>
            <select
              value={planId}
              onChange={(event) => {
                choosePlan(event.target.value);
              }}
              disabled={busy}
              className="h-9 min-w-44 rounded-md border border-input bg-background px-2 text-sm"
            >
              {plans.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} — {entry.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Room type</span>
            <select
              value={roomTypeId}
              onChange={(event) => {
                chooseRoomType(event.target.value);
              }}
              disabled={busy || plan === null}
              className="h-9 min-w-44 rounded-md border border-input bg-background px-2 text-sm"
            >
              {(plan?.roomTypes ?? []).map((entry) => (
                <option key={entry.roomTypeId} value={entry.roomTypeId}>
                  {entry.code} — {entry.name}
                </option>
              ))}
            </select>
          </label>

          {/* -- Default rate, editable in place -------------------------- */}
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Default nightly rate</span>
            {editingDefault ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={defaultDraft}
                  onChange={(event) => {
                    setDefaultDraft(event.target.value);
                  }}
                  disabled={pending}
                  aria-label="Default nightly rate"
                  className="h-9 w-28 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums"
                />
                <Button size="sm" onClick={saveDefault} disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Check className="size-3.5" aria-hidden />
                  )}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingDefault(false);
                  }}
                  disabled={pending}
                  aria-label="Cancel editing the default rate"
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
            ) : (
              <div className="flex h-9 items-center gap-2">
                <span className="text-base font-semibold tabular-nums">
                  {assignment === null
                    ? '—'
                    : formatMoney(assignment.defaultRate.amountMinor, currency)}
                </span>
                {canManage && assignment !== null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDefaultDraft(String(assignment.defaultRate.amountMinor / 100));
                      setEditingDefault(true);
                      setNotice(null);
                    }}
                    disabled={busy}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                    Change
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* -- Window navigation ------------------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFromDate((previous) => shiftDate(previous, -length));
                setSelected(new Set());
              }}
              disabled={busy}
              aria-label={`Back ${String(length)} days`}
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFromDate(todayLocal());
                setSelected(new Set());
              }}
              disabled={busy}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFromDate((previous) => shiftDate(previous, length));
                setSelected(new Set());
              }}
              disabled={busy}
              aria-label={`Forward ${String(length)} days`}
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </Button>

            <label className="ml-1 flex items-center gap-1.5 text-xs">
              <span className="sr-only">Window start</span>
              <input
                type="date"
                value={fromDate}
                onChange={(event) => {
                  if (event.target.value.length > 0) {
                    setFromDate(event.target.value);
                    setSelected(new Set());
                  }
                }}
                disabled={busy}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs tabular-nums"
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-input p-0.5">
              {WINDOW_LENGTHS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setLength(value);
                    setSelected(new Set());
                  }}
                  aria-pressed={length === value}
                  disabled={busy}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    length === value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {value} days
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void load({ planId, roomTypeId, fromDate, toDate });
              }}
              disabled={busy}
              aria-label="Reload the calendar"
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCw className="size-3.5" aria-hidden />
              )}
            </Button>
          </div>
        </div>

        {/* -- Messages ---------------------------------------------------- */}
        {notice !== null ? (
          <p
            className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
            role="status"
          >
            {notice}
          </p>
        ) : null}

        {error !== null ? (
          <p
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}

        {calendar !== null && !calendar.isEditable ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            This plan is paused or archived, so its calendar is read-only. Activate it to change
            prices.
          </p>
        ) : null}

        {/* -- The grid ---------------------------------------------------- */}
        {loading && calendar === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading the calendar…
          </div>
        ) : calendar === null ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {error === null ? 'Choose a rate plan and room type.' : 'Nothing to show.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              {(['DATE_OVERRIDE', 'SEASONAL', 'WEEKDAY', 'WEEKEND', 'DEFAULT'] as const).map(
                (source) => (
                  <span key={source} className="flex items-center gap-1.5">
                    <span
                      className={`size-2.5 rounded-sm border ${SOURCE_META[source].cell}`}
                      aria-hidden
                    />
                    {SOURCE_META[source].short}
                  </span>
                ),
              )}
              <span className="flex items-center gap-1.5">
                <span>·</span>
                {calendar.overrideCount} typed, {calendar.ruleDrivenCount} by rule, of{' '}
                {calendar.days.length} nights
              </span>
            </div>

            {/* An unresolved rule conflict is loud, because the affected
                nights are deliberately priced at the default until it is
                fixed — which is safe but is not what the operator asked for. */}
            {calendar.ambiguousCount > 0 ? (
              <p
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {calendar.ambiguousCount} night
                {calendar.ambiguousCount === 1 ? ' has' : 's have'} two equally-ranked rules
                competing, so {calendar.ambiguousCount === 1 ? 'it is' : 'they are'} priced at the
                default until one rule is given a higher priority. Open the rules below to fix it.
              </p>
            ) : null}

            <div
              className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7"
              role="group"
              aria-label="Nightly rates"
            >
              {calendar.days.map((day) => (
                <DayCell
                  key={day.stayDate}
                  day={day}
                  currency={currency}
                  selected={selected.has(day.stayDate)}
                  disabled={!calendar.isEditable || !canManage || busy}
                  onToggle={() => {
                    toggleDate(day.stayDate);
                  }}
                  onInspect={onInspectRule}
                />
              ))}
            </div>
          </>
        )}

        {/* -- Bulk editor ------------------------------------------------- */}
        {calendar !== null && calendar.isEditable && canManage ? (
          <BulkEditor
            currency={currency}
            selectedCount={selected.size}
            rate={bulkRate}
            busy={busy}
            onRateChange={setBulkRate}
            onSelectAll={() => {
              setSelected(new Set(calendar.days.map((day) => day.stayDate)));
            }}
            onSelectWeekends={() => {
              setSelected(
                new Set(
                  calendar.days.filter((day) => isWeekend(day.stayDate)).map((day) => day.stayDate),
                ),
              );
            }}
            onSelectNone={() => {
              setSelected(new Set());
            }}
            onApply={() => {
              const major = Number(bulkRate);
              if (bulkRate.trim().length === 0 || !Number.isFinite(major)) {
                setError('Enter a nightly rate to apply.');
                return;
              }
              setError(null);
              setConfirming({
                amountMinor: Math.round(major * 100),
                dates: [...selected].sort((a, b) => a.localeCompare(b)),
              });
            }}
            onClear={clearSelection}
          />
        ) : null}
      </CardContent>

      {confirming !== null ? (
        <ConfirmBulk
          currency={currency}
          amountMinor={confirming.amountMinor}
          dates={confirming.dates}
          roomTypeLabel={assignment === null ? '' : `${assignment.code} — ${assignment.name}`}
          busy={pending}
          onCancel={() => {
            setConfirming(null);
          }}
          onConfirm={() => {
            applyBulk(confirming.amountMinor, confirming.dates);
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * One night.
 *
 * A button, not a div with a click handler, so it is reachable and operable
 * from the keyboard without re-implementing roles and key handling.
 * `aria-pressed` carries the selection state, and the accessible name spells
 * out the date, the price and whether it is a dated price — a screen reader
 * user gets the same distinction the tint conveys visually.
 */
/**
 * Source labels and tints, one per tier.
 *
 * Deliberately FIVE visually distinct states rather than "overridden or not".
 * An operator's question at a glance is not "did I type this" but "why is it
 * this number", and collapsing seasonal, weekday and weekend into one
 * "rule-driven" colour would leave them opening the rules panel to find out.
 */
const SOURCE_META: Record<
  RateCalendarDay['source'],
  { short: string; label: string; cell: string; dot: string }
> = {
  DATE_OVERRIDE: {
    short: 'Typed',
    label: 'a dated price you typed',
    cell: 'border-primary/50 bg-primary/15',
    dot: 'bg-primary',
  },
  SEASONAL: {
    short: 'Season',
    label: 'a season',
    cell: 'border-violet-500/50 bg-violet-500/10',
    dot: 'bg-violet-500',
  },
  WEEKDAY: {
    short: 'Weekday',
    label: 'a weekday rule',
    cell: 'border-sky-500/50 bg-sky-500/10',
    dot: 'bg-sky-500',
  },
  WEEKEND: {
    short: 'Weekend',
    label: 'a weekend rule',
    cell: 'border-amber-500/50 bg-amber-500/10',
    dot: 'bg-amber-500',
  },
  DEFAULT: {
    short: 'Default',
    label: "the room type's default",
    cell: 'border-input bg-background hover:bg-accent',
    dot: 'bg-transparent',
  },
};

/**
 * One night.
 *
 * A button, not a div with a click handler, so it is reachable and operable
 * from the keyboard without re-implementing roles and key handling.
 * `aria-pressed` carries the selection state, and the accessible name spells
 * out the date, the price, WHICH TIER decided it, and what an override is
 * masking — a screen reader user gets everything the tint and the dot convey.
 *
 * `onInspect` is a second, nested control, so it is rendered as a sibling
 * button rather than inside the selection button: a button inside a button is
 * invalid HTML and the inner one is unreachable by keyboard.
 */
function DayCell({
  day,
  currency,
  selected,
  disabled,
  onToggle,
  onInspect,
}: {
  day: RateCalendarDay;
  currency: string;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onInspect: (ruleId: string) => void;
}) {
  const label = formatDayLabel(day.stayDate);
  const weekend = isWeekend(day.stayDate);
  const meta = SOURCE_META[day.source];

  // A rule worth inspecting: either the one that set this price, or the one an
  // override is currently masking. The second case is the point of `masked*` —
  // an operator must be able to see the rule still exists.
  const inspectableRuleId = day.ruleId ?? day.maskedRuleId;

  const accessibleName =
    `${label.weekday} ${label.day} ${label.month}: ` +
    `${formatMoney(day.effectiveRateMinor, currency)}, from ${meta.label}` +
    (day.ruleName === null ? '' : ` "${day.ruleName}"`) +
    (day.maskedRuleName === null
      ? ''
      : `, overriding ${day.maskedRuleName} at ${
          day.ruleRateMinor === null ? 'another rate' : formatMoney(day.ruleRateMinor, currency)
        }`) +
    (day.isAmbiguous ? ', conflicting rules — priced at the default until resolved' : '');

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={accessibleName}
        className={[
          'flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-60',
          selected ? 'border-primary ring-1 ring-primary' : '',
          day.isAmbiguous ? 'border-destructive bg-destructive/10' : selected ? '' : meta.cell,
        ].join(' ')}
      >
        <span
          className={`flex w-full items-center justify-between gap-1 text-[0.6875rem] ${
            weekend ? 'font-medium text-foreground' : 'text-muted-foreground'
          }`}
        >
          <span>
            {label.weekday} {label.day}
          </span>
          {day.isAmbiguous ? (
            <AlertTriangle className="size-3 text-destructive" aria-hidden />
          ) : day.source === 'DEFAULT' ? null : (
            <span className={`size-1.5 rounded-full ${meta.dot}`} aria-hidden />
          )}
        </span>

        <span className="text-sm font-semibold tabular-nums">
          {formatMoney(day.effectiveRateMinor, currency)}
        </span>

        {/* The source, in words. The tint alone is not an explanation, and a
            colour-blind operator would otherwise have only the price. */}
        <span className="flex w-full items-center justify-between gap-1 text-[0.625rem] text-muted-foreground">
          <span>{day.isAmbiguous ? 'Conflict' : meta.short}</span>
          <span>{label.month}</span>
        </span>

        {/* An override masking a rule: show what it is masking, so nobody
            deletes the rule wondering why it does nothing. */}
        {day.maskedRuleName !== null && day.ruleRateMinor !== null ? (
          <span className="w-full truncate text-[0.625rem] text-muted-foreground line-through">
            {formatMoney(day.ruleRateMinor, currency)}
          </span>
        ) : null}
      </button>

      {inspectableRuleId !== null ? (
        <button
          type="button"
          onClick={() => {
            onInspect(inspectableRuleId);
          }}
          aria-label={`Inspect the rule pricing ${label.day} ${label.month}`}
          title={day.ruleName ?? day.maskedRuleName ?? 'Inspect rule'}
          className="absolute top-1 right-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 sm:opacity-60"
        >
          <Info className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function BulkEditor({
  currency,
  selectedCount,
  rate,
  busy,
  onRateChange,
  onSelectAll,
  onSelectWeekends,
  onSelectNone,
  onApply,
  onClear,
}: {
  currency: string;
  selectedCount: number;
  rate: string;
  busy: boolean;
  onRateChange: (value: string) => void;
  onSelectAll: () => void;
  onSelectWeekends: () => void;
  onSelectNone: () => void;
  onApply: () => void;
  onClear: () => void;
}) {
  const none = selectedCount === 0;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">
          {none
            ? 'Select nights to reprice'
            : `${selectedCount} night${selectedCount === 1 ? '' : 's'} selected`}
        </span>
        <span className="text-muted-foreground">·</span>
        <button
          type="button"
          onClick={onSelectAll}
          disabled={busy}
          className="text-primary underline-offset-4 hover:underline disabled:opacity-60"
        >
          All visible
        </button>
        <button
          type="button"
          onClick={onSelectWeekends}
          disabled={busy}
          className="text-primary underline-offset-4 hover:underline disabled:opacity-60"
        >
          Weekends
        </button>
        <button
          type="button"
          onClick={onSelectNone}
          disabled={busy || none}
          className="text-primary underline-offset-4 hover:underline disabled:opacity-60"
        >
          None
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Nightly rate ({currency})</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={rate}
            onChange={(event) => {
              onRateChange(event.target.value);
            }}
            disabled={busy || none}
            className="h-9 w-32 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums disabled:opacity-60"
          />
        </label>

        <Button size="sm" onClick={onApply} disabled={busy || none}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Apply to selected
        </Button>

        <Button size="sm" variant="outline" onClick={onClear} disabled={busy || none}>
          <Eraser className="size-3.5" aria-hidden />
          Clear dated prices
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Clearing returns those nights to the default rate. Nights you have not selected are never
        changed.
      </p>
    </div>
  );
}

/**
 * The bulk confirmation summary.
 *
 * Required by the scope, and worth having: a bulk apply can reprice ninety
 * nights, and the span plus the count plus the category is what tells an
 * operator they selected what they meant to. The date list is summarised to
 * first and last rather than printed in full — ninety dates is not a summary.
 */
function ConfirmBulk({
  currency,
  amountMinor,
  dates,
  roomTypeLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  currency: string;
  amountMinor: number;
  dates: string[];
  roomTypeLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const first = dates[0];
  const last = dates.at(-1);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-rate-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <h2 id="bulk-rate-title" className="text-base font-semibold">
          Apply this rate to {dates.length} night{dates.length === 1 ? '' : 's'}?
        </h2>

        <dl className="mt-3 flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Room type</dt>
            <dd className="text-right font-medium">{roomTypeLabel}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Nightly rate</dt>
            <dd className="text-right font-semibold tabular-nums">
              {formatMoney(amountMinor, currency)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Dates</dt>
            <dd className="text-right tabular-nums">
              {first === last || last === undefined
                ? (first ?? '')
                : `${first ?? ''} → ${last} (${dates.length} selected)`}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-muted-foreground">
          Only these nights change. Every other date keeps whatever it has now.
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
