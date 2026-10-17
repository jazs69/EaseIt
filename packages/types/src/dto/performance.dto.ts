/**
 * Group performance analytics — the portfolio's financial dashboard.
 *
 * The four hospitality measures here are defined once, server-side, because
 * they are easy to compute differently and the differences are invisible:
 *
 *   Occupancy = room-nights sold / room-nights available
 *   ADR       = room revenue / room-nights sold          (sold is the divisor)
 *   RevPAR    = room revenue / room-nights available     (available is)
 *
 * ADR and RevPAR differ *only* in their denominator, and swapping them is the
 * classic reporting bug: ADR flatters a near-empty hotel, RevPAR does not. The
 * identity `RevPAR = ADR × occupancy` holds by construction here, and the
 * service asserts it rather than trusting it.
 */

import { z } from 'zod';

import { bookingSourceKeySchema, businessDateSchema, propertyIdSchema } from '../domain.js';

/* -------------------------------------------------------------------------- */
/*  Query                                                                     */
/* -------------------------------------------------------------------------- */

export const performanceTimeframeSchema = z.enum(['today', 'mtd', 'ytd']);
export type PerformanceTimeframe = z.infer<typeof performanceTimeframeSchema>;

export const PERFORMANCE_TIMEFRAME_LABELS: Record<PerformanceTimeframe, string> = {
  today: 'Today',
  mtd: 'MTD',
  ytd: 'YTD',
};

/** The measures the chart and the table can switch between. */
export const performanceMetricSchema = z.enum(['revenue', 'occupancy', 'adr', 'revpar']);
export type PerformanceMetric = z.infer<typeof performanceMetricSchema>;

export const PERFORMANCE_METRIC_LABELS: Record<PerformanceMetric, string> = {
  revenue: 'Revenue',
  occupancy: 'Occupancy',
  adr: 'ADR',
  revpar: 'RevPAR',
};

export const groupPerformanceQuerySchema = z.object({
  timeframe: performanceTimeframeSchema.default('ytd'),
  /**
   * The day the period is measured against. Omitted means the reference
   * property's own business date — never the server's calendar day
   * (CLAUDE.md section 3.3).
   */
  targetDate: businessDateSchema.optional(),
  /**
   * Comma-separated property ids to narrow to. A property the caller holds no
   * grant at matches nothing: the filter narrows their own set and can never
   * widen it (CLAUDE.md section 3.2).
   */
  propertyIds: z.string().trim().min(1).optional(),
  /** Also compute the same period one year earlier. */
  compareWithLastYear: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
});

export type GroupPerformanceQuery = z.infer<typeof groupPerformanceQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Core measures                                                             */
/* -------------------------------------------------------------------------- */

export const performanceMetricsSchema = z.object({
  /**
   * Integer minor units (CLAUDE.md section 3.4).
   *
   * Named `*Minor` rather than the spec's bare `totalRevenue: 1253897`, which
   * is major units in a float — banned for money. ₹12,53,897 is 125389700
   * paise, and the division by 100 happens once, in the UI formatter.
   */
  totalRevenueMinor: z.number().int().nonnegative(),
  /** 0-100, one decimal. */
  avgOccupancy: z.number(),
  /** Null when nothing sold: an ADR of zero claims we sold rooms for nothing. */
  adrMinor: z.number().int().nonnegative().nullable(),
  /** Zero is meaningful here — no revenue against real capacity is 0 RevPAR. */
  revParMinor: z.number().int().nonnegative(),

  roomNightsSold: z.number().int().nonnegative(),
  roomNightsAvailable: z.number().int().nonnegative(),
});

export type PerformanceMetrics = z.infer<typeof performanceMetricsSchema>;

/**
 * The same period one year earlier, plus the deltas.
 *
 * Null when the comparison was not requested, or when there is no data for that
 * period at all — a 0% prior that produces "+∞% growth" is worse than saying
 * there is nothing to compare against.
 */
export const yearComparisonSchema = z.object({
  previous: performanceMetricsSchema,
  /** Percent change, signed. Null where the prior value was zero. */
  revenueGrowthPercent: z.number().nullable(),
  occupancyDeltaPoints: z.number().nullable(),
  adrGrowthPercent: z.number().nullable(),
  revParGrowthPercent: z.number().nullable(),
  /** The window the comparison covers, for the UI's copy. */
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
});

export type YearComparison = z.infer<typeof yearComparisonSchema>;

/* -------------------------------------------------------------------------- */
/*  Rankings                                                                  */
/* -------------------------------------------------------------------------- */

export const performanceRankSchema = z.object({
  propertyId: propertyIdSchema,
  propertyCode: z.string(),
  name: z.string(),
  currency: z.string().length(3),
  revenueMinor: z.number().int().nonnegative(),
  occupancy: z.number(),
  adrMinor: z.number().int().nonnegative().nullable(),
  revParMinor: z.number().int().nonnegative(),
});

export type PerformanceRank = z.infer<typeof performanceRankSchema>;

export const performanceRankingsSchema = z.object({
  /** Ranked by revenue. Null when no property in scope has any. */
  topPerforming: performanceRankSchema.nullable(),
  lowPerforming: performanceRankSchema.nullable(),
  /**
   * True when top and low are the same property.
   *
   * With one property in scope they necessarily are, and a dashboard showing
   * the same hotel as both best and worst needs to say why rather than look
   * broken.
   */
  isSingleProperty: z.boolean(),
  metric: z.literal('Revenue'),
});

export type PerformanceRankings = z.infer<typeof performanceRankingsSchema>;

/* -------------------------------------------------------------------------- */
/*  Monthly trajectory                                                        */
/* -------------------------------------------------------------------------- */

export const monthlyPerformanceSchema = z.object({
  /** `Jan`. */
  month: z.string(),
  /** `2026-01`, for keys and tooltips. */
  monthKey: z.string(),
  revenueMinor: z.number().int().nonnegative(),
  occupancy: z.number(),
  adrMinor: z.number().int().nonnegative().nullable(),
  revParMinor: z.number().int().nonnegative(),
  roomNightsSold: z.number().int().nonnegative(),
  /**
   * False for months with no capacity configured at all.
   *
   * Lets the chart break the line rather than plotting a misleading zero for a
   * month the portfolio simply has no data for.
   */
  hasData: z.boolean(),
});

export type MonthlyPerformance = z.infer<typeof monthlyPerformanceSchema>;

/* -------------------------------------------------------------------------- */
/*  Booking source performance                                                */
/* -------------------------------------------------------------------------- */

/** Which measure the widget draws. A view choice, not a property of the data. */
export const bookingSourceMetricTypeSchema = z.enum(['revenue', 'rooms_sold']);
export type BookingSourceMetricType = z.infer<typeof bookingSourceMetricTypeSchema>;

export const bookingSourceMetricSchema = z.object({
  source: bookingSourceKeySchema,
  /** Pre-resolved operator-facing label, e.g. `BOOKING.COM`. */
  label: z.string(),
  /**
   * Integer minor units (CLAUDE.md section 3.4).
   *
   * Named `revenueMinor`, not the `revenue: number` a float would imply. ₹5,400
   * is 540000 paise, and the division by 100 happens once, in the UI formatter.
   */
  revenueMinor: z.number().int().nonnegative(),
  /**
   * Room-nights, not reservations and not rooms.
   *
   * The same unit as `metrics.roomNightsSold` on this payload, so the widget's
   * bars total to the headline KPI above them rather than to a different
   * number with a similar name. A 3-night booking of 2 rooms is 6.
   */
  roomNightsSold: z.number().int().nonnegative(),
  /**
   * Share of the period's total, 0-100 — one per measure.
   *
   * Two fields rather than the single `percentage` the shape first suggested,
   * because the denominator differs per toggle: a channel can be 40% of
   * revenue and 15% of room-nights (high-rate direct bookings) or the reverse
   * (discounted OTA volume). One field would silently show the wrong
   * denominator in one of the two modes, and the tooltip quotes both.
   */
  revenueSharePercent: z.number(),
  roomNightsSharePercent: z.number(),
});

export type BookingSourceMetric = z.infer<typeof bookingSourceMetricSchema>;

/**
 * The widget's whole dataset.
 *
 * Both measures travel together and the toggle is client-side: they are two
 * views of one grouping, so fetching per toggle would be a round trip to
 * re-read rows we already had — and would let the two views resolve against
 * different instants.
 *
 * Totals are the sum of `sources`, not a copy of the portfolio figure, so the
 * bars always add up to the total printed beside them. Each source's revenue is
 * rounded to a whole minor unit independently, so this total can sit a few
 * paise away from `metrics.totalRevenueMinor`, which rounds once over the whole
 * portfolio. Preferring self-consistency here is deliberate: a widget whose
 * bars do not sum to its own total is a bug a reader can see, and eight paise
 * across a year is not.
 */
export const bookingSourcePerformanceSchema = z.object({
  /** The mode the widget opens in. */
  metricType: bookingSourceMetricTypeSchema,
  sources: z.array(bookingSourceMetricSchema),
  totalRevenueMinor: z.number().int().nonnegative(),
  totalRoomNightsSold: z.number().int().nonnegative(),
  /**
   * True when no source recorded anything in the window.
   *
   * Lets the widget say so once instead of drawing eight zero-length bars,
   * which reads as a broken chart rather than an empty period.
   */
  isEmpty: z.boolean(),
});

export type BookingSourcePerformance = z.infer<typeof bookingSourcePerformanceSchema>;

/* -------------------------------------------------------------------------- */
/*  Per-property breakdown                                                    */
/* -------------------------------------------------------------------------- */

export const propertyPerformanceRowSchema = performanceRankSchema.extend({
  /** Sellable rooms, excluding anything out of order. */
  rooms: z.number().int().nonnegative(),
  roomNightsSold: z.number().int().nonnegative(),
  roomNightsAvailable: z.number().int().nonnegative(),
  /** Year-on-year revenue change, null without a comparison or a prior base. */
  yoyGrowthPercent: z.number().nullable(),
  /** Share of the portfolio's revenue in this period, 0-100. */
  revenueSharePercent: z.number(),
});

export type PropertyPerformanceRow = z.infer<typeof propertyPerformanceRowSchema>;

/* -------------------------------------------------------------------------- */
/*  Response                                                                  */
/* -------------------------------------------------------------------------- */

export const groupPerformanceSchema = z.object({
  timeframe: performanceTimeframeSchema,
  targetDate: businessDateSchema,
  /** The resolved window, inclusive. */
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  /** Portfolio currency. Mixed-currency portfolios are flagged below. */
  currency: z.string().length(3),
  /**
   * True when the properties in scope do not share one currency.
   *
   * Summing across currencies is meaningless, so the API still reports the
   * figures but marks them — the UI must warn rather than silently add rupees
   * to Sri Lankan rupees. A real fix needs exchange rates, which
   * CLAUDE.md section 3.4 permits as Decimal and which do not exist yet.
   */
  hasMixedCurrencies: z.boolean(),

  metrics: performanceMetricsSchema,
  lastYearComparison: yearComparisonSchema.nullable(),
  rankings: performanceRankingsSchema,
  monthlyData: z.array(monthlyPerformanceSchema),
  bookingSources: bookingSourcePerformanceSchema,
  propertyBreakdown: z.array(propertyPerformanceRowSchema),

  propertiesCount: z.number().int().nonnegative(),
  propertiesWithDataCount: z.number().int().nonnegative(),
  reference: z.object({
    timezone: z.string(),
    businessDate: businessDateSchema,
  }),
});

export type GroupPerformance = z.infer<typeof groupPerformanceSchema>;
