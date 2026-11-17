/**
 * The public booking engine (BE-01..BE-05, AV-08): the wire contract.
 *
 * ===========================================================================
 * Every route is `/public/properties/:slug/...`. The slug is resolved to a
 * property ON THE SERVER, from the path; no request field names a property.
 *
 *   GET  /public/properties/:slug                      the hotel and its rooms
 *   GET  /public/properties/:slug/availability         sellable rooms, priced
 *   POST /public/properties/:slug/quotes               a signed price, held 15 min
 *   POST /public/properties/:slug/bookings             book that quote
 *   GET  /public/properties/:slug/bookings/:code       the guest's booking (access token)
 *   POST /public/properties/:slug/bookings/:code/pay   a payment link for the balance
 *
 * A quote is the hold: the price is signed and honoured for its lifetime. The
 * room is NOT held — it is taken at booking, in the same locked transaction
 * as staff bookings, and the guest is told plainly if it went in between.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

/** Nights one online booking may cover. */
export const MAX_ONLINE_NIGHTS = 30;
/** How far ahead a guest may arrive, in days from the hotel's business date. */
export const MAX_ONLINE_LEAD_DAYS = 365;
/** How long a quoted price is held. */
export const QUOTE_HOLD_MINUTES = 15;

export const publicRoomTypeSchema = z.object({
  roomTypeId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  maxGuests: z.number().int(),
  maxAdults: z.number().int().nullable(),
});
export type PublicRoomType = z.infer<typeof publicRoomTypeSchema>;

export const bookingEnginePropertySchema = z.object({
  slug: z.string(),
  name: z.string(),
  city: z.string().nullable(),
  currency: z.string(),
  /** The hotel's own date: the earliest possible arrival. Not the server's day. */
  today: businessDateSchema,
  checkInTime: z.string().nullable(),
  checkOutTime: z.string().nullable(),
  /** Whether "Pay now" is offered: the hotel has an active payment gateway. */
  prepayAvailable: z.boolean(),
  roomTypes: z.array(publicRoomTypeSchema),
});
export type BookingEngineProperty = z.infer<typeof bookingEnginePropertySchema>;

const occupancy = {
  adults: z.coerce.number().int().min(1, 'At least one adult.').max(20),
  children: z.coerce.number().int().min(0).max(20).default(0),
};

export const availabilityQuerySchema = z
  .object({
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
    ...occupancy,
  })
  .refine((v) => v.departureDate > v.arrivalDate, {
    message: 'Check-out must be after check-in.',
    path: ['departureDate'],
  });
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const publicRateOfferSchema = z.object({
  /** Null: the room's standard rate, when it is sold on no public plan. */
  ratePlanId: z.uuid().nullable(),
  ratePlanName: z.string(),
  description: z.string().nullable(),
  exTaxMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  /** The first night's rate before tax, for "from ₹X / night". */
  nightlyFromMinor: z.number().int().nonnegative(),
  promotionName: z.string().nullable(),
});
export type PublicRateOffer = z.infer<typeof publicRateOfferSchema>;

export const publicRoomOfferSchema = z.object({
  roomTypeId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  maxGuests: z.number().int(),
  /** Rooms left on the scarcest night, capped at 5 ("5+"): enough for "only 2 left". */
  roomsLeft: z.number().int().min(1).max(5),
  offers: z.array(publicRateOfferSchema).min(1),
});
export type PublicRoomOffer = z.infer<typeof publicRoomOfferSchema>;

export const availabilityResponseSchema = z.object({
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().positive(),
  adults: z.number().int(),
  children: z.number().int(),
  currency: z.string(),
  rooms: z.array(publicRoomOfferSchema),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

export const publicQuoteRequestSchema = z
  .object({
    roomTypeId: z.uuid(),
    ratePlanId: z.uuid().nullable(),
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).default(0),
    promoCode: z.string().trim().min(1).max(32).optional(),
  })
  .refine((v) => v.departureDate > v.arrivalDate, {
    message: 'Check-out must be after check-in.',
    path: ['departureDate'],
  });
export type PublicQuoteRequest = z.infer<typeof publicQuoteRequestSchema>;

export const publicQuoteSchema = z.object({
  /** Opaque, signed; quote it to book. Carries the held price. */
  quoteToken: z.string(),
  expiresAt: z.string(),
  roomTypeName: z.string(),
  ratePlanName: z.string(),
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().positive(),
  adults: z.number().int(),
  children: z.number().int(),
  nightly: z.array(
    z.object({
      stayDate: businessDateSchema,
      rateMinor: z.number().int().nonnegative(),
      taxMinor: z.number().int().nonnegative(),
    }),
  ),
  exTaxMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  currency: z.string(),
  promotionName: z.string().nullable(),
});
export type PublicQuote = z.infer<typeof publicQuoteSchema>;

export const paymentChoiceSchema = z.enum(['PAY_AT_HOTEL', 'PAY_NOW']);
export type PaymentChoice = z.infer<typeof paymentChoiceSchema>;

export const publicBookRequestSchema = z.object({
  quoteToken: z.string().min(16).max(20_000),
  guest: z.object({
    firstName: z.string().trim().min(1, 'Enter a first name.').max(80),
    lastName: z.string().trim().min(1, 'Enter a last name.').max(80),
    email: z.email('Enter a valid email address.').max(160),
    phone: z
      .string()
      .trim()
      .min(6, 'Enter a phone number.')
      .max(32)
      .regex(/^\+?[0-9 ()-]+$/, 'Enter a phone number using digits.'),
  }),
  specialRequests: z.string().trim().max(500).nullable().default(null),
  paymentChoice: paymentChoiceSchema,
});
export type PublicBookRequest = z.infer<typeof publicBookRequestSchema>;

export const publicBookingSchema = z.object({
  bookingCode: z.string(),
  /** Opaque; required to view or pay this booking later. Never guessable. */
  accessToken: z.string(),
  status: z.string(),
  guestName: z.string(),
  roomTypeName: z.string(),
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int(),
  adults: z.number().int(),
  children: z.number().int(),
  currency: z.string(),
  totalMinor: z.number().int(),
  paidMinor: z.number().int(),
  balanceMinor: z.number().int(),
  paymentChoice: paymentChoiceSchema,
  /** The live payment link, when the guest chose to pay now and one exists. */
  payment: z
    .object({ url: z.string().nullable(), status: z.string(), amountMinor: z.number().int() })
    .nullable(),
  /** True when this response is the earlier booking of a re-submitted quote. */
  replayed: z.boolean(),
});
export type PublicBooking = z.infer<typeof publicBookingSchema>;

export const bookingAccessQuerySchema = z.object({ access: z.string().min(16).max(200) });
export type BookingAccessQuery = z.infer<typeof bookingAccessQuerySchema>;
