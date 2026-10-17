/**
 * Timeline reservation calendar — the room × date grid.
 *
 * One request returns the whole grid: the date axis, the room axis, every
 * reservation block positioned on it, and the sold/available rollups above and
 * below. Deliberately one call, because every number on this screen has to
 * agree with every other — a footer saying "52 available" under a row showing
 * 53 blocks is worse than a slow screen.
 */

import { z } from 'zod';

import {
  businessDateSchema,
  mealPlanSchema,
  propertyIdSchema,
  reservationStatusSchema,
  roomIdSchema,
  roomStatusSchema,
  roomTypeIdSchema,
} from '../domain.js';
import { reservationSubStatusSchema } from './property-dashboard.dto.js';

/* -------------------------------------------------------------------------- */
/*  Query                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The timeframe switcher's four stops.
 *
 * `day` is not "one day column" — it is twenty-four *hour* columns, which is a
 * different axis entirely. That is why timeframe is its own union rather than
 * a day count: a number cannot express "columns mean hours now".
 */
export const timelineTimeframeSchema = z.enum(['day', 'week', 'ten_days', 'month']);
export type TimelineTimeframe = z.infer<typeof timelineTimeframeSchema>;

export const TIMEFRAME_LABELS: Record<TimelineTimeframe, string> = {
  day: 'Day',
  week: 'Week',
  ten_days: '10 days',
  month: 'Month',
};

/** Calendar days each timeframe covers. `day` covers one, shown hourly. */
export const TIMEFRAME_DAYS: Record<TimelineTimeframe, number> = {
  day: 1,
  week: 7,
  ten_days: 10,
  month: 31,
};

export const TIMELINE = {
  DEFAULT_TIMEFRAME: 'week' as TimelineTimeframe,
  /** Hard ceiling on the day axis; see the service note on the query cap. */
  MAX_DAYS: 31,
  HOURS_PER_DAY: 24,
  MINUTES_PER_DAY: 1440,
} as const;

/** How rooms are grouped on the left axis. */
export const timelineViewModeSchema = z.enum(['flat', 'by-category']);
export type TimelineViewMode = z.infer<typeof timelineViewModeSchema>;

/** Housekeeping condition filter, independent of occupancy. */
export const housekeepingFilterSchema = z.enum(['all', 'clean', 'dirty', 'blocked']);
export type HousekeepingFilter = z.infer<typeof housekeepingFilterSchema>;

export const timelineCalendarQuerySchema = z.object({
  /**
   * First column. Omitted means the property's own business date — never the
   * server's calendar day, which for a hotel in another zone is a different
   * day (CLAUDE.md section 3.3).
   */
  startDate: businessDateSchema.optional(),
  timeframe: timelineTimeframeSchema.default('week'),
  viewMode: timelineViewModeSchema.default('flat'),
  /** Narrow to one category. */
  roomTypeId: z.string().trim().min(1).optional(),
  /** Narrow to one floor, as stored on the room. */
  floor: z.string().trim().min(1).optional(),
  housekeeping: housekeepingFilterSchema.default('all'),
});

export type TimelineCalendarQuery = z.infer<typeof timelineCalendarQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Date axis                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a column means.
 *
 * `day` for week / 10-day / month, `hour` for the Day view. Returned alongside
 * the columns so the grid renders one array either way — the alternative was a
 * `dateRange` plus an optional `hourAxis`, i.e. two parallel shapes where only
 * one is ever populated, and every consumer having to work out which.
 */
export const columnKindSchema = z.enum(['day', 'hour']);
export type ColumnKind = z.infer<typeof columnKindSchema>;

/**
 * One column of the grid.
 *
 * Deliberately label-shaped rather than date-shaped. A month column needs a
 * date number above a single weekday letter; an hour column needs `09:00`; a
 * week column needs `Fri` / `Oct 16` / `2026`. Pushing that formatting to the
 * server means every client renders the same three slots and none of them has
 * to know which timeframe it is drawing.
 */
export const timelineColumnSchema = z.object({
  /** Stable React key: the date, or the date plus hour. */
  key: z.string(),
  /** The calendar date this column falls on — the same for all 24 in Day view. */
  date: businessDateSchema,
  /** 0-23 for an hour column, null for a day column. */
  hour: z.number().int().min(0).max(23).nullable(),

  /** Month view: `16`. Week: `Oct 16`. Hour: `09:00`. */
  primaryLabel: z.string(),
  /** Month view: `F`. Week: `Fri`. Hour: null. */
  secondaryLabel: z.string().nullable(),
  /** Week view only: `2026`. */
  tertiaryLabel: z.string().nullable(),

  /**
   * Falls on the property's current business date, decided server-side.
   *
   * Comparing against the browser's clock would highlight the wrong column for
   * anyone viewing a hotel in another timezone (CLAUDE.md section 3.3).
   */
  isToday: z.boolean(),
  isWeekend: z.boolean(),
  /** True when a new month starts here, so the month view can rule a divider. */
  startsMonth: z.boolean(),
});

export type TimelineColumn = z.infer<typeof timelineColumnSchema>;

/* -------------------------------------------------------------------------- */
/*  Reservation blocks                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Colour band for a block, derived from its status.
 *
 * Returned by the server so that every surface showing a reservation agrees on
 * what colour "confirmed" is — the grid, a future drag-and-drop preview and
 * the arrivals board must not each invent their own mapping.
 */
export const blockColourSchema = z.enum(['amber', 'emerald', 'zinc', 'slate', 'rose']);
export type BlockColour = z.infer<typeof blockColourSchema>;

export const timelineBlockSchema = z.object({
  id: z.uuid(),
  bookingCode: z.string(),
  /**
   * The room category this stay was booked into.
   *
   * Matters most when there is no room: an unassigned booking still has a
   * category, and it is the first thing the front desk needs in order to put
   * it somewhere. The *name* is not carried here — the client resolves it
   * against `categories` on the same payload, so there is no denormalised
   * copy able to drift from the category list the grid is drawn from.
   */
  roomTypeId: z.uuid(),
  guestName: z.string(),
  guestPhone: z.string().nullable(),
  guestEmail: z.string().nullable(),

  /** The stay's real extent, which may fall outside the window. */
  startDate: businessDateSchema,
  endDate: businessDateSchema,
  /** The property's wall-clock desk times, for the drawer's copy. */
  checkInTime: z.string(),
  checkOutTime: z.string(),
  nights: z.number().int().positive(),

  /**
   * When the guest actually arrived and left, if they have.
   *
   * ISO instants, null until the front desk records them. The Day view
   * positions blocks against these; where they are null it falls back to the
   * property's standard desk times, and `hasExactTimes` says which happened so
   * the UI can avoid implying a precision it does not have.
   */
  checkedInAt: z.iso.datetime({ offset: true }).nullable(),
  checkedOutAt: z.iso.datetime({ offset: true }).nullable(),
  hasExactTimes: z.boolean(),

  /**
   * Where the block sits on the grid, already clamped to the window.
   *
   * Computed server-side rather than in the client. The arithmetic is
   * half-open and easy to get subtly wrong — a stay departing on the first
   * column occupies no cell in it — and doing it once here means the grid, the
   * daily rollups and the footer cannot disagree about which nights a booking
   * covers.
   *
   * `gridStartIndex` is a zero-based column offset; `gridSpan` is how many
   * columns it covers.
   */
  gridStartIndex: z.number().int().nonnegative(),
  gridSpan: z.number().int().positive(),
  /**
   * Sub-column offsets, 0-1, for the Day view only.
   *
   * An hour column is 60 minutes wide, and a guest who checked in at 14:35 is
   * not at the left edge of the 14:00 column. These shift the block's leading
   * and trailing edges within their columns so an hourly view is actually
   * hourly rather than a chunkier day view.
   */
  leadFraction: z.number().min(0).max(1),
  trailFraction: z.number().min(0).max(1),
  /** True when the stay began before the window, so the UI can flag the edge. */
  continuesBefore: z.boolean(),
  continuesAfter: z.boolean(),

  status: reservationStatusSchema,
  subStatus: reservationSubStatusSchema.nullable(),
  colourVariant: blockColourSchema,

  mealPlan: mealPlanSchema,
  adults: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),

  /**
   * Integer minor units (CLAUDE.md section 3.4).
   *
   * `balanceAmountMinor` is derived here as total minus paid rather than
   * stored, so there is no third number able to disagree with the two it comes
   * from.
   */
  totalAmountMinor: z.number().int(),
  paidAmountMinor: z.number().int(),
  balanceAmountMinor: z.number().int(),
  currency: z.string().length(3),

  isMagicLinkActive: z.boolean(),
});

export type TimelineBlock = z.infer<typeof timelineBlockSchema>;

/* -------------------------------------------------------------------------- */
/*  Room axis                                                                 */
/* -------------------------------------------------------------------------- */

export const timelineRoomSchema = z.object({
  id: roomIdSchema,
  roomNumber: z.string(),
  floor: z.string().nullable(),
  roomTypeId: roomTypeIdSchema,
  roomTypeName: z.string(),
  roomTypeCode: z.string(),
  housekeepingStatus: roomStatusSchema,
  /** True for the two dirty states — drives the broom tag. */
  needsCleaning: z.boolean(),
  /**
   * False for OUT_OF_ORDER, which is not stock at all.
   *
   * Such a room still appears on the grid — the front desk needs to see why a
   * number is unusable — but it is excluded from every availability count, so
   * the row renders greyed rather than sellable.
   */
  isSellable: z.boolean(),
  blocks: z.array(timelineBlockSchema),
});

export type TimelineRoom = z.infer<typeof timelineRoomSchema>;

/* -------------------------------------------------------------------------- */
/*  Rollups                                                                   */
/* -------------------------------------------------------------------------- */

export const timelineDailyTotalSchema = z.object({
  date: businessDateSchema,
  sold: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  /** Sellable rooms on this date. */
  total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  /** 0-100, one decimal. */
  occupancyPercentage: z.number(),
});

export type TimelineDailyTotal = z.infer<typeof timelineDailyTotalSchema>;

export const timelineCategorySchema = z.object({
  id: roomTypeIdSchema,
  code: z.string(),
  name: z.string(),
  /** Rooms in this category, after filtering. */
  inventory: z.number().int().nonnegative(),
  baseRateMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  dailyAvailable: z.array(timelineDailyTotalSchema),
  /** Room ids in this category, in display order. */
  roomIds: z.array(roomIdSchema),
});

export type TimelineCategory = z.infer<typeof timelineCategorySchema>;

/* -------------------------------------------------------------------------- */
/*  Response                                                                  */
/* -------------------------------------------------------------------------- */

export const timelineCalendarSchema = z.object({
  property: z.object({
    id: propertyIdSchema,
    code: z.string(),
    name: z.string(),
    slug: z.string(),
    currency: z.string().length(3),
    timezone: z.string(),

    /**
     * The calendar date it currently is **at the property**.
     *
     * Distinct from `businessDate` on purpose, and the two can disagree:
     * `businessDate` is a ledger position advanced only by night audit step 7
     * (CLAUDE.md section 3.3), so a property whose audit has not run sits
     * behind the actual date.
     *
     * The grid's columns, `isToday` and the live marker all anchor to *this*
     * one, because a clerk looking at the calendar means the day it is. Every
     * posting, and every arrival/departure sub-status, still anchors to
     * `businessDate`, because those are the books. When they differ the UI
     * says so rather than quietly picking one.
     */
    today: businessDateSchema,
    businessDate: businessDateSchema,
    checkInTime: z.string(),
    checkOutTime: z.string(),
    /** Sellable rooms, excluding OUT_OF_ORDER. */
    totalRooms: z.number().int().nonnegative(),
    /** Every room on the floor plan, including unusable ones. */
    totalRoomsIncludingOutOfOrder: z.number().int().nonnegative(),
    /**
     * ADR over the window, in integer **minor units**.
     *
     * Named with the `Minor` suffix rather than the spec's `avgRate: 201.20`,
     * which is major units in a float — banned for money by CLAUDE.md
     * section 3.4. Null when no room-nights sold, because an ADR of zero
     * claims we sold rooms for nothing.
     */
    averageRateMinor: z.number().int().nonnegative().nullable(),
    /** 0-100, one decimal, weighted across the window. */
    averageOccupancy: z.number(),
  }),

  /** The column axis. Hours in Day view, dates otherwise. */
  columns: z.array(timelineColumnSchema),
  columnKind: columnKindSchema,
  timeframe: timelineTimeframeSchema,
  /** First and last calendar date covered, whatever the column kind. */
  windowStart: businessDateSchema,
  windowEnd: businessDateSchema,
  /**
   * Index of the column holding the property's *current calendar date*, or -1.
   *
   * In Day view this is 0 when the viewed date *is* today and -1 otherwise —
   * the live marker needs to know whether today is on screen at all before it
   * computes an intra-day offset.
   */
  todayIndex: z.number().int(),

  dailySummary: z.array(timelineDailyTotalSchema),
  categories: z.array(timelineCategorySchema),
  rooms: z.array(timelineRoomSchema),

  /**
   * Stays with no room assigned yet — the `UA (n)` badge.
   *
   * They have no row of their own, because a grid row is a physical room.
   * Surfacing them separately is the whole point: an unassigned arrival is
   * invisible on a room × date grid and is exactly what a front desk must not
   * miss.
   */
  unassigned: z.array(timelineBlockSchema),
  unassignedCount: z.number().int().nonnegative(),

  viewMode: timelineViewModeSchema,
  /** Floors present on this property, for the filter menu. */
  availableFloors: z.array(z.string()),
});

export type TimelineCalendar = z.infer<typeof timelineCalendarSchema>;
