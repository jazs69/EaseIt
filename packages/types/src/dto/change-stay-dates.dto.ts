/**
 * Changing a stay's dates: amend, extend, shorten (RS-11, RS-12).
 *
 * ===========================================================================
 * One operation, because extending, shortening and moving a stay are the same
 * write: some nights leave the stay and some join it. A night that leaves is
 * handed back to the room type's counter; a night that joins is sold under
 * the oversell CHECK, exactly as a new booking sells it (CLAUDE.md 3.1).
 *
 * Nights the stay keeps keep the price they were sold at. Only added nights
 * are priced, and the preview shows that price before anything is committed.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';
import { nightRateSourceSchema } from './create-reservation.dto.js';

export const changeStayDatesSchema = z
  .object({
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,

    /**
     * A manual price for each ADDED night, before tax. Without it, added
     * nights are priced from the stay's rate plan (no promotion), or the room
     * type's rack rate when the stay has no plan. Kept nights never reprice.
     */
    overrideNightlyRateMinor: z.number().int().nonnegative().max(100_000_000).optional(),

    /**
     * The new total the clerk was shown by the preview. When given, the change
     * is refused if the committed total would differ, so nobody agrees one
     * figure with a guest and charges another.
     */
    expectedTotalMinor: z.number().int().nonnegative().optional(),

    reason: z.string().trim().max(200).nullable().default(null),
  })
  .refine((value) => value.departureDate > value.arrivalDate, {
    path: ['departureDate'],
    message: 'Check-out must be at least one night after check-in.',
  });

export type ChangeStayDatesCommand = z.infer<typeof changeStayDatesSchema>;

/** A night joining or leaving the stay, at its price. */
export const stayDateNightSchema = z.object({
  stayDate: businessDateSchema,
  rateMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  rateSource: nightRateSourceSchema,
});

export type StayDateNight = z.infer<typeof stayDateNightSchema>;

const staySpanSchema = z.object({
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().positive(),
  totalMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
});

export const changeStayDatesPreviewSchema = z.object({
  reservationId: z.uuid(),
  bookingCode: z.string(),
  status: z.string(),
  currency: z.string(),
  roomNumber: z.string().nullable(),
  current: staySpanSchema,
  proposed: staySpanSchema,
  addedNights: z.array(stayDateNightSchema),
  removedNights: z.array(stayDateNightSchema),
  /** proposed.totalMinor - current.totalMinor; negative when shortening. */
  deltaMinor: z.number().int(),
});

export type ChangeStayDatesPreview = z.infer<typeof changeStayDatesPreviewSchema>;

export const changeStayDatesResultSchema = changeStayDatesPreviewSchema.extend({
  changedAt: z.iso.datetime({ offset: true }),
});

export type ChangeStayDatesResult = z.infer<typeof changeStayDatesResultSchema>;
