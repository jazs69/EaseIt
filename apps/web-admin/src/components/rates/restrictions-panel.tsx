'use client';

/**
 * Stay restrictions for one rate plan and room type (AV-07).
 *
 * ===========================================================================
 * WHAT A RESTRICTION MEANS, AS THE SERVER ENFORCES IT.
 *
 *   * Minimum stay and closed-to-arrival are read from the ARRIVAL night: a
 *     stay arriving on a night with "min 3" must be three nights or more, and
 *     one arriving on a closed-to-arrival night is refused outright.
 *   * Closed-to-departure is read from the DEPARTURE date: a stay may not
 *     check out on it.
 *
 * Both are enforced on quote and booking for stays priced from this plan, with
 * a 409 naming the rule. A booking made at the rack rate names no plan, so no
 * plan's restriction applies to it -- the panel says so rather than letting an
 * operator believe a rule closes the whole room type.
 *
 * WRITES ARE ABSOLUTE OVER A RANGE. Saving sets every night from the first to
 * the last date to exactly what the form shows, replacing whatever was there.
 * "Clear" is the same write with no rule. Nothing is computed here: the list
 * is re-read from the server after every save.
 * ===========================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, Check, Info, Loader2, Lock } from 'lucide-react';

import {
  MAX_RESTRICTION_DAYS,
  type RatePlanView,
  type RateRestrictionDayView,
  type SetRateRestrictionsRequest,
} from '@repo/types';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';

import { ApiRequestError } from '@/lib/api';
import { fetchRateRestrictions, setRateRestrictions } from '@/lib/properties-client';

/** How far ahead the list of restricted nights looks. */
const WINDOW_DAYS = 90;

/** Today at the viewer's own location, as `YYYY-MM-DD` (same as the calendar). */
function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Calendar arithmetic on `YYYY-MM-DD`, in UTC so no local offset can shift the day. */
function shiftDate(date: string, days: number): string {
  const anchor = new Date(`${date}T00:00:00.000Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

/**
 * A `YYYY-MM-DD` string as the branded calendar date the DTO requires.
 *
 * SAFE because every value here comes from a date input, `todayLocal` or
 * `shiftDate`, all of which produce `YYYY-MM-DD`, and the server re-validates
 * with the same schema -- a bad value is a field-named 400, not trusted.
 */
function asCalendarDate(date: string): SetRateRestrictionsRequest['fromDate'] {
  return date as SetRateRestrictionsRequest['fromDate'];
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    const issues = error.details?.['issues'];
    if (typeof issues === 'object' && issues !== null) {
      const first = Object.values(issues as Record<string, unknown>).find(
        (value): value is string => typeof value === 'string',
      );
      if (first !== undefined) return first;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

interface Props {
  hotelId: string;
  /** The plan the calendar and the other panels are focused on; null when none. */
  plan: RatePlanView | null;
  canManage: boolean;
}

export function RestrictionsPanel({ hotelId, plan, canManage }: Props) {
  const assignments = plan?.roomTypes ?? [];
  const [chosenRoomTypeId, setChosenRoomTypeId] = useState('');
  const roomTypeId = assignments.some((entry) => entry.roomTypeId === chosenRoomTypeId)
    ? chosenRoomTypeId
    : (assignments[0]?.roomTypeId ?? '');

  const [days, setDays] = useState<RateRestrictionDayView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<'set' | 'clear' | null>(null);

  const [fromDate, setFromDate] = useState(() => todayLocal());
  const [throughDate, setThroughDate] = useState(() => todayLocal());
  const [minLos, setMinLos] = useState('');
  const [closedToArrival, setClosedToArrival] = useState(false);
  const [closedToDeparture, setClosedToDeparture] = useState(false);

  const inFlight = useRef<AbortController | null>(null);
  const windowStart = todayLocal();
  const windowEnd = shiftDate(windowStart, WINDOW_DAYS - 1);

  const load = useCallback(
    async (planId: string, typeId: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      setError(null);
      try {
        const result = await fetchRateRestrictions(
          hotelId,
          planId,
          { roomTypeId: typeId, fromDate: windowStart, toDate: windowEnd },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setDays(result.days);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setDays(null);
        setError(messageOf(caught, 'The restrictions could not be loaded.'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [hotelId, windowStart, windowEnd],
  );

  // With no plan or no room type the panel renders an empty state and never
  // reads `days`, so there is nothing to reset here.
  useEffect(() => {
    if (plan === null || roomTypeId === '') return;
    const planId = plan.id;
    // Deferred a tick, as in the occupancy panel: `load` sets state, and doing
    // that synchronously inside an effect cascades renders.
    const timer = setTimeout(() => {
      void load(planId, roomTypeId);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [plan, roomTypeId, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  async function save(clear: boolean): Promise<void> {
    if (plan === null || roomTypeId === '') return;
    setError(null);
    setNotice(null);

    if (throughDate < fromDate) {
      setError('The last night cannot be before the first.');
      return;
    }
    if (daysBetween(fromDate, throughDate) + 1 > MAX_RESTRICTION_DAYS) {
      setError(`At most ${String(MAX_RESTRICTION_DAYS)} nights in one change.`);
      return;
    }
    let minimum: number | null = null;
    if (!clear && minLos.trim() !== '') {
      const parsed = Number(minLos);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
        setError('Minimum stay is a whole number of nights from 1 to 365, or blank for none.');
        return;
      }
      minimum = parsed;
    }
    if (!clear && minimum === null && !closedToArrival && !closedToDeparture) {
      setError('Choose a minimum stay or a closure, or use Clear to remove restrictions.');
      return;
    }

    setSaving(clear ? 'clear' : 'set');
    try {
      await setRateRestrictions(hotelId, plan.id, {
        roomTypeId,
        fromDate: asCalendarDate(fromDate),
        throughDate: asCalendarDate(throughDate),
        minLos: clear ? null : minimum,
        closedToArrival: clear ? false : closedToArrival,
        closedToDeparture: clear ? false : closedToDeparture,
      });
      const nights = daysBetween(fromDate, throughDate) + 1;
      setNotice(
        clear
          ? `Restrictions cleared on ${String(nights)} night(s).`
          : `Restriction set on ${String(nights)} night(s).`,
      );
      await load(plan.id, roomTypeId);
    } catch (caught) {
      setError(messageOf(caught, 'The restriction could not be saved.'));
    } finally {
      setSaving(null);
    }
  }

  const title = (
    <CardTitle className="flex items-center gap-2 text-base">
      <Lock className="size-4" aria-hidden />
      Stay restrictions
    </CardTitle>
  );

  if (plan === null) {
    return (
      <Card>
        <CardHeader>{title}</CardHeader>
        <CardContent className="py-8 text-center text-xs text-muted-foreground">
          Select a rate plan to set minimum stays and closed dates.
        </CardContent>
      </Card>
    );
  }

  if (assignments.length === 0) {
    return (
      <Card>
        <CardHeader>{title}</CardHeader>
        <CardContent className="py-8 text-center text-xs text-muted-foreground">
          {plan.code} has no room types yet. Assign one to set restrictions on it.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3">
        {title}
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p>
            Minimum stay and closed to arrival apply to stays <strong>arriving</strong> on the
            night; closed to departure applies to stays <strong>checking out</strong> on the date.
            They refuse quotes and bookings priced from <strong>{plan.code}</strong>. A booking at
            the rack rate, with no plan, is not restricted.
          </p>
        </div>
        <label className="flex max-w-xs flex-col gap-1 text-xs text-muted-foreground">
          Room type
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
            value={roomTypeId}
            onChange={(event) => {
              setChosenRoomTypeId(event.target.value);
              setNotice(null);
            }}
          >
            {assignments.map((entry) => (
              <option key={entry.roomTypeId} value={entry.roomTypeId}>
                {entry.code} — {entry.name}
              </option>
            ))}
          </select>
        </label>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {canManage ? (
          <form
            className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-6"
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              First night
              <input
                type="date"
                required
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                value={fromDate}
                onChange={(event) => {
                  setFromDate(event.target.value);
                  if (throughDate < event.target.value) setThroughDate(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Last night
              <input
                type="date"
                required
                min={fromDate}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                value={throughDate}
                onChange={(event) => {
                  setThroughDate(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Minimum stay (nights)
              <input
                type="number"
                min={1}
                max={365}
                inputMode="numeric"
                placeholder="None"
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                value={minLos}
                onChange={(event) => {
                  setMinLos(event.target.value);
                }}
              />
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={closedToArrival}
                onChange={(event) => {
                  setClosedToArrival(event.target.checked);
                }}
              />
              Closed to arrival
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={closedToDeparture}
                onChange={(event) => {
                  setClosedToDeparture(event.target.checked);
                }}
              />
              Closed to departure
            </label>
            <div className="flex items-end gap-2">
              <Button type="submit" size="sm" disabled={saving !== null}>
                {saving === 'set' ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-3.5" aria-hidden />
                )}
                Apply
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving !== null}
                onClick={() => {
                  void save(true);
                }}
              >
                {saving === 'clear' ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Ban className="size-3.5" aria-hidden />
                )}
                Clear
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-6">
              Applies to every night from the first to the last, replacing what is there. Clear
              removes all restrictions on those nights.
            </p>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            You can view restrictions. Changing them needs the rates:manage permission.
          </p>
        )}

        {error !== null ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        {notice !== null ? (
          <p
            role="status"
            className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
          >
            {notice}
          </p>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Restricted nights, {formatDay(windowStart)} to {formatDay(windowEnd)}
          </h3>
          {loading && days === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading…
            </p>
          ) : days === null ? null : days.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No restrictions in the next {String(WINDOW_DAYS)} days. Every night is open.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Night</th>
                    <th className="px-3 py-2 font-medium">Minimum stay</th>
                    <th className="px-3 py-2 font-medium">Arrival</th>
                    <th className="px-3 py-2 font-medium">Departure</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <tr key={day.stayDate} className="border-t border-border">
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {formatDay(day.stayDate)}
                      </td>
                      <td className="px-3 py-2">
                        {day.minLos === null ? '—' : `${String(day.minLos)} nights`}
                      </td>
                      <td className="px-3 py-2">
                        {day.closedToArrival ? <Badge variant="secondary">Closed</Badge> : 'Open'}
                      </td>
                      <td className="px-3 py-2">
                        {day.closedToDeparture ? <Badge variant="secondary">Closed</Badge> : 'Open'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
