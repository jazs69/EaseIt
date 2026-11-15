/**
 * Pure arithmetic and refusal rules for room blocks.
 *
 * ===========================================================================
 * A PURE MODULE: no relative imports, no Nest decorators, no database. A
 * `.mjs` unit test imports it directly, the same shape as
 * `inventory-horizon.policy.ts`.
 *
 * THE ONE CONVERSION THIS FILE OWNS. The API accepts an INCLUSIVE
 * `throughDate` -- "block the 10th to the 15th" is six nights -- while
 * `room_block.throughDate` is EXCLUSIVE so that
 * `daterange(fromDate, throughDate, '[)')` lines up with
 * `reservation_room.departureDate` and the exclusion constraints. Converting
 * in one place is the whole reason this module exists; doing it at each call
 * site is how a feature loses or gains a night.
 *
 * NO DATE FLOOR IS COMPUTED HERE. There is no authoritative, advancing
 * property business date in this system, so nothing in this file restricts
 * past dates and nothing in it may claim to (limitation C1).
 * ===========================================================================
 */

/** `YYYY-MM-DD`. The only date representation this module accepts. */
export type CalendarDate = string;

/** The longest range a single block may cover, matching the horizon's cap. */
export const MAX_BLOCK_DAYS = 730;

/** Units a block withholds per night. */
export type BlockShape =
  { kind: 'SPECIFIC_ROOM'; roomId: string } | { kind: 'CATEGORY'; rooms: number };

/**
 * Units withheld per night, per the blocked-counter model.
 *
 * A specific-room block contributes exactly 1 and a category block
 * contributes its count -- and BOTH contribute, unconditionally. A
 * specific-room block that did not consume category capacity would leave a
 * night sellable with no room to honour it. `room_block_specific_is_one_room`
 * makes the 1 structural in the database rather than a convention here.
 */
export function contributionPerNight(shape: BlockShape): number {
  return shape.kind === 'SPECIFIC_ROOM' ? 1 : shape.rooms;
}

function parseUtc(date: CalendarDate): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a UTC epoch instant. */
export function toCalendarDate(epochMs: number): CalendarDate {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Nights covered by an INCLUSIVE range, both ends counted.
 *
 * `10th..15th` is six. The caller never derives this by subtraction.
 */
export function nightCountInclusive(from: CalendarDate, throughInclusive: CalendarDate): number {
  return Math.round((parseUtc(throughInclusive) - parseUtc(from)) / DAY_MS) + 1;
}

/**
 * The EXCLUSIVE end date the database stores, from the inclusive one the API
 * accepts. The single conversion point.
 */
export function toExclusiveEnd(throughInclusive: CalendarDate): CalendarDate {
  return toCalendarDate(parseUtc(throughInclusive) + DAY_MS);
}

/** The inclusive end to report back, from the exclusive one stored. */
export function toInclusiveEnd(throughExclusive: CalendarDate): CalendarDate {
  return toCalendarDate(parseUtc(throughExclusive) - DAY_MS);
}

/**
 * Every night an inclusive range covers, ascending.
 *
 * Enumerated, never expressed as a range: these dates become an `IN (...)`
 * predicate in the capacity lock, the posted-revenue guard and the counter
 * update, and "where the date is between" is the shape that one day gets
 * copied to a statement whose property filter has been dropped.
 */
export function enumerateNights(
  from: CalendarDate,
  throughInclusive: CalendarDate,
): CalendarDate[] {
  const nights: CalendarDate[] = [];
  const end = parseUtc(throughInclusive);
  for (let cursor = parseUtc(from); cursor <= end; cursor += DAY_MS) {
    nights.push(toCalendarDate(cursor));
  }
  return nights;
}

/** Why a requested range is not acceptable. */
export type RangeRefusal =
  | { kind: 'MALFORMED'; field: 'fromDate' | 'throughDate' }
  | { kind: 'INVERTED' }
  | { kind: 'TOO_LONG'; dayCount: number; max: number };

/**
 * Validate the shape of a range, and nothing else.
 *
 * Deliberately NOT validated here, and not validatable:
 *
 *   * that the nights are in the future. No authoritative business date
 *     exists, so no such check can be written (C1).
 *   * that the nights have `inventory_day` rows, that capacity is free, that
 *     no room charge is posted against them, and that no reservation or other
 *     block overlaps. Every one of those is a fact in the database and is
 *     checked under lock inside the block transaction, where it cannot go
 *     stale between the read and the write.
 *
 * A result, not an exception (section 5).
 */
export function evaluateRange(
  from: CalendarDate,
  throughInclusive: CalendarDate,
): { ok: true; nights: CalendarDate[] } | { ok: false; refusal: RangeRefusal } {
  if (Number.isNaN(parseUtc(from))) {
    return { ok: false, refusal: { kind: 'MALFORMED', field: 'fromDate' } };
  }
  if (Number.isNaN(parseUtc(throughInclusive))) {
    return { ok: false, refusal: { kind: 'MALFORMED', field: 'throughDate' } };
  }
  if (parseUtc(throughInclusive) < parseUtc(from)) {
    return { ok: false, refusal: { kind: 'INVERTED' } };
  }

  const dayCount = nightCountInclusive(from, throughInclusive);
  if (dayCount > MAX_BLOCK_DAYS) {
    return { ok: false, refusal: { kind: 'TOO_LONG', dayCount, max: MAX_BLOCK_DAYS } };
  }

  return { ok: true, nights: enumerateNights(from, throughInclusive) };
}

/**
 * The statuses a posted-revenue guard treats as "this night was transacted".
 *
 * `ROOM_CHARGE` only. Service charges, payments and tax are deliberately
 * excluded: a payment is dated by the business date (which would make the
 * guard circular), a service charge is not a room-night fact, and tax follows
 * its parent charge's date and so adds nothing.
 *
 * REVERSALS COUNT. A reversal of a room charge is itself a `ROOM_CHARGE` row
 * carrying `reversesLineId` -- which is why
 * `folio_line_one_room_charge_per_date` has to say `reversesLineId IS NULL` to
 * exclude them. The guard must NOT filter on `reversesLineId`: a reversal
 * records that a night was transacted and then corrected, not that it was
 * never transacted. `folios.service.ts` excludes reversals because it is
 * computing a balance, which is a different question.
 */
export const TRANSACTED_NIGHT_LINE_KIND = 'ROOM_CHARGE';

/**
 * WHAT THE POSTED-REVENUE GUARD DOES NOT COVER.
 *
 * Check-in posts the ARRIVAL NIGHT only. The remaining nights of a stay would
 * be posted by night-audit step 3, which does not exist. So for a multi-night
 * in-house stay, nights 2..n carry no `ROOM_CHARGE` and the guard does not
 * protect them. It must never be described as protecting every night of a
 * stay.
 *
 * Capacity (`inventory_day_not_oversold`) and the specific-room assignment
 * check remain independent protections, and the assignment check does cover
 * every night of a stay because it reads `reservation_room` date ranges rather
 * than folio lines.
 */
export const POSTED_REVENUE_GUARD_COVERS_ARRIVAL_NIGHT_ONLY = true;
