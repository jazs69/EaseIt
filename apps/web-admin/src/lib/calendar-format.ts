/**
 * Calendar date formatting, shared by server and client components.
 *
 * ===========================================================================
 * This lives in `lib/` rather than beside the header component, and that is
 * not organisational tidiness — it is a correctness requirement.
 *
 * These helpers were first exported from `group-calendar-header.tsx`, which
 * carries `'use client'`. Every export of a client module becomes a *client
 * reference*: a server component importing one gets a marshalling stub, not
 * the function. Calling it fails at render with "Attempted to call
 * formatShort() from the server but formatShort is on the client", which is
 * exactly what happened — `GroupKpiCards` is a server component.
 *
 * A plain module with no directive is usable from both sides, so shared pure
 * helpers belong here and never in a `'use client'` file.
 * ===========================================================================
 *
 * All arithmetic goes through UTC midnight. `new Date('2026-10-16')` is parsed
 * as UTC, while `new Date(2026, 9, 16)` is local — mixing the two is how a
 * calendar lands a day out for anyone not on UTC (CLAUDE.md section 3.3).
 */

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function parts(isoDate: string): { month: number; day: number } {
  const [, month = '1', day = '1'] = isoDate.split('-');
  return { month: Number(month) - 1, day: Number(day) };
}

/** `2026-10-16` -> `October 16`. */
export function formatLong(isoDate: string): string {
  const { month, day } = parts(isoDate);
  return `${MONTHS_LONG[month] ?? ''} ${String(day)}`;
}

/** `2026-10-16` -> `Oct 16`. */
export function formatShort(isoDate: string): string {
  const { month, day } = parts(isoDate);
  return `${MONTHS_SHORT[month] ?? ''} ${String(day)}`;
}

/**
 * Shifts `YYYY-MM-DD` by whole days.
 *
 * String in, string out, with no local `Date` in between. The tempting version
 * — `d.setDate(d.getDate() + n)` then `toISOString().slice(0, 10)` — reads the
 * date in local time and writes it back in UTC, so east of Greenwich it
 * returns the day before.
 */
export function shiftIsoDate(isoDate: string, days: number): string {
  const shifted = new Date(`${isoDate}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
