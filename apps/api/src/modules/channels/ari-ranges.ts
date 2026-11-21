/**
 * Date-range arithmetic for the ARI push (CM-03). Pure, so the debounce and
 * the compression are unit-tested without a database.
 *
 * All dates are `YYYY-MM-DD` calendar dates and every range is INCLUSIVE at
 * both ends, matching `date_from` / `date_to` on the wire. Calendar dates are
 * shifted by whole UTC days only, never built from a local clock (3.3).
 */

const DAY_MS = 86_400_000;

export interface DateRange {
  from: string;
  /** Inclusive. */
  to: string;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every date of an inclusive range, ascending. */
export function datesOf(range: DateRange): string[] {
  const out: string[] = [];
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) out.push(date);
  return out;
}

/** One pending change row, as read. Null room type = all; null dates = whole window. */
export interface PendingChange {
  roomTypeId: string | null;
  fromDate: string | null;
  toDate: string | null;
}

/**
 * The debounce: many change rows become, per room type, the fewest disjoint
 * ranges that cover them, clamped to the push window.
 *
 * Only room types in `mapped` are kept -- an unmapped type has nowhere to go.
 * Overlapping and touching ranges merge, so a booking that touched nights 3-5
 * and a block on nights 6-8 become one push of 3-8.
 */
export function mergeChanges(
  changes: readonly PendingChange[],
  mapped: readonly string[],
  window: DateRange,
): Map<string, DateRange[]> {
  const raw = new Map<string, DateRange[]>();
  for (const change of changes) {
    const targets =
      change.roomTypeId === null
        ? mapped
        : mapped.includes(change.roomTypeId)
          ? [change.roomTypeId]
          : [];
    const from =
      change.fromDate === null || change.fromDate < window.from ? window.from : change.fromDate;
    const to = change.toDate === null || change.toDate > window.to ? window.to : change.toDate;
    if (from > to) continue; // wholly outside the window (the past, or beyond it)
    for (const roomTypeId of targets) {
      const list = raw.get(roomTypeId) ?? [];
      list.push({ from, to });
      raw.set(roomTypeId, list);
    }
  }

  const merged = new Map<string, DateRange[]>();
  for (const [roomTypeId, ranges] of raw) {
    ranges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    const out: DateRange[] = [];
    for (const range of ranges) {
      const last = out.at(-1);
      if (last !== undefined && range.from <= addDays(last.to, 1)) {
        if (range.to > last.to) last.to = range.to;
      } else {
        out.push({ ...range });
      }
    }
    merged.set(roomTypeId, out);
  }
  return merged;
}

/**
 * Consecutive dates with an equal value become one range, so a year of the
 * same rate is one wire value rather than 365. `key` decides equality.
 */
export function compress<T>(
  days: readonly { date: string; value: T }[],
  key: (value: T) => string,
): { from: string; to: string; value: T }[] {
  const out: { from: string; to: string; value: T }[] = [];
  for (const day of days) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      addDays(last.to, 1) === day.date &&
      key(last.value) === key(day.value)
    ) {
      last.to = day.date;
    } else {
      out.push({ from: day.date, to: day.date, value: day.value });
    }
  }
  return out;
}
