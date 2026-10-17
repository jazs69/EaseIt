/**
 * Omnibar reservation search.
 *
 * ===========================================================================
 * One query string, seven ways a front desk identifies a booking.
 *
 * A guest at the counter offers whatever they have: a name, the last digits of
 * a phone number, an OTA reference from an email, the card in their hand, or
 * just "I'm in 1103E". The clerk should not have to choose a field first, so
 * the API searches all of them and reports **which one matched** — because
 * "Vikram Malhotra" appearing for the query `8829` is confusing unless the row
 * says it matched an OTA reference.
 *
 * On the government ID: the search accepts it, and the response never returns
 * it. `govtIdMasked` carries `XXXX-XXXX-1234` and nothing else, so a result
 * list cannot become a way to harvest identity numbers, and the raw value stays
 * out of logs (CLAUDE.md section 5).
 * ===========================================================================
 */

import { z } from 'zod';

import {
  bookingSourceSchema,
  businessDateSchema,
  mealPlanSchema,
  propertyIdSchema,
  reservationStatusSchema,
} from '../domain.js';

/* -------------------------------------------------------------------------- */
/*  Query                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Minimum two characters.
 *
 * A one-character query matches most of the portfolio, so it costs a scan to
 * return something useless. Enforced in the schema rather than the service, so
 * every caller gets the same answer.
 */
export const reservationSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Search needs at least 2 characters').max(120),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export type ReservationSearchQuery = z.infer<typeof reservationSearchQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Which field matched                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why this row came back.
 *
 * Ordered by how specifically each identifies a booking: an exact room or OTA
 * reference is a near-certain hit, a name fragment is a guess. The service
 * reports the most specific field that matched, and the UI leads the row with
 * it.
 */
export const matchedFieldSchema = z.enum([
  'MATCHED_BY_BOOKING_CODE',
  'MATCHED_BY_OTA_ID',
  'MATCHED_BY_ROOM',
  'MATCHED_BY_PHONE',
  'MATCHED_BY_GOVT_ID',
  'MATCHED_BY_EMAIL',
  'MATCHED_BY_NAME',
]);

export type MatchedField = z.infer<typeof matchedFieldSchema>;

export const MATCHED_FIELD_LABELS: Record<MatchedField, string> = {
  MATCHED_BY_BOOKING_CODE: 'Booking',
  MATCHED_BY_OTA_ID: 'OTA Ref',
  MATCHED_BY_ROOM: 'Room',
  MATCHED_BY_PHONE: 'Phone',
  MATCHED_BY_GOVT_ID: 'ID',
  MATCHED_BY_EMAIL: 'Email',
  MATCHED_BY_NAME: 'Guest',
};

/* -------------------------------------------------------------------------- */
/*  Result                                                                    */
/* -------------------------------------------------------------------------- */

export const reservationSearchHitSchema = z.object({
  /** The reservation id. Also the timeline block id, so a hit can be focused. */
  id: z.uuid(),
  bookingCode: z.string(),
  otaBookingId: z.string().nullable(),

  guestName: z.string(),
  guestPhone: z.string().nullable(),
  guestEmail: z.string().nullable(),
  /**
   * `XXXX-XXXX-1234`, or null where no ID was recorded.
   *
   * Masked server-side. The raw number never crosses the wire, so neither a
   * result list nor a browser devtools session is a route to it.
   */
  govtIdMasked: z.string().nullable(),

  /**
   * Room number, resolved through the reservation's room rows.
   *
   * Null while unassigned — which is a real state, not missing data. Derived
   * rather than stored: a denormalised copy would go stale on the first room
   * move (CLAUDE.md section 3.4).
   */
  roomNumber: z.string().nullable(),
  roomTypeName: z.string(),

  status: reservationStatusSchema,
  source: bookingSourceSchema,
  mealPlan: mealPlanSchema,

  /** Booked calendar dates, not actual arrival instants. */
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().positive(),

  /** Integer minor units, with its currency (CLAUDE.md section 3.4). */
  totalAmountMinor: z.number().int(),
  balanceAmountMinor: z.number().int(),
  currency: z.string().length(3),

  matchedField: matchedFieldSchema,
  /**
   * The exact substring that matched, for the UI to highlight.
   *
   * Sent rather than recomputed in the browser: the server knows which field
   * it matched and with what casing, and a client-side re-match would have to
   * guess — highlighting the wrong characters on a phone number is the kind of
   * small wrongness that makes a search feel broken.
   */
  matchedValue: z.string(),
});

export type ReservationSearchHit = z.infer<typeof reservationSearchHitSchema>;

export const reservationSearchResponseSchema = z.object({
  query: z.string(),
  propertyId: propertyIdSchema,
  hits: z.array(reservationSearchHitSchema),
  /** True when `limit` cut the list, so the UI can say "refine". */
  truncated: z.boolean(),
});

export type ReservationSearchResponse = z.infer<typeof reservationSearchResponseSchema>;
