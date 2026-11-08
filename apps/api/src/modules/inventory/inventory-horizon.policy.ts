/**
 * The pure decisions behind extending a property's inventory calendar.
 *
 * ===========================================================================
 * WHY THIS FILE HAS NO RELATIVE IMPORTS.
 * Deliberate, and the same reason `permission-policy.ts` and
 * `property-identifier.ts` avoid them: Node's type stripping does not rewrite
 * a `.js` specifier to the `.ts` beside it, so a module importing
 * `../errors/domain-error.js` cannot be loaded from a `.mjs` unit test at all.
 * Keeping the window arithmetic and the refusal *reasons* free of relative
 * imports is what makes them behaviourally testable without a database, a
 * module graph or a loader. The service next door turns a refusal into a typed
 * exception.
 *
 * WHAT THE CALENDAR IS.
 * `inventory_day` holds one row per (property, room type, stay date) and a
 * night with no row **cannot be sold**: `create-reservation.service.ts` locks
 * one row per night and refuses outright when the count comes back short. So
 * the calendar's extent is a hard selling limit, not a display preference, and
 * extending it is an operator action with a real consequence.
 *
 * WHAT A HORIZON IS *NOT*.
 * `MAX(stayDate)` is **not** proof that every earlier date exists. Rows can be
 * missing in the middle -- a room type added after a generation run, or a
 * partially-completed older import -- and a stay spanning such a gap is
 * refused even though the maximum is far in the future. So the honest number
 * is the last date through which *every* applicable room type has *every*
 * date, which is what `fullyConfiguredThrough` below computes.
 * ===========================================================================
 */

/** A calendar date as `YYYY-MM-DD`. Never an instant (CLAUDE.md section 3.3). */
export type CalendarDate = string;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * The furthest ahead an operator may extend, in days from today.
 *
 * Two seasons is more than any pilot hotel sells, and the cap is what bounds a
 * typo: `throughDate: '2927-06-30'` would otherwise ask for ~330,000 rows per
 * room type.
 */
export const MAX_HORIZON_DAYS = 730;

/**
 * Explicit budgets for the extension transaction. Stated, not inherited.
 *
 * ===========================================================================
 * Every other write path in this repository names its own budget --
 * `create-reservation.service.ts` has `TRANSACTION_TIMEOUT_MS = 10_000` -- and
 * this one did not, so it ran on whatever Prisma's built-in default happens to
 * be. That default is documented as 5 s, but it is a framework default rather
 * than a decision anybody here made, and a number nobody chose is a number
 * nobody can reason about when it starts failing.
 *
 * WHY 20 SECONDS.
 * The worst legitimate case is the approved maximum: 730 days ahead, inclusive
 * of both ends, so **731 dates** for every room type. At twelve categories
 * that is 8,772 rows, written by five statements (the range is chunked at 180
 * days). Each row's `physical` comes from a correlated `count(*)` over `room`,
 * so the cost is real work rather than a bulk copy. 20 s leaves roughly an
 * order of magnitude of headroom over a local run while still bounding a
 * pathological one -- an operator waiting 20 s for a calendar extension has
 * been told something useful; one waiting indefinitely has not.
 *
 * WHY maxWait IS SMALLER.
 * `maxWait` is time spent waiting for a *connection from the pool*, before any
 * work starts. Spending 20 s there would mean the pool is exhausted, which is
 * a different problem and one the caller should hear about quickly rather than
 * sit through. 5 s is long enough to ride out a burst.
 *
 * CONSEQUENCE FOR THE 730-DAY CASE: it is the case these numbers are sized
 * for, and it is the one to watch. If a property ever carries enough room
 * types that a full-horizon extension approaches 20 s, the right answer is to
 * chunk at fewer than 180 days -- not to raise this, because a transaction
 * that long holds its snapshot against everything else.
 * ===========================================================================
 */
export const TRANSACTION_TIMEOUT_MS = 20_000;
export const TRANSACTION_MAX_WAIT_MS = 5_000;

/** Days per SQL statement, so one chunk is never an unbounded insert. */
export const MAX_CHUNK_DAYS = 180;

/**
 * Parses `YYYY-MM-DD` into a UTC midnight instant, or null.
 *
 * Strict: the shape is checked first, then the parsed value is re-formatted and
 * compared, so `2026-02-30` is rejected rather than silently rolling over to
 * 2026-03-02 the way `new Date` would.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!DATE_SHAPE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return toCalendarDate(parsed) === value ? parsed : null;
}

/** Formats a UTC instant back to `YYYY-MM-DD`. */
export function toCalendarDate(instant: Date): CalendarDate {
  return instant.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** `date` shifted by whole days, as a UTC midnight instant. */
export function addCalendarDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Every date from `from` to `to`, both inclusive. Empty when `to < from`. */
export function enumerateDates(from: Date, to: Date): CalendarDate[] {
  const out: CalendarDate[] = [];
  for (let cursor = from.getTime(); cursor <= to.getTime(); cursor += MS_PER_DAY) {
    out.push(toCalendarDate(new Date(cursor)));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The extension request                                                     */
/* -------------------------------------------------------------------------- */

export interface HorizonRequest {
  /** The operator's `throughDate`, unvalidated. */
  readonly throughDate: string;
  /** Today in UTC, from the injected clock -- never `new Date()` here. */
  readonly today: Date;
}

export type HorizonRefusal =
  | { readonly kind: 'malformed'; readonly field: 'throughDate'; readonly message: string }
  | { readonly kind: 'past'; readonly field: 'throughDate'; readonly message: string }
  | { readonly kind: 'beyond-cap'; readonly field: 'throughDate'; readonly message: string };

export interface HorizonPlan {
  /** Inclusive first date to generate: today, per approved decision 3. */
  readonly from: Date;
  /** Inclusive last date to generate. */
  readonly to: Date;
  /** Total dates spanned, inclusive of both ends. */
  readonly dayCount: number;
  /** Bounded statement ranges, each at most `MAX_CHUNK_DAYS` long. */
  readonly chunks: readonly { readonly from: Date; readonly to: Date; readonly days: number }[];
}

/**
 * Validates a request and plans the generation, or explains the refusal.
 *
 * A result, not an exception: "is this date acceptable" is an expected
 * question with an expected negative answer (CLAUDE.md section 5). The service
 * maps a refusal onto `ValidationFailedError`.
 *
 * Generation always starts at **today**, inclusive, never at the existing
 * maximum. That is what lets a repeated request fill an internal gap it
 * previously skipped: the range is re-walked and `ON CONFLICT DO NOTHING`
 * absorbs everything already present.
 */
export function planHorizon(request: HorizonRequest): HorizonPlan | HorizonRefusal {
  const to = parseCalendarDate(request.throughDate);
  if (to === null) {
    return {
      kind: 'malformed',
      field: 'throughDate',
      message: 'Give a calendar date as YYYY-MM-DD.',
    };
  }

  // The clock may hand back any instant; the calendar day is what matters.
  const from = new Date(`${toCalendarDate(request.today)}T00:00:00.000Z`);

  if (to.getTime() < from.getTime()) {
    return {
      kind: 'past',
      field: 'throughDate',
      message:
        'That date has already passed. Inventory is only extended forwards; ' +
        'past nights are history and are never rewritten.',
    };
  }

  const span = daysBetween(from, to);
  if (span > MAX_HORIZON_DAYS) {
    return {
      kind: 'beyond-cap',
      field: 'throughDate',
      message:
        `That is ${String(span)} days ahead. The calendar can be extended at ` +
        `most ${String(MAX_HORIZON_DAYS)} days from today.`,
    };
  }

  return { from, to, dayCount: span + 1, chunks: chunkRange(from, to) };
}

/**
 * Splits an inclusive range into statements of at most `MAX_CHUNK_DAYS` days.
 *
 * Bounded so no single statement is an unbounded insert, while the service
 * still runs every chunk inside **one** transaction -- so the extension is
 * atomic and there is no partial-completion state to document.
 */
export function chunkRange(from: Date, to: Date): { from: Date; to: Date; days: number }[] {
  const chunks: { from: Date; to: Date; days: number }[] = [];
  if (to.getTime() < from.getTime()) return chunks;

  let cursor = from;
  while (cursor.getTime() <= to.getTime()) {
    const candidate = addCalendarDays(cursor, MAX_CHUNK_DAYS - 1);
    const end = candidate.getTime() > to.getTime() ? to : candidate;
    chunks.push({ from: cursor, to: end, days: daysBetween(cursor, end) + 1 });
    cursor = addCalendarDays(end, 1);
  }
  return chunks;
}

/* -------------------------------------------------------------------------- */
/*  Reading the horizon back                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One room type's forward coverage, as measured in the database.
 *
 * `firstMissingDate` is computed **in SQL**, by walking the dates and finding
 * the first with no row -- it is deliberately NOT derived from
 * `configuredDays`. A count cannot prove contiguity: a room type with a row
 * for today and rows for today+10..today+20 has a count of 12, and inferring
 * "contiguous for 12 days" from that would place the first hole at today+12
 * when it is really at today+1. That is the same mistake as trusting
 * `MAX(stayDate)`, wearing a different hat.
 */
export interface RoomTypeCoverage {
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  /** Rows this room type has on or after today. A count, nothing more. */
  readonly configuredDays: number;
  /** Its own `MAX(stayDate)`, or null when it has no forward rows at all. */
  readonly lastConfiguredDate: CalendarDate | null;
  /**
   * The first date on or after today with no row for this room type, measured
   * over the window up to the portfolio's furthest configured date. Null when
   * the room type is complete across that whole window.
   */
  readonly firstMissingDate: CalendarDate | null;
}

export interface RoomTypeGap {
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  /** Dates missing between today and the portfolio's furthest configured date. */
  readonly missingDates: number;
  /** The first date this room type cannot sell, or null when it has no gap. */
  readonly firstMissingDate: CalendarDate | null;
  /** Last date from today through which every date exists for this room type. */
  readonly configuredThrough: CalendarDate | null;
}

/**
 * Turns measured per-room-type coverage into gaps and one honest headline.
 *
 * `lastConfiguredDate` (the portfolio `MAX`) is reported because an operator
 * asked "how far does my calendar go" and that is the literal answer -- but it
 * is **never** used as proof of completeness. Two independent facts are
 * reported side by side on purpose:
 *
 *   * `lastConfiguredDate`      -- the furthest row that exists anywhere
 *   * `fullyConfiguredThrough`  -- the last date through which EVERY room type
 *                                  has EVERY date, with no hole
 *
 * They differ exactly when there is a gap, and the second is the one that
 * governs what can be sold. Each room type's contiguous end comes from its
 * SQL-measured `firstMissingDate`: the day before the first hole, or its own
 * maximum when it has none. The portfolio's is the earliest of those, because
 * an operator extending the calendar wants the date beyond which *anything*
 * starts refusing.
 *
 * `missingDates` counts holes within the measured window, as
 * `windowDays - configuredDays` -- a count difference, which is sound for a
 * *total* even though it says nothing about *where* the holes are.
 *
 * A property with no room types has no calendar to speak of; `null` says so
 * rather than claiming an infinite horizon.
 */
export function summariseCoverage(
  coverage: readonly RoomTypeCoverage[],
  today: Date,
): {
  fullyConfiguredThrough: CalendarDate | null;
  daysRemaining: number;
  gaps: RoomTypeGap[];
} {
  if (coverage.length === 0) {
    return { fullyConfiguredThrough: null, daysRemaining: 0, gaps: [] };
  }

  const startOfToday = new Date(`${toCalendarDate(today)}T00:00:00.000Z`);

  // The furthest any room type reaches: the window every type is measured in.
  const furthest = coverage.reduce<Date | null>((best, row) => {
    const parsed =
      row.lastConfiguredDate === null ? null : parseCalendarDate(row.lastConfiguredDate);
    if (parsed === null) return best;
    return best === null || parsed.getTime() > best.getTime() ? parsed : best;
  }, null);

  const windowDays = furthest === null ? 0 : daysBetween(startOfToday, furthest) + 1;

  const gaps: RoomTypeGap[] = [];
  let earliestEnd: Date | null = null;
  let anyIncomplete = false;

  for (const row of coverage) {
    const firstMissing =
      row.firstMissingDate === null ? null : parseCalendarDate(row.firstMissingDate);
    const ownLast =
      row.lastConfiguredDate === null ? null : parseCalendarDate(row.lastConfiguredDate);

    /**
     * This room type's contiguous end, from the measured hole.
     *
     * A hole on today itself means nothing is sellable: end is null. No hole
     * means its own maximum is the end. Otherwise it is the day before.
     */
    let contiguousEnd: Date | null;
    if (firstMissing !== null) {
      contiguousEnd =
        firstMissing.getTime() <= startOfToday.getTime() ? null : addCalendarDays(firstMissing, -1);
    } else {
      contiguousEnd = ownLast;
    }

    if (contiguousEnd === null) {
      anyIncomplete = true;
    } else if (earliestEnd === null || contiguousEnd.getTime() < earliestEnd.getTime()) {
      earliestEnd = contiguousEnd;
    }

    const missing = Math.max(0, windowDays - row.configuredDays);
    if (missing > 0 || firstMissing !== null || row.configuredDays === 0) {
      gaps.push({
        roomTypeId: row.roomTypeId,
        code: row.code,
        name: row.name,
        missingDates: missing,
        firstMissingDate: row.firstMissingDate,
        configuredThrough: contiguousEnd === null ? null : toCalendarDate(contiguousEnd),
      });
    }
  }

  // One room type unsellable from today makes the whole calendar unsellable
  // for that category, so the headline must not claim otherwise.
  /**
   * One room type unsellable from today makes the whole calendar unsellable
   * for that category, so the headline must not claim otherwise.
   *
   * Narrowed with an explicit local rather than `earliestEnd as Date`: the
   * cast was safe — `through` is non-null only when `earliestEnd` is — but a
   * cast that encodes an invariant the compiler cannot see is exactly the kind
   * that survives a refactor it should have blocked.
   */
  const end = anyIncomplete ? null : earliestEnd;

  return {
    fullyConfiguredThrough: end === null ? null : toCalendarDate(end),
    daysRemaining: end === null ? 0 : daysBetween(startOfToday, end),
    gaps,
  };
}
