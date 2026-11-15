/**
 * The wire contract for promotions, promo codes and discounts (F5).
 *
 * ===========================================================================
 * WHERE F5 SITS. The nightly amount is decided before a promotion is
 * considered: F1/F2/F3 resolve the base rate, F4 adds extra-person charges,
 * and F5 discounts the result. So the ELIGIBLE AMOUNT is the
 * occupancy-adjusted nightly amount — a percentage promotion therefore
 * discounts the extra-person charges along with the room, which follows from
 * that ordering and is what "20% off the booking" means.
 *
 * PROMOTIONS DO NOT STACK. At most one applies, by highest priority; a tie is
 * refused at write time and reported, never resolved, at read time.
 *
 * APPLICABILITY IS EXPLICIT. `appliesToAllRatePlans` / `appliesToAllRoomTypes`
 * are booleans; the id lists are consulted only when the matching flag is
 * false, and an empty list then means NOTHING qualifies. An empty relation
 * never silently means "all" — the trap this contract exists to avoid.
 *
 * EVERY AMOUNT IS AN INTEGER MINOR UNIT; every percentage is integer basis
 * points (100 = 1%). No float touches money or a rate (CLAUDE.md 3.4).
 *
 * DATES ARE CALENDAR DATES, INCLUSIVE AT BOTH ENDS, `null` meaning unbounded.
 * `bookingDate` is always an explicit input — nothing here reads a clock, and
 * `Property.businessDate` is deliberately not consulted because nothing
 * advances it yet.
 *
 * NOTHING SERVER-OWNED CROSSES THE WIRE INBOUND: no `propertyId`, no `id`, no
 * timestamps, no `createdByUserId`, and no `redeemedCount` — redemption
 * counters are server state consumed by F9, never client input (section 5).
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const promotionDiscountKindSchema = z.enum(['PERCENT', 'FIXED_PER_NIGHT']);

export type PromotionDiscountKind = z.infer<typeof promotionDiscountKindSchema>;

export const PROMOTION_DISCOUNT_KIND_LABELS: Record<PromotionDiscountKind, string> = {
  PERCENT: 'Percentage off',
  FIXED_PER_NIGHT: 'Fixed amount off, per night',
};

/** Mirrors the CHECK constraints in migration 20261110230000. */
export const MAX_DISCOUNT_BASIS_POINTS = 10_000;
export const MAX_FIXED_DISCOUNT_MINOR = 2_000_000_000;

/** The widest stay window a preview may ask for, matching the rate calendar. */
export const MAX_PROMOTION_PREVIEW_NIGHTS = 90;

/**
 * The discount, discriminated by kind.
 *
 * A discriminated union rather than two optional fields, so "a fixed amount
 * expressed in basis points" is unrepresentable — and so the bound can differ
 * by kind, which it must, because the units are not comparable.
 *
 * `PERCENT` is capped at 100%: a night cannot cost less than nothing, and the
 * calculator clamps to the eligible amount anyway, so a higher cap would only
 * store a number that can never take effect.
 */
export const promotionDiscountSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('PERCENT'),
    /** Integer basis points. 100 = 1%, 10000 = 100%. */
    value: z
      .number()
      .int('A percentage must be whole basis points — 100 is 1%.')
      .min(0, 'A discount cannot be negative.')
      .max(MAX_DISCOUNT_BASIS_POINTS, 'A percentage discount may be at most 100%.'),
  }),
  z.object({
    kind: z.literal('FIXED_PER_NIGHT'),
    /** Integer minor units, deducted from EACH eligible night. */
    value: z
      .number()
      .int('A fixed discount must be a whole number of minor units.')
      .min(0, 'A discount cannot be negative.')
      .max(MAX_FIXED_DISCOUNT_MINOR, 'That discount is implausibly large.'),
  }),
]);

export type PromotionDiscount = z.infer<typeof promotionDiscountSchema>;

/**
 * A promo code as entered.
 *
 * ASCII alphanumerics plus `-` and `_`, deliberately narrow. The normalised
 * form is `upper(trim(code))`, asserted by a CHECK constraint that calls
 * Postgres's own `upper()`; restricting to ASCII is what guarantees the
 * TypeScript `toUpperCase()` and the SQL `upper()` agree, which they do not
 * for the Turkish dotless i. A code that matched in the database but not in
 * the application would be the worst kind of near-miss.
 */
export const promoCodeSchema = z
  .string()
  .trim()
  .min(3, 'A code needs at least three characters.')
  .max(32, 'A code may be at most 32 characters.')
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphen or underscore only.');

/* -------------------------------------------------------------------------- */
/*  Promotion configuration                                                   */
/* -------------------------------------------------------------------------- */

const promotionWindowShape = {
  /** Which NIGHTS qualify. Inclusive; omit for unbounded. */
  stayFromDate: businessDateSchema.nullable().default(null),
  stayThroughDate: businessDateSchema.nullable().default(null),
  /** WHEN the booking may be made. Inclusive; omit for unbounded. */
  bookFromDate: businessDateSchema.nullable().default(null),
  bookThroughDate: businessDateSchema.nullable().default(null),
};

const promotionConditionShape = {
  /**
   * Stay-length eligibility conditions.
   *
   * These gate THIS promotion only. They are not the F6 restriction engine and
   * restrict nothing else about the stay — a stay shorter than `minNights` is
   * perfectly bookable, it simply does not get this discount.
   */
  minNights: z.number().int().min(1).max(365).nullable().default(null),
  maxNights: z.number().int().min(1).max(365).nullable().default(null),
  /** The stay's pre-discount, pre-tax total must reach this. Minor units. */
  minEligibleAmountMinor: z.number().int().min(0).nullable().default(null),
};

/**
 * Applicability, with the flag and the list always travelling together.
 *
 * An empty list with its flag false means the promotion applies to nothing.
 * The service REFUSES that, so the state is unreachable through the API — but
 * the eligibility calculator still reports it, because a row written around
 * the service can hold it.
 */
const applicabilityShape = {
  appliesToAllRatePlans: z.boolean(),
  ratePlanIds: z
    .array(z.string().uuid('That is not a rate-plan id.'))
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'The same rate plan is listed more than once.',
    })
    .default([]),
  appliesToAllRoomTypes: z.boolean(),
  roomTypeIds: z
    .array(z.string().uuid('That is not a room-type id.'))
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'The same room type is listed more than once.',
    })
    .default([]),
};

/** Ordered windows, checked here so a form marks the right field. */
function refineWindows(
  value: {
    stayFromDate?: string | null | undefined;
    stayThroughDate?: string | null | undefined;
    bookFromDate?: string | null | undefined;
    bookThroughDate?: string | null | undefined;
    minNights?: number | null | undefined;
    maxNights?: number | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    typeof value.stayFromDate === 'string' &&
    typeof value.stayThroughDate === 'string' &&
    value.stayThroughDate < value.stayFromDate
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['stayThroughDate'],
      message: 'The stay window cannot end before it starts.',
    });
  }
  if (
    typeof value.bookFromDate === 'string' &&
    typeof value.bookThroughDate === 'string' &&
    value.bookThroughDate < value.bookFromDate
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['bookThroughDate'],
      message: 'The booking window cannot end before it starts.',
    });
  }
  if (
    typeof value.minNights === 'number' &&
    typeof value.maxNights === 'number' &&
    value.maxNights < value.minNights
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxNights'],
      message: 'The maximum nights cannot be below the minimum.',
    });
  }
}

export const createPromotionRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the promotion a name.').max(120),
    description: z.string().trim().max(2000).optional(),
    discount: promotionDiscountSchema,
    priority: z.number().int().min(0).max(1000).default(0),
    ...promotionWindowShape,
    ...promotionConditionShape,
    ...applicabilityShape,
    /** Null means unlimited. Enforced by F9, not by F5. */
    maxRedemptions: z.number().int().min(1).nullable().default(null),
  })
  .superRefine(refineWindows);

export type CreatePromotionRequest = z.infer<typeof createPromotionRequestSchema>;

/**
 * An edit.
 *
 * `isActive` is absent on purpose — status has its own endpoint, so an edit can
 * never deactivate a promotion as a side effect of fixing its description.
 * Redemption counters are absent because they are server state.
 *
 * Supplying `ratePlanIds` or `roomTypeIds` REPLACES that set; the service
 * applies it as a diff so an unchanged row keeps its identity.
 */
export const updatePromotionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    discount: promotionDiscountSchema.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    stayFromDate: businessDateSchema.nullable().optional(),
    stayThroughDate: businessDateSchema.nullable().optional(),
    bookFromDate: businessDateSchema.nullable().optional(),
    bookThroughDate: businessDateSchema.nullable().optional(),
    minNights: z.number().int().min(1).max(365).nullable().optional(),
    maxNights: z.number().int().min(1).max(365).nullable().optional(),
    minEligibleAmountMinor: z.number().int().min(0).nullable().optional(),
    appliesToAllRatePlans: z.boolean().optional(),
    ratePlanIds: z.array(z.string().uuid()).max(50).optional(),
    appliesToAllRoomTypes: z.boolean().optional(),
    roomTypeIds: z.array(z.string().uuid()).max(50).optional(),
    maxRedemptions: z.number().int().min(1).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to change.',
  })
  .superRefine(refineWindows);

export type UpdatePromotionRequest = z.infer<typeof updatePromotionRequestSchema>;

/**
 * Activate or deactivate.
 *
 * ACTIVATING re-runs the conflict check: a promotion may have been deactivated
 * precisely because it tied with another, and switching it back on must not
 * resurrect an ambiguity the resolver cannot resolve.
 */
export const promotionStatusSchema = z.object({
  action: z.enum(['ACTIVATE', 'DEACTIVATE']),
});

export type PromotionStatusAction = z.infer<typeof promotionStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  Promo codes                                                               */
/* -------------------------------------------------------------------------- */

export const createPromoCodeRequestSchema = z.object({
  code: promoCodeSchema,
  /** Inclusive — the last calendar date the code may be used. */
  expiresOn: businessDateSchema.nullable().default(null),
  /** Null means unlimited. Enforced by F9, not by F5. */
  maxRedemptions: z.number().int().min(1).nullable().default(null),
});

export type CreatePromoCodeRequest = z.infer<typeof createPromoCodeRequestSchema>;

export const promoCodeStatusSchema = z.object({
  action: z.enum(['ACTIVATE', 'DEACTIVATE']),
  /** Optionally set or clear the expiry in the same call. */
  expiresOn: businessDateSchema.nullable().optional(),
});

export type PromoCodeStatusAction = z.infer<typeof promoCodeStatusSchema>;

export const promoCodeViewSchema = z.object({
  id: z.string().uuid(),
  /** As entered, for display. Matching always uses the normalised form. */
  code: z.string(),
  isActive: z.boolean(),
  expiresOn: businessDateSchema.nullable(),
  maxRedemptions: z.number().int().nullable(),
  /** Always 0 in F5: nothing consumes a usage until F9. */
  redeemedCount: z.number().int().nonnegative(),
  /** Null when `maxRedemptions` is null, i.e. unlimited. */
  remainingRedemptions: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PromoCodeView = z.infer<typeof promoCodeViewSchema>;

export const promoCodeListResponseSchema = z.object({
  items: z.array(promoCodeViewSchema),
});

export type PromoCodeListResponse = z.infer<typeof promoCodeListResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Views                                                                     */
/* -------------------------------------------------------------------------- */

/** A referenced rate plan or room type, named so the UI need not look it up. */
export const promotionTargetSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
});

export type PromotionTarget = z.infer<typeof promotionTargetSchema>;

export const promotionViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  discount: promotionDiscountSchema,
  priority: z.number().int().nonnegative(),
  isActive: z.boolean(),
  stayFromDate: businessDateSchema.nullable(),
  stayThroughDate: businessDateSchema.nullable(),
  bookFromDate: businessDateSchema.nullable(),
  bookThroughDate: businessDateSchema.nullable(),
  minNights: z.number().int().nullable(),
  maxNights: z.number().int().nullable(),
  minEligibleAmountMinor: z.number().int().nullable(),
  appliesToAllRatePlans: z.boolean(),
  appliesToAllRoomTypes: z.boolean(),
  /** Empty when the matching `appliesToAll*` flag is true. */
  ratePlans: z.array(promotionTargetSchema),
  roomTypes: z.array(promotionTargetSchema),
  maxRedemptions: z.number().int().nullable(),
  /** Always 0 in F5: nothing consumes a usage until F9. */
  redeemedCount: z.number().int().nonnegative(),
  remainingRedemptions: z.number().int().nonnegative().nullable(),
  /** How many codes exist, and how many are usable today. */
  codeCount: z.number().int().nonnegative(),
  /**
   * True when this promotion requires a code — i.e. it has at least one.
   * A promotion with no codes applies automatically to any eligible stay.
   */
  requiresCode: z.boolean(),
  /** The property's currency. Every amount is in its minor unit. */
  currency: z.string().length(3),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PromotionView = z.infer<typeof promotionViewSchema>;

export const promotionListResponseSchema = z.object({
  items: z.array(promotionViewSchema),
  currency: z.string().length(3),
});

export type PromotionListResponse = z.infer<typeof promotionListResponseSchema>;

export const listPromotionsQuerySchema = z.object({
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  /** Matches the name, case-insensitively. */
  search: z.string().trim().max(120).optional(),
});

export type ListPromotionsQuery = z.infer<typeof listPromotionsQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Preview                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Price a stay and show which promotion applies — read-only.
 *
 * NO REDEMPTION IS CONSUMED, NO COUNTER MOVES, NOTHING IS WRITTEN. Previewing
 * is a calculation over stored configuration; the redemption lifecycle belongs
 * to F9 and is documented in the migration.
 *
 * `bookingDate` is REQUIRED, not defaulted. The booking window is part of
 * eligibility, so a preview that guessed the booking date would answer a
 * question nobody asked — and `Property.businessDate` is deliberately not
 * substituted, because nothing advances it yet. The operator states the date.
 */
export const previewPromotionRequestSchema = z
  .object({
    ratePlanId: z.string().uuid('That is not a rate-plan id.'),
    roomTypeId: z.string().uuid('That is not a room-type id.'),
    /** First night, inclusive. */
    arrivalDate: businessDateSchema,
    /** Departure, EXCLUSIVE — the stay's nights are arrival..departure-1. */
    departureDate: businessDateSchema,
    /** The date the booking is treated as being made on. Explicit. */
    bookingDate: businessDateSchema,
    adults: z.number().int().min(1, 'A night needs at least one adult.').max(20),
    children: z.number().int().min(0).max(20).default(0),
    /** Never charged, never counted toward capacity (F4's existing policy). */
    infants: z.number().int().min(0).max(20).default(0),
    /** Optional. Normalised server-side before matching. */
    promoCode: promoCodeSchema.nullable().default(null),
  })
  .refine((value) => value.departureDate > value.arrivalDate, {
    message: 'Departure must be after arrival — a stay is at least one night.',
    path: ['departureDate'],
  });

export type PreviewPromotionRequest = z.infer<typeof previewPromotionRequestSchema>;

export const promotionCandidateSchema = z.object({
  promotionId: z.string().uuid(),
  promotionName: z.string(),
  priority: z.number().int().nonnegative(),
  eligible: z.boolean(),
  /** Empty when eligible. Every failed condition, not merely the first. */
  reasons: z.array(
    z.object({
      code: z.enum([
        'INACTIVE',
        'OUTSIDE_BOOKING_WINDOW',
        'OUTSIDE_STAY_WINDOW',
        'RATE_PLAN_NOT_APPLICABLE',
        'ROOM_TYPE_NOT_APPLICABLE',
        'APPLIES_TO_NOTHING',
        'BELOW_MIN_NIGHTS',
        'ABOVE_MAX_NIGHTS',
        'BELOW_MIN_AMOUNT',
        'CODE_REQUIRED',
        'CODE_MISMATCH',
        'CODE_INACTIVE',
        'CODE_EXPIRED',
        'CODE_EXHAUSTED',
        'PROMOTION_EXHAUSTED',
      ]),
      message: z.string(),
    }),
  ),
});

export type PromotionCandidateView = z.infer<typeof promotionCandidateSchema>;

/** One night of the preview. Pre-tax throughout. */
export const promotionPreviewNightSchema = z.object({
  stayDate: businessDateSchema,
  /** F2/F3 resolved base rate, carried through unchanged. */
  baseRateMinor: z.number().int().nonnegative(),
  baseRateSource: z.enum(['DATE_OVERRIDE', 'SEASONAL', 'WEEKDAY', 'WEEKEND', 'DEFAULT']),
  baseRateRuleName: z.string().nullable(),
  /** F4 occupancy charges, carried through unchanged. */
  adultExtraChargeMinor: z.number().int().nonnegative(),
  childExtraChargeMinor: z.number().int().nonnegative(),
  /** base + extras. The amount a discount applies to. */
  occupancyAdjustedMinor: z.number().int().nonnegative(),
  /** F5. Zero when nothing applied. */
  discountMinor: z.number().int().nonnegative(),
  /** occupancyAdjusted − discount. Pre-tax. */
  finalNightlyMinor: z.number().int().nonnegative(),
});

export type PromotionPreviewNight = z.infer<typeof promotionPreviewNightSchema>;

export const promotionPreviewSchema = z.object({
  ratePlanId: z.string().uuid(),
  roomTypeId: z.string().uuid(),
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  bookingDate: businessDateSchema,
  nights: z.number().int().positive(),
  currency: z.string().length(3),

  /** Every night, in order. */
  perNight: z.array(promotionPreviewNightSchema),

  /** Stay totals, all pre-tax. */
  baseTotalMinor: z.number().int().nonnegative(),
  extraGuestTotalMinor: z.number().int().nonnegative(),
  occupancyAdjustedTotalMinor: z.number().int().nonnegative(),
  discountTotalMinor: z.number().int().nonnegative(),
  finalTotalMinor: z.number().int().nonnegative(),

  /** Every promotion considered, eligible or not, with reasons. */
  candidates: z.array(promotionCandidateSchema),
  /** Null when nothing qualified or the choice was ambiguous. */
  selectedPromotionId: z.string().uuid().nullable(),
  selectedPromotionName: z.string().nullable(),
  selectedDiscount: promotionDiscountSchema.nullable(),
  /** The code that matched, when one was required. Never the raw code value. */
  selectedCodeId: z.string().uuid().nullable(),

  /**
   * True when two eligible promotions tied on priority.
   *
   * NOTHING is applied in that case — the undiscounted price is quoted, which
   * is correctable, rather than a discount nobody can justify. Write-time
   * refusal means this can only arise from a row written around the service.
   */
  isAmbiguous: z.boolean(),
  conflictingPromotionIds: z.array(z.string().uuid()),

  /** F4 refusals, carried through: a composition exceeding room capacity. */
  occupancyRefusals: z.array(
    z.object({ code: z.string(), field: z.string().nullable(), message: z.string() }),
  ),
});

export type PromotionPreview = z.infer<typeof promotionPreviewSchema>;
