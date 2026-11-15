/**
 * When is a property's night audit due? (NA-03)
 *
 * ===========================================================================
 * Pure, so it is tested without a clock, a database or a queue.
 *
 * Each property is judged in its own IANA timezone (section 3.3): ten
 * properties are ten independent schedules, and "03:00" in Goa and "03:00" in
 * New York are different instants. The server's own clock and zone never
 * decide anything; the injected `now` is converted into the property's local
 * date and wall-clock time.
 *
 * Due means: the property's local calendar has moved exactly one day past its
 * open business date, and the local time has reached the audit time. So the
 * day 2026-11-15 is audited at 03:00 local on 2026-11-16.
 *
 * **A property more than one day behind is NOT due.** Catching up a backlog
 * automatically would roll no-shows and post charges for days nobody
 * reviewed, which on a development database (weeks behind the calendar) means
 * rewriting real-looking data overnight. A stale property is caught up by a
 * person, one day at a time, through the manual trigger.
 * ===========================================================================
 */

import { addDays, currentDateInTimeZone, type BusinessDate } from '@repo/types';

/** "HH:MM" in the property's zone, 24-hour. */
export function localTimeInTimeZone(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

export interface AuditDueInput {
  businessDate: BusinessDate;
  timeZone: string;
  now: Date;
  /** "HH:MM", local to the property. */
  auditTime: string;
}

export type AuditDueVerdict =
  | { due: true }
  | { due: false; reason: 'NOT_YET' | 'STALE' | 'AHEAD' };

export function auditDue(input: AuditDueInput): AuditDueVerdict {
  const localDate = currentDateInTimeZone(input.timeZone, input.now);
  const nextDay = addDays(input.businessDate, 1);

  if (localDate < nextDay) {
    // Still the business date locally (or the date is ahead of the calendar).
    return { due: false, reason: localDate < input.businessDate ? 'AHEAD' : 'NOT_YET' };
  }
  if (localDate > nextDay) return { due: false, reason: 'STALE' };

  // Zero-padded "HH:MM" strings compare correctly as strings.
  return localTimeInTimeZone(input.timeZone, input.now) >= input.auditTime
    ? { due: true }
    : { due: false, reason: 'NOT_YET' };
}
