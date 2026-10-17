/**
 * Group reservation calendar — portfolio-wide occupancy over a date window.
 *
 * Zod schemas rather than the plain `interface` declarations the spec sketched,
 * because the API validates with these and the web app parses responses with
 * the same objects (CLAUDE.md section 5: one schema, one source of truth). A
 * bare interface cannot check that the server actually sent what it promised,
 * and `apiFetch` requires a parser. The exported type names are unchanged.
 */

import { z } from 'zod';

import { businessDateSchema, propertyIdSchema } from '../domain.js';

/* -------------------------------------------------------------------------- */
/*  Query                                                                     */
/* -------------------------------------------------------------------------- */

/** Days in a window. One week is the default; a month is the practical cap. */
export const CALENDAR_WINDOW = {
  DEFAULT_DAYS: 7,
  MAX_DAYS: 31,
} as const;

export const groupCalendarQuerySchema = z
  .object({
    /**
     * First day of the window. Omitted means "the reference property's own
     * business date" — resolved server-side, never from the browser's clock.
     *
     * This is the single most important line in the file. The obvious client
     * implementation is `new Date().toISOString().split('T')[0]`, which
     * converts a *local* date through UTC: at 02:00 in Asia/Kolkata that
     * yields yesterday, so a night auditor in India would open the calendar on
     * the wrong week (CLAUDE.md section 3.3).
     */
    startDate: businessDateSchema.optional(),
    /** Last day, inclusive. Defaults to `startDate + 6`. */
    endDate: businessDateSchema.optional(),
    /**
     * Comma-separated property ids to narrow to. Omitted means every property
     * the caller holds a grant at. A property they hold no grant at is
     * silently dropped rather than erroring — the filter is a *narrowing* of
     * their own set, never a way to widen it (CLAUDE.md section 3.2).
     */
    propertyIds: z.string().trim().min(1).optional(),
  })
  .refine(
    (query) =>
      query.startDate === undefined ||
      query.endDate === undefined ||
      query.endDate >= query.startDate,
    { message: 'endDate must be on or after startDate', path: ['endDate'] },
  );

export type GroupCalendarQuery = z.infer<typeof groupCalendarQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Daily occupancy                                                           */
/* -------------------------------------------------------------------------- */

export const dailyOccupancyItemSchema = z.object({
  /** `YYYY-MM-DD`. */
  date: businessDateSchema,
  /** `FRI`, `SAT` — computed server-side so every client agrees. */
  dayOfWeek: z.string(),
  /** `Oct 16`. */
  formattedDate: z.string(),
  /**
   * True for the reference property's current business date.
   *
   * Decided by the server, not by comparing against the browser's clock: a
   * portfolio spans timezones, so "today" is a property-relative fact rather
   * than a viewer-relative one.
   */
  isToday: z.boolean(),
  /** 0-100, rounded to one decimal place. */
  occupancyPercentage: z.number(),
  /** Rooms sold across the included properties on this date. */
  soldRooms: z.number().int().nonnegative(),
  /** Sellable rooms across the included properties on this date. */
  totalRooms: z.number().int().nonnegative(),
});

export type DailyOccupancyItem = z.infer<typeof dailyOccupancyItemSchema>;

/* -------------------------------------------------------------------------- */
/*  Per-property rollup                                                       */
/* -------------------------------------------------------------------------- */

export const propertyCalendarSummarySchema = z.object({
  propertyId: propertyIdSchema,
  propertyCode: z.string(),
  propertyName: z.string(),
  currency: z.string().length(3),
  /** Sellable rooms, excluding anything out of order. */
  totalRooms: z.number().int().nonnegative(),
  /**
   * Average daily rate over the window, in integer **minor units**.
   *
   * Named `averageRateMinor`, not `averageRate`, and that is deliberate: the
   * spec typed it as a bare `number`, which in practice means major units in a
   * float, and CLAUDE.md section 3.4 bans float money. Keeping the `Minor`
   * suffix makes the unit unmissable at every call site, matching
   * `baseRateMinor` and `totalAmountMinor` elsewhere.
   *
   * Null when no room-nights were sold in the window — an ADR of zero would
   * read as "we sold rooms for nothing" rather than "we sold nothing".
   */
  averageRateMinor: z.number().int().nonnegative().nullable(),
  /** 0-100, rounded to one decimal place. */
  averageOccupancy: z.number(),
  /** Room-nights sold in the window, which is the ADR's denominator. */
  roomNightsSold: z.number().int().nonnegative(),
  /**
   * False when this property has no room types configured yet, so the UI can
   * say "not set up" instead of showing a misleading 0% occupancy.
   */
  hasInventory: z.boolean(),
});

export type PropertyCalendarSummary = z.infer<typeof propertyCalendarSummarySchema>;

/* -------------------------------------------------------------------------- */
/*  Response                                                                  */
/* -------------------------------------------------------------------------- */

export const groupCalendarResponseSchema = z.object({
  dateRange: z.object({
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    totalDays: z.number().int().positive(),
  }),
  metrics: z.object({
    /**
     * Occupancy for the whole window, weighted by room count.
     *
     * `sum(sold) / sum(physical)` rather than the mean of each day's
     * percentage. The weighted form is the one that matches the books: a mean
     * of percentages lets a 4-room property swing the portfolio figure as hard
     * as a 200-room one, and it also quietly drags the average down for every
     * property that has no rooms configured at all.
     */
    averageOccupancy: z.number(),
    /**
     * `averageOccupancy - firstDayOccupancy`, in percentage points.
     *
     * Signed: negative means the window is softer than its opening day.
     */
    occupancyTrend: z.number(),
    propertiesCount: z.number().int().nonnegative(),
    /** How many of those actually have room types set up. */
    propertiesWithInventoryCount: z.number().int().nonnegative(),
  }),
  dailyOccupancy: z.array(dailyOccupancyItemSchema),
  properties: z.array(propertyCalendarSummarySchema),
  /**
   * The property whose business date defined "today", and its zone.
   *
   * Surfaced so the UI never has to guess, and so a portfolio spanning
   * Asia/Kolkata and Asia/Colombo is explicit about which clock the highlight
   * follows rather than silently picking one.
   */
  reference: z.object({
    propertyId: propertyIdSchema.nullable(),
    timezone: z.string(),
    businessDate: businessDateSchema,
  }),
});

export type GroupCalendarResponse = z.infer<typeof groupCalendarResponseSchema>;
