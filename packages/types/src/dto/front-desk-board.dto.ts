/**
 * The arrivals / departures board (FD-09).
 *
 * What reception works from on the business date: who is due in, who is due
 * out, and who is in the house. Two groups that a "today only" filter loses
 * are included and flagged, because they are the ones that need action:
 *
 *   * an **overdue arrival** -- confirmed, arrival before today, never checked
 *     in: a no-show waiting to be decided;
 *   * an **overstay** -- checked in, departure before today, never checked out.
 *
 * "Today" is always the property's business date, never the server clock
 * (CLAUDE.md 3.3). The balance is the folio's posted balance (charges minus
 * payments), shown only to a caller who can read folios: the board is also
 * readable by roles that are blind to money.
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const frontDeskRowFlagSchema = z.enum([
  /** Arriving today, not yet checked in. */
  'DUE_IN',
  /** Arrived today (checked in). */
  'ARRIVED',
  /** Arrival date passed, still not checked in. */
  'OVERDUE_ARRIVAL',
  /** Departing today, still in house. */
  'DUE_OUT',
  /** Departed today (checked out). */
  'DEPARTED',
  /** Departure date passed, still checked in. */
  'OVERSTAY',
  /** In house, not leaving today. */
  'STAYING',
]);

export type FrontDeskRowFlag = z.infer<typeof frontDeskRowFlagSchema>;

export const frontDeskRowSchema = z.object({
  reservationId: z.uuid(),
  bookingCode: z.string(),
  guestName: z.string(),
  status: z.string(),
  flag: frontDeskRowFlagSchema,
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().nonnegative(),
  adults: z.number().int(),
  children: z.number().int(),
  roomTypeName: z.string().nullable(),
  roomNumber: z.string().nullable(),
  /** Housekeeping status of the assigned room, or null when unassigned. */
  roomStatus: z.string().nullable(),
  /** For an arrival: a room is assigned and clean (VACANT_CLEAN or INSPECTED). */
  roomReady: z.boolean(),
  /** Posted folio balance; null when the caller cannot read folios. */
  balanceMinor: z.number().int().nullable(),
  currency: z.string(),
});

export type FrontDeskRow = z.infer<typeof frontDeskRowSchema>;

export const frontDeskBoardSchema = z.object({
  businessDate: businessDateSchema,
  /** Whether balances are included (the caller holds folio:read). */
  showsBalances: z.boolean(),
  arrivals: z.array(frontDeskRowSchema),
  departures: z.array(frontDeskRowSchema),
  inHouse: z.array(frontDeskRowSchema),
  counts: z.object({
    dueIn: z.number().int(),
    arrived: z.number().int(),
    overdueArrivals: z.number().int(),
    dueOut: z.number().int(),
    departed: z.number().int(),
    overstays: z.number().int(),
    inHouse: z.number().int(),
  }),
});

export type FrontDeskBoard = z.infer<typeof frontDeskBoardSchema>;
