/**
 * The wire contract for occupancy and extra-person pricing (F4).
 *
 * ===========================================================================
 * WHERE THIS SITS. The nightly BASE rate is decided by F1/F2/F3 — the
 * assignment default, a date override, or a seasonal/weekday/weekend rule.
 * F4 adds extra-guest charges on top of whatever that resolved to:
 *
 *     nightly total = resolved base rate + extra adults + extra children
 *
 * It never replaces or bypasses that resolution, and it does not alter F2's
 * override metadata or F3's source metadata. The occupancy breakdown is
 * returned separately, which is what lets the calendar keep showing the base
 * rate as the base rate.
 *
 * CONFIGURATION LIVES ON THE ASSIGNMENT, per (rate plan, room type), because
 * both axes vary: a corporate plan may absorb an extra adult the public plan
 * charges for, and a suite's extra bed is not priced like a standard room's.
 * The assignment already owned `baseOccupancy`, so F4 adds to it rather than
 * introducing a parallel record.
 *
 * PERCENTAGES ARE INTEGER BASIS POINTS — 100 = 1%, 10000 = 100%. Never a
 * float. A percentage stored as 0.125 is a rounding argument waiting to
 * happen (CLAUDE.md section 3.4), and basis points also make "12.5%"
 * expressible exactly.
 *
 * INFANTS ARE ACCEPTED, ECHOED, AND NEVER CHARGED. Not a new idea: the schema
 * already states the policy at `Reservation.infants` — they "do not consume
 * occupancy for rate or capacity purposes". F4 honours it rather than
 * inventing a competing one.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const extraGuestChargeKindSchema = z.enum(['FIXED', 'PERCENT']);

export type ExtraGuestChargeKind = z.infer<typeof extraGuestChargeKindSchema>;

export const EXTRA_GUEST_CHARGE_KIND_LABELS: Record<ExtraGuestChargeKind, string> = {
  FIXED: 'Fixed amount',
  PERCENT: 'Percent of base rate',
};

/** Mirrors the CHECK constraints in migration 20261110200000. */
export const MAX_FIXED_CHARGE_MINOR = 2_000_000_000;
export const MAX_PERCENT_BASIS_POINTS = 100_000;

/**
 * One extra-guest charge, discriminated by kind.
 *
 * A discriminated union rather than two optional fields, so "a FIXED charge
 * with a basis-point value" is unrepresentable rather than merely unwritten —
 * and so the bound can differ by kind, which it must: the units are not
 * comparable.
 */
export const extraGuestChargeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('FIXED'),
    /** Integer minor units per extra guest per night. Zero is valid. */
    value: z
      .number()
      .int('A fixed charge must be a whole number of minor units.')
      .min(0, 'A charge cannot be negative.')
      .max(MAX_FIXED_CHARGE_MINOR, 'That charge is implausibly large.'),
  }),
  z.object({
    kind: z.literal('PERCENT'),
    /** Integer basis points of the resolved base rate. 100 = 1%. */
    value: z
      .number()
      .int('A percentage must be whole basis points — 100 is 1%.')
      .min(0, 'A charge cannot be negative.')
      .max(MAX_PERCENT_BASIS_POINTS, 'A percentage charge may be at most 1000%.'),
  }),
]);

export type ExtraGuestCharge = z.infer<typeof extraGuestChargeSchema>;

/* -------------------------------------------------------------------------- */
/*  The configuration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The editable configuration.
 *
 * `baseOccupancy` is here because F4 is where it becomes meaningful and the
 * scope asks for it to stay editable per assigned room type. It is ALSO
 * settable through the rate-plan assignment endpoints from F2, and both paths
 * validate it the same way against the room type's `maxGuests` — the service
 * owns that rule, so the two surfaces cannot disagree.
 *
 * Every field is optional: this is a patch, and an operator who changes only
 * the adult charge should not have to restate the rest.
 */
export const updateOccupancyPricingRequestSchema = z
  .object({
    /** Total guests the base rate covers. Must not exceed `maxGuests`. */
    baseOccupancy: z.number().int().min(1, 'At least one guest.').max(20).optional(),
    /** How many of `baseOccupancy` may be children. A subset, not an addition. */
    includedChildren: z.number().int().min(0).max(20).optional(),
    /** False means no extra-guest charge applies at all. */
    enabled: z.boolean().optional(),
    adult: extraGuestChargeSchema.optional(),
    child: extraGuestChargeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to change.',
  })
  // Checked here when both arrive together; the service re-checks the MERGED
  // state, because changing only one of them can still break the invariant.
  .refine(
    (value) =>
      value.baseOccupancy === undefined ||
      value.includedChildren === undefined ||
      value.includedChildren <= value.baseOccupancy,
    {
      message: 'Included children cannot exceed the base occupancy.',
      path: ['includedChildren'],
    },
  );

export type UpdateOccupancyPricingRequest = z.infer<typeof updateOccupancyPricingRequestSchema>;

/** The room type's limits, echoed so the UI can bound its own inputs. */
export const occupancyCapacitySchema = z.object({
  maxGuests: z.number().int().positive(),
  /** Null means no separate adult limit; only `maxGuests` binds. */
  maxAdults: z.number().int().positive().nullable(),
});

export type OccupancyCapacity = z.infer<typeof occupancyCapacitySchema>;

export const occupancyPricingConfigSchema = z.object({
  ratePlanId: z.string().uuid(),
  ratePlanCode: z.string(),
  roomTypeId: z.string().uuid(),
  roomTypeCode: z.string(),
  roomTypeName: z.string(),
  /** The assignment's own default rate — the F1 figure, unchanged by F4. */
  defaultRateMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  baseOccupancy: z.number().int().positive(),
  includedChildren: z.number().int().nonnegative(),
  /** Derived: `baseOccupancy - includedChildren`. Sent so the UI need not. */
  includedAdults: z.number().int().nonnegative(),
  enabled: z.boolean(),
  adult: extraGuestChargeSchema,
  child: extraGuestChargeSchema,
  capacity: occupancyCapacitySchema,
  /** False when the plan is inactive or archived: the configuration is read-only. */
  isEditable: z.boolean(),
  updatedAt: z.string().datetime(),
});

export type OccupancyPricingConfig = z.infer<typeof occupancyPricingConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Preview                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Price one night for one guest composition.
 *
 * OPERATOR-FACING CONFIGURATION ONLY. It creates nothing, reserves nothing and
 * touches no reservation — it exists so somebody configuring extra-person
 * charges can see what they will do before saving. Reservation pricing stays
 * on its existing path until F9.
 *
 * `stayDate` is required rather than optional, because the base rate is a
 * property of a night: an F2 override or an F3 season changes it, and a
 * preview that averaged or guessed would be a preview of nothing. The server
 * resolves that night's base rate through the same F2/F3 resolver the calendar
 * uses.
 */
export const previewOccupancyPricingRequestSchema = z.object({
  roomTypeId: z.string().uuid('That is not a room-type id.'),
  stayDate: businessDateSchema,
  adults: z.number().int().min(1, 'A night needs at least one adult.').max(20),
  children: z.number().int().min(0).max(20).default(0),
  /** Never charged, never counted toward capacity. */
  infants: z.number().int().min(0).max(20).default(0),
});

export type PreviewOccupancyPricingRequest = z.infer<typeof previewOccupancyPricingRequestSchema>;

export const occupancyBreakdownLineSchema = z.object({
  label: z.string(),
  amountMinor: z.number().int(),
  detail: z.string(),
});

export type OccupancyBreakdownLine = z.infer<typeof occupancyBreakdownLineSchema>;

export const occupancyRefusalSchema = z.object({
  code: z.enum([
    'ADULTS_BELOW_ONE',
    'NEGATIVE_COUNT',
    'NON_INTEGER_COUNT',
    'EXCEEDS_MAX_GUESTS',
    'EXCEEDS_MAX_ADULTS',
    'INCLUDED_CHILDREN_EXCEED_BASE',
    'BASE_OCCUPANCY_EXCEEDS_CAPACITY',
    'AMOUNT_OUT_OF_RANGE',
    'TOTAL_OUT_OF_RANGE',
  ]),
  field: z.string().nullable(),
  message: z.string(),
});

export type OccupancyRefusal = z.infer<typeof occupancyRefusalSchema>;

export const occupancyPricingPreviewSchema = z.object({
  stayDate: businessDateSchema,
  roomTypeId: z.string().uuid(),
  currency: z.string().length(3),

  /**
   * The F2/F3 resolved base rate for this night, with its source.
   *
   * Carried through unchanged so a preview can say "₹4,500 because the
   * Christmas season applies" rather than presenting a number with no
   * provenance. These are the SAME values the calendar reports for that night;
   * F4 does not recompute or reinterpret them.
   */
  baseRateMinor: z.number().int().nonnegative(),
  baseRateSource: z.enum(['DATE_OVERRIDE', 'SEASONAL', 'WEEKDAY', 'WEEKEND', 'DEFAULT']),
  baseRateRuleName: z.string().nullable(),

  includedAdultCount: z.number().int().nonnegative(),
  includedChildCount: z.number().int().nonnegative(),
  extraAdultCount: z.number().int().nonnegative(),
  extraChildCount: z.number().int().nonnegative(),

  /** Per extra adult, per night — what a percentage resolved to. */
  adultUnitChargeMinor: z.number().int().nonnegative(),
  adultExtraChargeMinor: z.number().int().nonnegative(),
  childUnitChargeMinor: z.number().int().nonnegative(),
  childExtraChargeMinor: z.number().int().nonnegative(),
  totalExtraChargeMinor: z.number().int().nonnegative(),

  /** Base plus extras. A single night, never a stay total. */
  effectiveNightlyRateMinor: z.number().int().nonnegative(),

  /** Echoed so an operator can see infants were received and cost nothing. */
  infantCount: z.number().int().nonnegative(),

  /** Line-by-line, each stating its own arithmetic. Built server-side. */
  breakdown: z.array(occupancyBreakdownLineSchema),

  /**
   * Non-empty when the composition or configuration is unusable.
   *
   * A preview with refusals still returns the shape of the calculation, so the
   * UI can show the problem beside the figures — but the figures are not a
   * price until this is empty.
   */
  refusals: z.array(occupancyRefusalSchema),
});

export type OccupancyPricingPreview = z.infer<typeof occupancyPricingPreviewSchema>;
