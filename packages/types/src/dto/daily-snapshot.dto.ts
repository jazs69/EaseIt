/**
 * Closed days, as the night audit froze them (RP-05, RP-08, RP-10, GR-02).
 *
 * ===========================================================================
 * A closed day is read, never recomputed.
 *
 * Night-audit step 6 writes one `daily_snapshot` row per property per business
 * date and a trigger refuses to update it (CLAUDE.md section 3.3). Every
 * screen that reports a *closed* day reads that row, so the flash report, the
 * revenue screen, the dashboard and the group view agree with the books and
 * with each other. Recomputing a closed day from live tables would let a late
 * correction or a re-dated booking change history.
 *
 * A day that is not closed has no snapshot. Screens either leave it out and
 * say so, or label it as live ("on the books"). They never mix the two
 * without a label.
 *
 * Integers only. Occupancy is in basis points (7250 = 72.50%), and ADR and
 * RevPAR are minor units rounded once. ADR is null when nothing was sold:
 * zero would claim rooms were given away.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const closedDaySchema = z.object({
  businessDate: businessDateSchema,
  roomsAvailable: z.number().int().nonnegative(),
  roomsSold: z.number().int().nonnegative(),
  occupancyBp: z.number().int().nonnegative(),
  roomRevenueMinor: z.number().int(),
  adrMinor: z.number().int().nullable(),
  revparMinor: z.number().int(),
  serviceRevenueMinor: z.number().int(),
  taxMinor: z.number().int(),
  paymentsMinor: z.number().int(),
  refundsMinor: z.number().int(),
});

export type ClosedDay = z.infer<typeof closedDaySchema>;

/** The same figures summed over several closed days; the ratios are recomputed, not averaged. */
export const closedDayTotalsSchema = closedDaySchema.omit({ businessDate: true }).extend({
  days: z.number().int().nonnegative(),
});

export type ClosedDayTotals = z.infer<typeof closedDayTotalsSchema>;

/**
 * Sums closed days and derives the ratios from the sums.
 *
 * Averaging daily occupancy or ADR weights a quiet Tuesday the same as a
 * full Saturday, which is wrong. The totals are summed as integers and each
 * ratio is rounded once from them (CLAUDE.md section 3.4).
 */
export function totalClosedDays(days: readonly ClosedDay[]): ClosedDayTotals {
  let roomsAvailable = 0;
  let roomsSold = 0;
  let roomRevenueMinor = 0;
  let serviceRevenueMinor = 0;
  let taxMinor = 0;
  let paymentsMinor = 0;
  let refundsMinor = 0;
  for (const day of days) {
    roomsAvailable += day.roomsAvailable;
    roomsSold += day.roomsSold;
    roomRevenueMinor += day.roomRevenueMinor;
    serviceRevenueMinor += day.serviceRevenueMinor;
    taxMinor += day.taxMinor;
    paymentsMinor += day.paymentsMinor;
    refundsMinor += day.refundsMinor;
  }
  return {
    days: days.length,
    roomsAvailable,
    roomsSold,
    occupancyBp: roomsAvailable === 0 ? 0 : Math.round((roomsSold * 10_000) / roomsAvailable),
    roomRevenueMinor,
    adrMinor: roomsSold === 0 ? null : Math.round(roomRevenueMinor / roomsSold),
    revparMinor: roomsAvailable === 0 ? 0 : Math.round(roomRevenueMinor / roomsAvailable),
    serviceRevenueMinor,
    taxMinor,
    paymentsMinor,
    refundsMinor,
  };
}

/* -------------------------------------------------------------------------- */
/*  Revenue screen (RP-10)                                                    */
/* -------------------------------------------------------------------------- */

/** At most a year and a few days, like the other reports. */
export const REVENUE_MAX_DAYS = 370;

export const revenueQuerySchema = z
  .object({
    /** Omitted: the first of the month of the last closed day. */
    from: businessDateSchema.optional(),
    /** Omitted: the last closed day (the business date minus one). */
    to: businessDateSchema.optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: '"from" must not be after "to".',
    path: ['to'],
  });

export type RevenueQuery = z.infer<typeof revenueQuerySchema>;

export const revenueOverviewSchema = z.object({
  propertyName: z.string(),
  propertyCode: z.string(),
  currency: z.string().length(3),
  timeZone: z.string(),
  /** The open business date. Days before it are closed. */
  businessDate: businessDateSchema,
  /** The window actually used, after defaulting. */
  from: businessDateSchema,
  to: businessDateSchema,
  /** One entry per closed day in the window that has a snapshot, oldest first. */
  days: z.array(closedDaySchema),
  totals: closedDayTotalsSchema,
  /**
   * Days before the business date with no snapshot: closed by the calendar,
   * but no audit ran (data from before the night audit existed, or a gap).
   */
  missingDates: z.array(businessDateSchema),
  /** Days in the window on or after the business date: not closed yet, so not shown. */
  openDays: z.number().int().nonnegative(),
});

export type RevenueOverview = z.infer<typeof revenueOverviewSchema>;
