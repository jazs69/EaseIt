/**
 * Stay restrictions per rate plan, room type and night (AV-07).
 *
 * `minLos` and `closedToArrival` constrain a stay ARRIVING on the date;
 * `closedToDeparture` constrains a stay DEPARTING on it. They apply only to
 * stays priced from the plan; a rack-rate booking names no plan.
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

/** The widest window one read or write may cover. */
export const MAX_RESTRICTION_DAYS = 366;

/** GET /properties/:hotelId/rate-plans/:ratePlanId/restrictions — both ends inclusive. */
export const rateRestrictionQuerySchema = z
  .object({
    roomTypeId: z.uuid(),
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
  })
  .refine((value) => value.toDate >= value.fromDate, {
    message: 'The end of the range cannot be before its start.',
    path: ['toDate'],
  });

export type RateRestrictionQuery = z.infer<typeof rateRestrictionQuerySchema>;

/**
 * PUT …/restrictions — set the SAME restriction on every night of a range.
 *
 * Absolute, not a patch: each night ends up exactly as described. All three
 * fields at their defaults (null, false, false) clears the range.
 */
export const setRateRestrictionsRequestSchema = z
  .object({
    roomTypeId: z.uuid(),
    fromDate: businessDateSchema,
    /** INCLUSIVE. */
    throughDate: businessDateSchema,
    minLos: z.number().int().min(1).max(365).nullable(),
    closedToArrival: z.boolean(),
    closedToDeparture: z.boolean(),
  })
  .refine((value) => value.throughDate >= value.fromDate, {
    message: 'The last night cannot fall before the first.',
    path: ['throughDate'],
  });

export type SetRateRestrictionsRequest = z.infer<typeof setRateRestrictionsRequestSchema>;

export const rateRestrictionDaySchema = z.object({
  stayDate: businessDateSchema,
  minLos: z.number().int().nullable(),
  closedToArrival: z.boolean(),
  closedToDeparture: z.boolean(),
});

export type RateRestrictionDayView = z.infer<typeof rateRestrictionDaySchema>;

export const rateRestrictionsResponseSchema = z.object({
  ratePlanId: z.uuid(),
  roomTypeId: z.uuid(),
  fromDate: businessDateSchema,
  toDate: businessDateSchema,
  /** Only nights that carry a restriction. */
  days: z.array(rateRestrictionDaySchema),
});

export type RateRestrictionsResponse = z.infer<typeof rateRestrictionsResponseSchema>;
