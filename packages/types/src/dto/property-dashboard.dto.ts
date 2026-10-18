/**
 * Property operations dashboard — the daily front-desk screen.
 *
 * One request returns everything the screen needs: the eight headline counts,
 * the reservation feed for whichever count is selected, today's availability by
 * category, and any operational alerts. Deliberately one call rather than five:
 * these numbers are read together and must agree with each other, and five
 * independent requests can resolve against five different instants.
 */

import { z } from 'zod';

import {
  businessDateSchema,
  mealPlanSchema,
  propertyIdSchema,
  reservationStatusSchema,
  roomTypeIdSchema,
} from '../domain.js';

/* -------------------------------------------------------------------------- */
/*  Query                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which headline count the reservation feed is showing.
 *
 * These are *views*, not statuses — `ARRIVALS` and `DEPARTURES` both select
 * CONFIRMED and CHECKED_IN rows and differ only by which date they match on,
 * and `MAGIC_LINK` cuts across status entirely. Modelling them as their own
 * union keeps that distinction from collapsing into a status filter that
 * cannot express it.
 */
export const dashboardMetricSchema = z.enum([
  'NEW_BOOKINGS',
  'IN_HOUSE',
  'ARRIVALS',
  'DEPARTURES',
  'CANCELLATIONS',
  'ON_HOLD',
  'NO_SHOWS',
  'MAGIC_LINK',
]);

export type DashboardMetric = z.infer<typeof dashboardMetricSchema>;

export const DASHBOARD_METRIC_LABELS: Record<DashboardMetric, string> = {
  NEW_BOOKINGS: 'New bookings',
  IN_HOUSE: 'In-house',
  ARRIVALS: 'Arrivals',
  DEPARTURES: 'Departures',
  CANCELLATIONS: 'Cancellations',
  ON_HOLD: 'On hold',
  NO_SHOWS: 'No shows',
  MAGIC_LINK: 'Magic link',
};

export const dashboardSummaryQuerySchema = z.object({
  /**
   * The operational day being viewed. Omitted means the property's own
   * business date, which is the only correct default: the server must not
   * substitute its own calendar day for a hotel in another timezone
   * (CLAUDE.md section 3.3).
   */
  date: businessDateSchema.optional(),
  metric: dashboardMetricSchema.default('IN_HOUSE'),
  /** Matches guest name, booking code, room number or phone. */
  search: z.string().trim().min(1).max(120).optional(),
});

export type DashboardSummaryQuery = z.infer<typeof dashboardSummaryQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Metrics                                                                   */
/* -------------------------------------------------------------------------- */

export const dashboardMetricsSchema = z.object({
  /** Bookings *created* on the target date, whenever the stay falls. */
  newBookingsCount: z.number().int().nonnegative(),
  /** Checked in and not yet checked out. */
  inHouseCount: z.number().int().nonnegative(),
  /** Due to arrive on the target date. */
  arrivalsCount: z.number().int().nonnegative(),
  /** Due to depart on the target date. */
  departuresCount: z.number().int().nonnegative(),
  cancellationsCount: z.number().int().nonnegative(),
  onHoldCount: z.number().int().nonnegative(),
  noShowsCount: z.number().int().nonnegative(),
  /** Live self-service links, across every status. */
  magicLinkCount: z.number().int().nonnegative(),
});

export type DashboardMetrics = z.infer<typeof dashboardMetricsSchema>;

/* -------------------------------------------------------------------------- */
/*  Reservation feed                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where a stay sits relative to the operational day, beyond its status.
 *
 * Derived per request rather than stored: it is a function of the status and
 * the date being viewed, so a stored copy would be wrong the moment the clock
 * passed midnight (CLAUDE.md section 3.4 — no cached derived state).
 */
export const reservationSubStatusSchema = z.enum([
  /** Checked in, due out today, not yet departed. */
  'PENDING_DEPARTURE',
  /** Expected today, not yet arrived. */
  'ARRIVING_TODAY',
  /** Should have departed before today and is still in the room. */
  'OVERSTAY',
  /** Expected before today and never arrived. */
  'OVERDUE_ARRIVAL',
]);

export type ReservationSubStatus = z.infer<typeof reservationSubStatusSchema>;

export const RESERVATION_SUB_STATUS_LABELS: Record<ReservationSubStatus, string> = {
  PENDING_DEPARTURE: 'Pending departure',
  ARRIVING_TODAY: 'Arriving today',
  OVERSTAY: 'Overstay',
  OVERDUE_ARRIVAL: 'Overdue arrival',
};

export const dashboardReservationSchema = z.object({
  id: z.uuid(),
  bookingCode: z.string(),

  /** Null until the front desk assigns a number. */
  roomNumber: z.string().nullable(),
  roomTypeId: roomTypeIdSchema,
  roomTypeName: z.string(),

  guestName: z.string(),
  guestPhone: z.string().nullable(),
  guestEmail: z.string().nullable(),

  /**
   * Calendar dates plus the property's wall-clock times, not instants.
   *
   * A hotel's check-in time is "12:00 PM at this property", which is not an
   * instant until a timezone is applied — and applying the *server's* zone is
   * the classic way a stay shifts a day either side of midnight
   * (CLAUDE.md section 3.3). The client formats these two fields together; it
   * never has to parse a timestamp back into a local day.
   */
  checkInDate: businessDateSchema,
  checkInTime: z.string(),
  checkOutDate: businessDateSchema,
  checkOutTime: z.string(),
  nights: z.number().int().positive(),

  mealPlan: mealPlanSchema,
  adults: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),

  status: reservationStatusSchema,
  subStatus: reservationSubStatusSchema.nullable(),

  /**
   * Money in integer minor units (CLAUDE.md section 3.4).
   *
   * `balanceAmountMinor` is computed as total minus paid at this boundary and
   * is not a stored column — one number derived from two, rather than three
   * numbers free to disagree.
   */
  totalAmountMinor: z.number().int(),
  paidAmountMinor: z.number().int(),
  balanceAmountMinor: z.number().int(),
  currency: z.string().length(3),

  isMagicLinkActive: z.boolean(),
  bookedAt: z.iso.datetime({ offset: true }),
});

export type DashboardReservation = z.infer<typeof dashboardReservationSchema>;

/* -------------------------------------------------------------------------- */
/*  Availability                                                              */
/* -------------------------------------------------------------------------- */

export const availabilityRowSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  code: z.string(),
  name: z.string(),
  /** Sellable rooms of this type on the target date. */
  physical: z.number().int().nonnegative(),
  sold: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  /** `physical + allowance - sold - blocked`, floored at zero for display. */
  availableCount: z.number().int().nonnegative(),
  baseRateMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

export type AvailabilityRow = z.infer<typeof availabilityRowSchema>;

export const availabilityBreakdownSchema = z.object({
  rows: z.array(availabilityRowSchema),
  totalAvailableRooms: z.number().int().nonnegative(),
  totalPhysicalRooms: z.number().int().nonnegative(),
});

export type AvailabilityBreakdown = z.infer<typeof availabilityBreakdownSchema>;

/* -------------------------------------------------------------------------- */
/*  Alerts                                                                    */
/* -------------------------------------------------------------------------- */

export const systemAlertSchema = z.object({
  id: z.string(),
  severity: z.enum(['OVERDUE', 'WARNING', 'INFO']),
  title: z.string(),
  body: z.string(),
  actionLabel: z.string().nullable(),
  /**
   * An external URL or null. Never a raw href taken from the database and
   * rendered blindly — the API only ever emits links it constructed itself.
   */
  actionHref: z.string().nullable(),
});

export type SystemAlert = z.infer<typeof systemAlertSchema>;

/* -------------------------------------------------------------------------- */
/*  The response                                                              */
/* -------------------------------------------------------------------------- */

export const propertyDashboardSchema = z.object({
  property: z.object({
    id: propertyIdSchema,
    code: z.string(),
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    currency: z.string().length(3),
    /**
     * The calendar date it currently is **at the property**.
     *
     * The default `targetDate`, and what the "Today" control returns to.
     * Distinct from `businessDate`, which is a ledger position advanced only
     * by night audit step 7 (CLAUDE.md section 3.3) and therefore sits behind
     * the real date whenever an audit has not run.
     */
    today: businessDateSchema,
    /** The property's own open accounting day. */
    businessDate: businessDateSchema,
    checkInTime: z.string(),
    checkOutTime: z.string(),
  }),
  /**
   * The day being viewed.
   *
   * Defaults to `property.today`, and may differ from both that and
   * `businessDate` once an operator picks a date.
   */
  targetDate: businessDateSchema,
  metrics: dashboardMetricsSchema,
  activeMetric: dashboardMetricSchema,
  reservations: z.array(dashboardReservationSchema),
  /** Count after the search filter, which is what the UI reports. */
  resultCount: z.number().int().nonnegative(),
  availability: availabilityBreakdownSchema,
  alerts: z.array(systemAlertSchema),
});

export type PropertyDashboard = z.infer<typeof propertyDashboardSchema>;
