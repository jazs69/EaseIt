/**
 * The wire contract for the date-wise rate calendar (scope F2).
 *
 * ===========================================================================
 * THE MODEL IN ONE PARAGRAPH. A rate plan applies to several room types. Each
 * (plan, room type) assignment carries its own `defaultRateMinor`. A
 * `RatePlanDay` row exists only where the operator has deliberately priced one
 * night differently. The effective nightly rate is therefore:
 *
 *     override if one exists for that date, otherwise the assignment default
 *
 * and nothing else — no derivation, no occupancy adjustment, no promotion.
 * Those are F3/F4/F5 and are not implemented.
 *
 * ABSENCE IS MEANINGFUL. Clearing an override deletes the row; it does not
 * write the default into it. A stored copy of the default would make a later
 * change to that default silently fail to apply to those nights, which is the
 * subtlest way a rate calendar can lie.
 *
 * DATES ARE CALENDAR DATES, `YYYY-MM-DD`, validated through
 * `businessDateSchema` — the same brand arrival, departure and stay dates use.
 * They are never instants: a nightly rate belongs to the night the hotel calls
 * that date, and a timestamp shifts it by a day either side of midnight
 * depending on the reader's zone (CLAUDE.md section 3.3).
 *
 * EVERY AMOUNT IS AN INTEGER IN THE CURRENCY'S MINOR UNIT. No float ever
 * touches a rate, here or anywhere downstream (section 3.4). The one
 * major-unit conversion in the system happens inside the form component, at
 * the point a human types a number.
 *
 * NOTHING SERVER-OWNED CROSSES THE WIRE INBOUND: no `propertyId`, no
 * `ratePlanId` in a body (it is a path parameter), no timestamps, no
 * `updatedByUserId` (section 5).
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

/**
 * The widest calendar window a single read may ask for.
 *
 * 400 days rather than 365, so "the next year" plus a margin is one request
 * and a December-to-December window does not fail by a day. The cap exists
 * because the response is one row per date per category and an unbounded
 * window is an unbounded response — the same reasoning as the inventory
 * horizon's own chunk limit.
 */
export const MAX_RATE_CALENDAR_DAYS = 400;

/**
 * The most dates one bulk write may carry.
 *
 * Lower than the read cap on purpose: a write is a transaction, and a
 * transaction holding 400 upserts is a transaction held open while an operator
 * waits. 180 covers "price the whole season" in one action and keeps the
 * transaction short (section 3.1's rule about short transactions).
 */
export const MAX_RATE_CALENDAR_WRITE_DAYS = 180;

/* -------------------------------------------------------------------------- */
/*  Reading the calendar                                                      */
/* -------------------------------------------------------------------------- */

export const rateCalendarQuerySchema = z
  .object({
    roomTypeId: z.string().uuid('That is not a room-type id.'),
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
  })
  // String comparison is correct for `YYYY-MM-DD` and avoids constructing a
  // Date only to compare it — which is also how `stayRangeSchema` does it.
  .refine((value) => value.toDate >= value.fromDate, {
    message: 'The end of the range cannot be before its start.',
    path: ['toDate'],
  });

export type RateCalendarQuery = z.infer<typeof rateCalendarQuerySchema>;

/**
 * One night in the calendar.
 *
 * All three figures are reported, not just the effective one. An operator
 * needs to see *that* a night is overridden and *what it would otherwise be*,
 * because the decision they are making is usually "should this still be
 * different from the default?". A single effective number would hide that.
 */
export const rateCalendarDaySchema = z.object({
  stayDate: businessDateSchema,
  /**
   * The ASSIGNMENT's fallback — `rate_plan_room_type.defaultRateMinor`.
   *
   * F3 did NOT change this field's meaning. It is still the plan/room-type
   * default, not a rule-derived figure; a seasonal rate appears in
   * `ruleRateMinor`. Repeated on every row so a day stands alone.
   */
  defaultRateMinor: z.number().int().nonnegative(),
  /**
   * The explicit F2 date override, or null.
   *
   * F3 did NOT change this field's meaning either. A seasonal or weekday rate
   * is not an override, and does not appear here.
   */
  overrideRateMinor: z.number().int().nonnegative().nullable(),
  /**
   * What this night actually costs, after the full precedence in
   * `rate-pricing.policy.ts`: override → seasonal → weekday → weekend →
   * default.
   *
   * The FIELD's meaning is unchanged from F2 — "what this night costs" — but
   * its VALUE now accounts for F3 rules, which is the point of F3. Before any
   * rule exists it is identical to F2's answer.
   */
  effectiveRateMinor: z.number().int().nonnegative(),
  /** True only for an explicit date override. F2 meaning, unchanged. */
  hasOverride: z.boolean(),

  /* -- F3 additions, all new fields -------------------------------------- */

  /** Which tier decided the price. */
  source: z.enum(['DATE_OVERRIDE', 'SEASONAL', 'WEEKDAY', 'WEEKEND', 'DEFAULT']),
  /** The rule that decided it; null for DATE_OVERRIDE and DEFAULT. */
  ruleId: z.string().uuid().nullable(),
  ruleName: z.string().nullable(),
  /** The rule-derived rate that applies absent an override, or null. */
  ruleRateMinor: z.number().int().nonnegative().nullable(),
  /**
   * What WOULD have applied had there been no explicit override.
   *
   * Non-null only when an override is winning and a rule also matched. This is
   * what lets the UI say "overridden — the Christmas season would price this
   * at 4,500", so an operator can see the rule still exists rather than
   * deleting it wondering why it does nothing.
   */
  maskedSource: z.enum(['SEASONAL', 'WEEKDAY', 'WEEKEND']).nullable(),
  maskedRuleId: z.string().uuid().nullable(),
  maskedRuleName: z.string().nullable(),
  /**
   * True when two equally-ranked rules tied for this night and room type.
   *
   * The configuration is refused at write time, so this can only appear for an
   * ambiguity written before that check existed or by something that bypassed
   * the service. When true, `effectiveRateMinor` deliberately falls back to
   * `defaultRateMinor` and `source` is `DEFAULT` — the one figure nobody can
   * argue with — rather than the resolver picking a winner by row order.
   */
  isAmbiguous: z.boolean(),
  /** The tying rule ids, so the UI can name what needs resolving. */
  conflictingRuleIds: z.array(z.string().uuid()),
});

export type RateCalendarDay = z.infer<typeof rateCalendarDaySchema>;

export const rateCalendarResponseSchema = z.object({
  ratePlanId: z.string().uuid(),
  ratePlanCode: z.string(),
  roomTypeId: z.string().uuid(),
  roomTypeCode: z.string(),
  roomTypeName: z.string(),
  /** The property's currency. Every amount in `days` is in its minor unit. */
  currency: z.string().length(3),
  defaultRateMinor: z.number().int().nonnegative(),
  baseOccupancy: z.number().int().positive(),
  fromDate: businessDateSchema,
  toDate: businessDateSchema,
  /**
   * EVERY requested date, in order, including the ones with no override.
   *
   * A sparse response carrying only overridden nights would make the client
   * reconstruct the gaps, and a client that got that wrong would render a
   * blank cell as "free" rather than "default". The server fills the window.
   */
  days: z.array(rateCalendarDaySchema),
  /** How many of `days` carry an override. Saves the UI a pass to count them. */
  overrideCount: z.number().int().nonnegative(),
  /**
   * The property's weekend days (0 = Sunday … 6 = Saturday), so the grid can
   * label weekend nights with what this property actually calls its weekend
   * rather than assuming Saturday and Sunday.
   */
  weekendDays: z.array(z.number().int().min(0).max(6)),
  /** How many of `days` are priced by an F3 rule rather than by the default. */
  ruleDrivenCount: z.number().int().nonnegative(),
  /** How many of `days` have an unresolved rule conflict. Normally zero. */
  ambiguousCount: z.number().int().nonnegative(),
  /** False when the plan is inactive or archived: the calendar is read-only. */
  isEditable: z.boolean(),
});

export type RateCalendarResponse = z.infer<typeof rateCalendarResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Writing the calendar                                                      */
/* -------------------------------------------------------------------------- */

export const rateCalendarEntrySchema = z.object({
  stayDate: businessDateSchema,
  /** Integer minor units. Zero is legal; negative is refused. */
  amountMinor: z
    .number()
    .int('A rate must be a whole number of minor units.')
    .min(0, 'A rate cannot be negative.')
    // 21 474 836.47 in major units — the column is INTEGER, and a value past
    // its range would be a driver error rather than a readable refusal.
    .max(2_000_000_000, 'That rate is implausibly large.'),
});

export type RateCalendarEntry = z.infer<typeof rateCalendarEntrySchema>;

/**
 * A bulk date-wise write: upsert the listed dates, leave every other date alone.
 *
 * ONE ROOM TYPE PER REQUEST, deliberately. A request spanning categories would
 * make a partial failure ambiguous about which category was written, and the
 * operator's action is always "price Deluxe for these dates" — the category is
 * part of the intent, not an incidental field.
 *
 * DUPLICATE DATES ARE REFUSED rather than last-one-wins: two amounts for one
 * night is a client bug, and silently picking one would price a night from
 * whichever order the array happened to be in.
 */
export const updateRateCalendarRequestSchema = z
  .object({
    roomTypeId: z.string().uuid('That is not a room-type id.'),
    entries: z
      .array(rateCalendarEntrySchema)
      .min(1, 'Supply at least one date to price.')
      .max(
        MAX_RATE_CALENDAR_WRITE_DAYS,
        `A single update may cover at most ${String(MAX_RATE_CALENDAR_WRITE_DAYS)} dates.`,
      ),
  })
  .refine(
    (value) => new Set(value.entries.map((entry) => entry.stayDate)).size === value.entries.length,
    { message: 'The same date appears more than once.', path: ['entries'] },
  );

export type UpdateRateCalendarRequest = z.infer<typeof updateRateCalendarRequestSchema>;

/**
 * Clear overrides for the listed dates, so they fall back to the default.
 *
 * A separate endpoint from the bulk write rather than "send amount: null",
 * because removing a price and setting one are different operator intents with
 * different consequences — and a nullable amount in the write schema would
 * make a malformed client able to erase a season by omission.
 *
 * Clearing a date that has no override is NOT an error: the requested end
 * state is reached either way, and refusing would make "clear this selection"
 * fail whenever one day in it happened to be at the default already.
 */
export const clearRateCalendarRequestSchema = z
  .object({
    roomTypeId: z.string().uuid('That is not a room-type id.'),
    stayDates: z
      .array(businessDateSchema)
      .min(1, 'Supply at least one date to clear.')
      .max(
        MAX_RATE_CALENDAR_WRITE_DAYS,
        `A single clear may cover at most ${String(MAX_RATE_CALENDAR_WRITE_DAYS)} dates.`,
      ),
  })
  .refine((value) => new Set(value.stayDates).size === value.stayDates.length, {
    message: 'The same date appears more than once.',
    path: ['stayDates'],
  });

export type ClearRateCalendarRequest = z.infer<typeof clearRateCalendarRequestSchema>;

/**
 * What a write did, reported precisely rather than as a bare 200.
 *
 * `created`, `updated` and `cleared` are distinguished because they answer
 * different operator questions: "did my 20 dates all land?" and "did I just
 * change nights I did not mean to?". The refreshed window is returned in the
 * same response so the UI never has to guess what the calendar now says.
 */
export const rateCalendarWriteResultSchema = z.object({
  roomTypeId: z.string().uuid(),
  datesWritten: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  cleared: z.number().int().nonnegative(),
  /** The calendar as it now stands, for the window the caller asked about. */
  calendar: rateCalendarResponseSchema,
});

export type RateCalendarWriteResult = z.infer<typeof rateCalendarWriteResultSchema>;
