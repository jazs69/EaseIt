/**
 * The wire contract for reading and extending a property's inventory calendar.
 *
 * ===========================================================================
 * `inventory_day` holds one row per (property, room type, stay date), and a
 * night with no row cannot be sold -- `create-reservation` locks one row per
 * night and refuses when the count comes back short. So these two endpoints
 * govern how far ahead a hotel is able to take bookings at all.
 *
 * Nothing server-owned crosses the wire inbound: no `propertyId` (it comes
 * from the authenticated grant and the `:hotelId` path parameter), no
 * `physical`, `sold`, `blocked` or `overbookingAllowance`. The request is one
 * field (CLAUDE.md section 5).
 * ===========================================================================
 */

import { z } from 'zod';

/** `YYYY-MM-DD`. Validated at the boundary, never passed through raw. */
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Give a calendar date as YYYY-MM-DD.');

/* -------------------------------------------------------------------------- */
/*  POST /properties/:hotelId/inventory/horizon                               */
/* -------------------------------------------------------------------------- */

/**
 * The only inbound field.
 *
 * The range's *start* is not negotiable and is therefore not accepted:
 * generation always begins at today so that a repeated request re-walks the
 * whole window and fills any internal gap a previous run left behind.
 */
export const extendInventoryHorizonRequestSchema = z.object({
  throughDate: calendarDateSchema,
});

export type ExtendInventoryHorizonRequest = z.infer<typeof extendInventoryHorizonRequestSchema>;

export const extendInventoryHorizonResponseSchema = z.object({
  /** Echoed back so a client can confirm what the server acted on. */
  throughDate: calendarDateSchema,
  /** The UTC calendar date the range started from, inclusive. */
  fromDate: calendarDateSchema,
  /** Rows actually inserted. Counted by the database, never estimated. */
  rowsCreated: z.number().int().nonnegative(),
  /**
   * Rows the request covered that already existed. `attempted - created`,
   * where `attempted` is room types x dates as the statement enumerated them.
   */
  rowsSkipped: z.number().int().nonnegative(),
  /** Room types the run generated for. Zero means nothing to generate. */
  roomTypeCount: z.number().int().nonnegative(),
  /** Dates spanned, inclusive of both ends. */
  dayCount: z.number().int().nonnegative(),
  /** Re-read after the write: the last date EVERY room type now covers. */
  fullyConfiguredThrough: calendarDateSchema.nullable(),
});

export type ExtendInventoryHorizonResponse = z.infer<typeof extendInventoryHorizonResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  GET /properties/:hotelId/inventory/horizon                                */
/* -------------------------------------------------------------------------- */

export const inventoryGapSchema = z.object({
  roomTypeId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  /** How many dates are missing inside the measured window. */
  missingDates: z.number().int().nonnegative(),
  /** The first date this room type cannot sell. Null when it has no hole. */
  firstMissingDate: calendarDateSchema.nullable(),
  /** Last date from today with no hole before it. Null when today is missing. */
  configuredThrough: calendarDateSchema.nullable(),
});

export type InventoryGap = z.infer<typeof inventoryGapSchema>;

/**
 * Two different horizons, reported side by side on purpose.
 *
 * `lastConfiguredDate` is the furthest row that exists anywhere -- the literal
 * answer to "how far does my calendar go". `fullyConfiguredThrough` is the
 * last date through which *every* room type has *every* date. They differ
 * exactly when there is a gap, and the second is the one that governs what can
 * actually be sold. Reporting only the first would be the
 * `MAX(stayDate)`-as-proof mistake.
 */
export const inventoryHorizonSchema = z.object({
  /**
   * The current **UTC** calendar date, which bounded the range's start and
   * the 730-day cap. Deliberately not the property's timezone: these are
   * administrative endpoints, not financial postings, so the cap means the
   * same thing for every property.
   */
  today: calendarDateSchema,
  /** `MIN(stayDate)` across the property. Null when it has no rows at all. */
  firstConfiguredDate: calendarDateSchema.nullable(),
  /** `MAX(stayDate)`. Reported, never treated as proof of completeness. */
  lastConfiguredDate: calendarDateSchema.nullable(),
  /** The honest selling horizon: no room type has a hole before this date. */
  fullyConfiguredThrough: calendarDateSchema.nullable(),
  /** Whole days from today to `fullyConfiguredThrough`; 0 when that is null. */
  daysRemaining: z.number().int().nonnegative(),
  roomTypeCount: z.number().int().nonnegative(),
  /** The furthest an operator may extend to, as an absolute date. */
  maxExtendableThrough: calendarDateSchema,
  /** Only room types with a hole appear. Empty means the calendar is solid. */
  gaps: z.array(inventoryGapSchema),
});

export type InventoryHorizon = z.infer<typeof inventoryHorizonSchema>;

/* -------------------------------------------------------------------------- */
/*  GET /properties/:hotelId/inventory/days                                   */
/* -------------------------------------------------------------------------- */

/** The widest window one read may return. */
export const MAX_INVENTORY_DAYS_WINDOW = 90;

/** Both ends INCLUSIVE. */
export const inventoryDaysQuerySchema = z.object({
  roomTypeId: z.string().uuid(),
  fromDate: calendarDateSchema,
  toDate: calendarDateSchema,
});

export type InventoryDaysQuery = z.infer<typeof inventoryDaysQuerySchema>;

/**
 * One night of one category, with every counter the oversell CHECK reads.
 *
 * `sellable` is `physical + overbookingAllowance - sold - blocked`, the same
 * expression the booking path locks and compares, so the screen and the
 * booking agree on what "available" means.
 */
export const inventoryDaySchema = z.object({
  stayDate: calendarDateSchema,
  physical: z.number().int(),
  sold: z.number().int(),
  blocked: z.number().int(),
  overbookingAllowance: z.number().int(),
  sellable: z.number().int(),
});

export type InventoryDayView = z.infer<typeof inventoryDaySchema>;

export const inventoryDaysResponseSchema = z.object({
  roomTypeId: z.string().uuid(),
  fromDate: calendarDateSchema,
  toDate: calendarDateSchema,
  /** Only nights that have a row. A missing night is a calendar gap. */
  days: z.array(inventoryDaySchema),
});

export type InventoryDaysResponse = z.infer<typeof inventoryDaysResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  PUT /properties/:hotelId/inventory/overbooking                            */
/* -------------------------------------------------------------------------- */

/** The highest allowance one night may carry; a deliberate, small ceiling. */
export const MAX_OVERBOOKING_ALLOWANCE = 50;

/** The longest range one allowance write may cover, matching room blocks. */
export const MAX_OVERBOOKING_RANGE_DAYS = 730;

/**
 * Set a category's overbooking allowance on every night of a range.
 *
 * `throughDate` is INCLUSIVE. The value is absolute, not a delta, so a
 * repeated request is idempotent. Lowering it below what is already sold is
 * refused rather than clamped: the rooms are already promised.
 */
export const setOverbookingAllowanceRequestSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    fromDate: calendarDateSchema,
    throughDate: calendarDateSchema,
    allowance: z.number().int().min(0).max(MAX_OVERBOOKING_ALLOWANCE),
    reason: z.string().trim().min(1).max(500),
  })
  .refine((value) => value.throughDate >= value.fromDate, {
    message: 'The last night cannot fall before the first.',
    path: ['throughDate'],
  });

export type SetOverbookingAllowanceRequest = z.infer<typeof setOverbookingAllowanceRequestSchema>;

export const setOverbookingAllowanceResponseSchema = z.object({
  roomTypeId: z.string().uuid(),
  fromDate: calendarDateSchema,
  throughDate: calendarDateSchema,
  allowance: z.number().int(),
  nightsUpdated: z.number().int(),
});

export type SetOverbookingAllowanceResponse = z.infer<typeof setOverbookingAllowanceResponseSchema>;
