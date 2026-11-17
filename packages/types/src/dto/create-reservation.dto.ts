/**
 * Creating a reservation.
 *
 * ===========================================================================
 * What this contract deliberately does **not** accept from the client.
 *
 * The brief's request body carried `totalAmount` and `taxAmount`. Both are
 * absent here, and that is the single most important decision in this file:
 * server-owned fields are server-owned (CLAUDE.md section 5). A client that
 * can name the total can book a suite for ₹1, and no amount of UI validation
 * changes that, because the UI is not what posts the request.
 *
 * So the client sends what it is entitled to decide — dates, occupancy, room,
 * board, guest — plus an **explicit, auditable** nightly-rate override when a
 * clerk negotiates a price. Everything derived from those is recomputed
 * server-side and returned, and the quote endpoint exists so the form can show
 * the same figures without inventing them.
 *
 * `bookingCode` is not accepted either. The brief proposed
 * `SFBOOKING_${code}_${Date.now()}`, which collides whenever two clerks submit
 * in the same millisecond — the server generates it under the unique
 * constraint instead, and retries on collision.
 * ===========================================================================
 */

import { z } from 'zod';

import { taxComponentsSchema } from './property-config.dto.js';

import {
  bookingSourceSchema,
  businessDateSchema,
  mealPlanSchema,
  propertyIdSchema,
  reservationStatusSchema,
  roomIdSchema,
  roomTypeIdSchema,
} from '../domain.js';

/* -------------------------------------------------------------------------- */
/*  Supporting vocabulary                                                     */
/* -------------------------------------------------------------------------- */

export const govtIdTypeSchema = z.enum([
  'AADHAAR',
  'PASSPORT',
  'DRIVING_LICENSE',
  'VOTER_ID',
  'PAN',
]);

export type GovtIdType = z.infer<typeof govtIdTypeSchema>;

export const GOVT_ID_TYPE_LABELS: Record<GovtIdType, string> = {
  AADHAAR: 'Aadhaar Card',
  PASSPORT: 'Passport',
  DRIVING_LICENSE: 'Driving License',
  VOTER_ID: 'Voter ID',
  PAN: 'PAN Card',
};

/**
 * The form's "segment" and "sub-segment", mapped onto `BookingSource`.
 *
 * Two new columns over ground `BookingSource` already covers would be the
 * near-synonym trap section 6.1 warns about — and would let a booking claim
 * segment DIRECT while its source said AGODA. One field, two labels.
 */
export const BOOKING_SEGMENTS = ['DIRECT', 'OTA', 'CORPORATE', 'TRAVEL_AGENT'] as const;
export type BookingSegment = (typeof BOOKING_SEGMENTS)[number];

export const bookingSegmentSchema = z.enum(BOOKING_SEGMENTS);

export const SUB_SEGMENTS_BY_SEGMENT: Record<BookingSegment, readonly string[]> = {
  DIRECT: ['WALK_IN', 'PHONE', 'DIRECT_WEB'],
  OTA: ['MAKEMYTRIP', 'AGODA', 'BOOKING_COM', 'EXPEDIA', 'CLEARTRIP', 'OTA'],
  CORPORATE: ['CORPORATE'],
  TRAVEL_AGENT: ['TRAVEL_AGENT'],
};

export const SUB_SEGMENT_LABELS: Record<string, string> = {
  WALK_IN: 'Walk-in',
  PHONE: 'Phone',
  DIRECT_WEB: 'Website',
  MAKEMYTRIP: 'MakeMyTrip',
  AGODA: 'Agoda',
  BOOKING_COM: 'Booking.com',
  EXPEDIA: 'Expedia',
  CLEARTRIP: 'Cleartrip',
  OTA: 'Other OTA',
  CORPORATE: 'Corporate',
  TRAVEL_AGENT: 'Travel agent',
};

export const paymentMethodSchema = z.enum([
  'CASH',
  'UPI',
  'CARD',
  'BANK_TRANSFER',
  'CHEQUE',
  'OTHER',
]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  UPI: 'UPI / QR',
  CARD: 'Credit/Debit Card',
  BANK_TRANSFER: 'Bank Transfer',
  CHEQUE: 'Cheque',
  OTHER: 'Other',
};

/**
 * A payment method as STORED on a folio line (GP-07).
 *
 * `CITY_LEDGER` is written only by the bill-to-company transfer, never chosen
 * by a clerk as a way to pay, so it is in this response-side enum and not in
 * `paymentMethodSchema`, which every payment command validates against.
 */
export const storedPaymentMethodSchema = z.enum([...paymentMethodSchema.options, 'CITY_LEDGER']);
export type StoredPaymentMethod = z.infer<typeof storedPaymentMethodSchema>;

export const STORED_PAYMENT_METHOD_LABELS: Record<StoredPaymentMethod, string> = {
  ...PAYMENT_METHOD_LABELS,
  CITY_LEDGER: 'Billed to company',
};

export const genderSchema = z.enum(['MALE', 'FEMALE', 'OTHER']);
export type Gender = z.infer<typeof genderSchema>;

export const GENDER_LABELS: Record<Gender, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
};

/** One person on the booking. Ordinal 1 is the booker. */
export const reservationGuestSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(''),
  email: z
    .union([z.email(), z.literal('')])
    .nullable()
    .default(null),
  phone: z.string().trim().max(32).nullable().default(null),

  addressLine1: z.string().trim().max(160).nullable().default(null),
  addressLine2: z.string().trim().max(160).nullable().default(null),
  city: z.string().trim().max(80).nullable().default(null),
  state: z.string().trim().max(80).nullable().default(null),
  postalCode: z.string().trim().max(16).nullable().default(null),
  /** ISO-3166 alpha-2. Defaulted to IN by the form, never guessed here. */
  countryCode: z.string().trim().length(2).nullable().default(null),

  gender: genderSchema.nullable().default(null),
  /** `YYYY-MM-DD`. A calendar date, never an instant. */
  dateOfBirth: businessDateSchema.nullable().default(null),
  nationality: z.string().trim().max(60).nullable().default(null),
  occupation: z.string().trim().max(80).nullable().default(null),

  govtIdType: govtIdTypeSchema.nullable().default(null),
  govtIdNumber: z.string().trim().max(40).nullable().default(null),

  specialRequest: z.string().trim().max(500).nullable().default(null),
});

export type ReservationGuestInput = z.infer<typeof reservationGuestSchema>;

/* -------------------------------------------------------------------------- */
/*  Quote                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ask the server what a stay costs.
 *
 * The form calls this on every change so the price on screen is the price the
 * server will charge. Advisory only: it reserves nothing, and the booking
 * re-derives everything at commit time (section 3.1).
 */
export const reservationQuoteRequestSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  /** Negotiated nightly rate in minor units; omitted means the configured rate. */
  overrideNightlyRateMinor: z.number().int().nonnegative().optional(),
  /**
   * A target **gross** total to work backwards from, in minor units.
   *
   * The reverse direction: the clerk agreed a walk-out price and the nightly
   * rate and tax have to be solved for. Mutually exclusive with
   * `overrideNightlyRateMinor` — two contradictory price inputs would make the
   * answer depend on which one the server happened to read first.
   */
  targetTotalMinor: z.number().int().nonnegative().optional(),
  /**
   * Price each night from this rate plan (F9): date override, then season,
   * weekday and weekend rules, then the plan's default for the room type. The
   * plan must be active, not archived, and assigned to the room type. Omitted
   * means the room type's rack rate, as before. An override or a target total
   * still wins over the plan, for every night.
   */
  ratePlanId: z.uuid().optional(),
  /**
   * The party, for the plan's occupancy pricing. Omitted adults means the
   * plan's base occupancy (no extra-guest charge). Ignored without a plan.
   */
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).default(0),
  infants: z.number().int().min(0).max(20).default(0),
  /** A promo code to apply. Only meaningful with a plan; refused if it does not apply. */
  promoCode: z.string().trim().min(1).max(32).optional(),
  isTaxExempt: z.boolean().default(false),
});

export type ReservationQuoteRequest = z.infer<typeof reservationQuoteRequestSchema>;

/** The promotion a plan-priced stay received, if any. */
export const appliedPromotionSchema = z.object({
  promotionId: z.uuid(),
  promotionName: z.string(),
  promoCodeId: z.uuid().nullable(),
  discountTotalMinor: z.number().int().nonnegative(),
});

export type AppliedPromotion = z.infer<typeof appliedPromotionSchema>;

/** Which tier priced a night. RACK = room type base rate; MANUAL = override or target total. */
export const nightRateSourceSchema = z.enum([
  'DATE_OVERRIDE',
  'SEASONAL',
  'WEEKDAY',
  'WEEKEND',
  'DEFAULT',
  'RACK',
  'MANUAL',
]);

export type NightRateSource = z.infer<typeof nightRateSourceSchema>;

export const nightlyLineSchema = z.object({
  stayDate: businessDateSchema,
  nightlyRateMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  /** The GST band THIS night fell in. Nights of one stay can differ. */
  taxRatePercent: z.number(),
  rateSource: nightRateSourceSchema,
  /** Extra-guest charge included in `nightlyRateMinor` (plan occupancy pricing). */
  extraGuestMinor: z.number().int().nonnegative(),
  /** Promotion discount already taken off `nightlyRateMinor`. */
  discountMinor: z.number().int().nonnegative(),
});

export type NightlyLine = z.infer<typeof nightlyLineSchema>;

export const reservationQuoteSchema = z.object({
  nights: z.number().int().positive(),
  /**
   * The ARRIVAL night's rate. Equal to every night unless `isRateVarying`;
   * when it is, read `nightly` — this field alone would misstate the stay.
   */
  nightlyRateMinor: z.number().int().nonnegative(),
  /** True when the nights of this stay are not all priced the same. */
  isRateVarying: z.boolean(),
  /** The plan the stay was priced from; null for the rack rate or a manual price. */
  ratePlanId: z.uuid().nullable(),
  ratePlanCode: z.string().nullable(),
  /** Sum of the nights' extra-guest charges, before tax. */
  extraGuestTotalMinor: z.number().int().nonnegative(),
  /** The promotion applied, or null. Its discount is already in the nightly rates. */
  promotion: appliedPromotionSchema.nullable(),
  /** Room charge before tax. */
  exTaxMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  /** The arrival night's GST slab. Per-night slabs are on `nightly`. */
  taxRatePercent: z.number(),
  /**
   * The slab's CGST/SGST split, or null for an exempt stay.
   *
   * Null rather than zeroes, because an exempt stay must show no GST line at
   * all on an invoice — not a 0% line naming a slab the guest was never in.
   */
  taxComponents: taxComponentsSchema.nullable(),
  isTaxExempt: z.boolean(),
  /** Per-night split, for the "view day-wise split" accordion. */
  nightly: z.array(nightlyLineSchema),
  /** True when the rate came from the request rather than the room type. */
  isOverridden: z.boolean(),
  /**
   * Set when a target total could not be hit exactly.
   *
   * Reverse-solving from a gross total cannot always land on it: tax is
   * rounded per night, so some totals are simply not reachable by any integer
   * nightly rate. The server returns the nearest achievable figure and says
   * so, rather than quietly charging something other than what was typed.
   */
  targetAdjustment: z
    .object({
      requestedTotalMinor: z.number().int(),
      achievedTotalMinor: z.number().int(),
    })
    .nullable()
    .default(null),
});

export type ReservationQuote = z.infer<typeof reservationQuoteSchema>;

/* -------------------------------------------------------------------------- */
/*  Create                                                                    */
/* -------------------------------------------------------------------------- */

export const createReservationSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  /**
   * The specific room, when the clerk picked one.
   *
   * Optional on purpose: a booking without a room number is a legitimate
   * state — it is what the unassigned strip exists for — and forcing an
   * assignment at creation would make overbooking-by-room-type impossible.
   */
  roomId: roomIdSchema.nullable().default(null),

  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,

  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20).default(0),
  infants: z.number().int().min(0).max(20).default(0),

  mealPlan: mealPlanSchema.default('EP'),
  /** Mapped onto `source`; the segment is presentation, the source is stored. */
  source: bookingSourceSchema.default('WALK_IN'),

  /**
   * Everyone on the booking, booker first.
   *
   * At least one. The first entry's name, email and phone are also written to
   * the reservation's own columns, which is what search and every report read
   * — maintained in the same transaction so the two cannot disagree.
   */
  guests: z.array(reservationGuestSchema).min(1).max(20),

  /** An existing company to bill. Validated against this property's own rows. */
  companyId: z.uuid().nullable().default(null),

  isTaxExempt: z.boolean().default(false),
  /**
   * A negotiated nightly rate, in minor units.
   *
   * The only price input the server accepts. Everything else — ex-tax, tax,
   * total — is derived from it, so a client cannot assert a total that its
   * own line items do not add up to.
   */
  overrideNightlyRateMinor: z.number().int().nonnegative().optional(),
  /** Reverse direction, as on the quote. Mutually exclusive with the above. */
  targetTotalMinor: z.number().int().nonnegative().optional(),
  /** As on the quote: price each night from this plan. */
  ratePlanId: z.uuid().optional(),
  /** As on the quote. Redeemed atomically with the booking. */
  promoCode: z.string().trim().min(1).max(32).optional(),

  /** Straight to CHECKED_IN rather than CONFIRMED. */
  isInstantCheckIn: z.boolean().default(false),

  /**
   * Payment taken at the desk.
   *
   * `amountMinor` is accepted because it is a fact about the world — the clerk
   * genuinely took this much cash — rather than a derived figure. It is
   * validated against the total so it cannot exceed what is owed.
   */
  payment: z
    .object({
      method: paymentMethodSchema,
      amountMinor: z.number().int().positive(),
      /** Cheque number, transfer reference, or a note for anything else. */
      remark: z.string().trim().max(200).nullable().default(null),
    })
    .nullable()
    .default(null),

  notes: z.string().trim().max(500).nullable().default(null),
});

export type CreateReservationCommand = z.infer<typeof createReservationSchema>;

/* -------------------------------------------------------------------------- */
/*  Result                                                                    */
/* -------------------------------------------------------------------------- */

export const createdReservationSchema = z.object({
  id: z.uuid(),
  propertyId: propertyIdSchema,
  bookingCode: z.string(),
  status: reservationStatusSchema,
  guestName: z.string(),
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().positive(),
  roomNumber: z.string().nullable(),
  roomTypeName: z.string(),
  quote: reservationQuoteSchema,
  paidAmountMinor: z.number().int().nonnegative(),
  balanceAmountMinor: z.number().int(),
  currency: z.string().length(3),
});

export type CreatedReservation = z.infer<typeof createdReservationSchema>;

/* -------------------------------------------------------------------------- */
/*  Companies and lookups                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a company's legal name came from. Recorded permanently on the row.
 *
 * The three are not interchangeable on a tax invoice, which is the entire
 * reason the distinction is carried rather than collapsed into a boolean:
 * MOCK exists so synthetic development data stays identifiable after it is
 * saved.
 */
export const gstinVerificationStateSchema = z.enum(['UNVERIFIED', 'MOCK', 'VERIFIED']);
export type GstinVerificationState = z.infer<typeof gstinVerificationStateSchema>;

export const companySummarySchema = z.object({
  id: z.uuid(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  gstin: z.string(),
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  verification: gstinVerificationStateSchema,
  gstinProvider: z.string().nullable(),
});

export type CompanySummary = z.infer<typeof companySummarySchema>;

export const createCompanySchema = z.object({
  gstin: z.string().trim().length(15),
  legalName: z.string().trim().min(1).max(160),
  tradeName: z.string().trim().max(160).nullable().default(null),
  addressLine1: z.string().trim().max(200).nullable().default(null),
  city: z.string().trim().max(80).nullable().default(null),
  state: z.string().trim().max(80).nullable().default(null),
  postalCode: z.string().trim().max(16).nullable().default(null),
  email: z
    .union([z.email(), z.literal('')])
    .nullable()
    .default(null),
  phone: z.string().trim().max(32).nullable().default(null),
  /**
   * What the client believes about the name's provenance.
   *
   * Advisory only — the server re-runs the lookup and records its own answer,
   * because a client that could assert VERIFIED could launder a typed name
   * into a verified one.
   */
  verification: gstinVerificationStateSchema.default('UNVERIFIED'),
});

export type CreateCompanyCommand = z.infer<typeof createCompanySchema>;

/**
 * What can be known about a GSTIN without calling the GST Network.
 *
 * `isValid` is arithmetic — the number's own check digit. `isRegistryVerified`
 * is whether the government confirmed the registration, which needs
 * credentialled access this deployment does not have, so it is always false
 * and `legalName` is always null. The fields exist so the UI can distinguish
 * "the number is well-formed" from "the business is registered", which are
 * very different assurances to put on a tax invoice.
 */
export const gstinAddressSchema = z.object({
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  fullAddress: z.string().nullable(),
});

export const gstinLookupSchema = z.object({
  success: z.boolean(),
  gstin: z.string(),
  /** Structure and mod-36 check digit. True does not mean "registered". */
  isValid: z.boolean(),
  reason: z.string().nullable(),
  stateCode: z.string().nullable(),
  stateName: z.string().nullable(),
  pan: z.string().nullable(),

  /** Which provider answered. `none` when the number failed offline checks. */
  provider: z.enum(['none', 'mock', 'sandbox', 'cashfree']),
  verification: gstinVerificationStateSchema,

  companyName: z.string().nullable(),
  tradeName: z.string().nullable(),
  /** Registry status, e.g. `Active`. Null when nobody was asked. */
  status: z.string().nullable(),
  address: gstinAddressSchema.nullable(),
});

export type GstinLookup = z.infer<typeof gstinLookupSchema>;

/** City and state for a postal code. `found: false` means "type it yourself". */
export const postalLookupSchema = z.object({
  postalCode: z.string(),
  found: z.boolean(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  countryCode: z.string().nullable(),
  note: z.string().nullable(),
});

export type PostalLookup = z.infer<typeof postalLookupSchema>;
