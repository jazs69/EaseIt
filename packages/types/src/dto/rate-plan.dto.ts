/**
 * The wire contract for rate-plan configuration (scope F1).
 *
 * ===========================================================================
 * A rate plan is a named, sellable price list: "BAR", "Corporate", "Staff".
 * It carries one nightly figure and the set of room types it applies to.
 *
 * WHAT IT DOES NOT CARRY, AND WHY.
 *
 *   * **No per-date pricing.** The rate calendar is F2 and gets its own
 *     `rate_plan_day` table. `defaultRate` here is what a date with no such
 *     row will fall back to, which is why adding F2 does not reshape this.
 *   * **No restrictions** (MinLOS, CTA, CTD). F6/F7, and per-date.
 *   * **No derivation** from another plan. F8.
 *   * **No channel or company mapping.** Those are relations owned by
 *     `channels` and `companies`; `kind` below is a label, not a mechanism.
 *
 * NOTHING SERVER-OWNED CROSSES THE WIRE INBOUND: no `propertyId` (it comes
 * from the authenticated grant and the `:hotelId` path parameter), no `id`, no
 * timestamps, no `createdByUserId`, no `archivedAt` (CLAUDE.md section 5).
 * Activation and archival are their own endpoint, not fields on a patch, so
 * "rename this plan" and "stop selling it" can never be the same request.
 *
 * CURRENCY IS NOT SETTABLE. It is the property's own, resolved server-side.
 * The column exists on the row because section 3.4 requires every monetary
 * amount to travel with its currency, but accepting one from a client would
 * create a second answer to a question `Property.currency` already settles --
 * and a plan priced in a currency the property does not use is not a
 * configuration anyone wants to be able to express.
 * ===========================================================================
 */

import { z } from 'zod';

import { moneySchema } from '../money.js';

/**
 * Descriptive grouping only. Nothing branches on it.
 *
 * Deliberately NOT the distribution model: a corporate rate is a plan a
 * company is mapped to and an OTA rate is a plan a channel is mapped to, both
 * of which are relations in later scopes. This is the label an operator sorts
 * a long list by.
 */
export const ratePlanKindSchema = z.enum([
  'STANDARD',
  'CORPORATE',
  'PACKAGE',
  'PROMOTIONAL',
  'COMPLIMENTARY',
]);

export type RatePlanKind = z.infer<typeof ratePlanKindSchema>;

export const RATE_PLAN_KIND_LABELS: Record<RatePlanKind, string> = {
  STANDARD: 'Standard',
  CORPORATE: 'Corporate',
  PACKAGE: 'Package',
  PROMOTIONAL: 'Promotional',
  COMPLIMENTARY: 'Complimentary',
};

/**
 * The operator-facing short code, e.g. `BAR`. Unique within the property.
 *
 * Same alphabet and the same reasoning as `roomTypeCodeSchema`: it appears in
 * reports and will be what a channel mapping points at, so it has to survive
 * being read aloud and pasted into a spreadsheet.
 */
export const ratePlanCodeSchema = z
  .string()
  .trim()
  .min(1, 'Give the rate plan a short code.')
  .max(16, 'A code may be at most 16 characters.')
  .regex(/^[A-Z0-9_-]+$/, 'Use uppercase letters, digits, hyphen or underscore only.');

/**
 * A nightly rate: money that cannot be negative.
 *
 * `moneySchema` stays signed and is NOT changed by this -- a folio line, a
 * refund and a reversal are all legitimately negative, so the lower bound
 * belongs on the field that cannot be. This mirrors `rackRateSchema` exactly,
 * and for the same recorded reason: without it, a negative amount would reach
 * `rate_plan_default_rate_non_negative`, which is a CHECK violation rather
 * than a `P2002`, so it would not be translated at the repository boundary and
 * the caller would get an opaque 500 for an ordinary typo.
 *
 * Zero is accepted on purpose: a COMPLIMENTARY plan prices at nothing.
 */
export const ratePlanRateSchema = moneySchema.refine((value) => value.amountMinor >= 0, {
  message: 'A rate cannot be negative.',
  path: ['amountMinor'],
});

/**
 * One room-type assignment, carrying ITS OWN default rate.
 *
 * ===========================================================================
 * THIS IS THE F2 CORRECTION. F1 put a single `defaultRate` on the plan, which
 * could not express "BAR = 1,500 for Standard, 2,500 for Deluxe, 4,000 for
 * Suite" — the ordinary case. The price now belongs to the (plan, room type)
 * pair, so editing one category's rate provably cannot touch another's: they
 * are different rows.
 *
 * The currency is NOT part of this. It is the plan's, which is the property's;
 * see the file header.
 * ===========================================================================
 */
export const ratePlanRoomTypeAssignmentSchema = z.object({
  roomTypeId: z.string().uuid('That is not a room-type id.'),
  /** Integer minor units. Nonnegative; zero is legal for a complimentary plan. */
  defaultRate: ratePlanRateSchema,
  baseOccupancy: z.number().int().min(1).max(20).default(2),
});

export type RatePlanRoomTypeAssignment = z.infer<typeof ratePlanRoomTypeAssignmentSchema>;

/**
 * The room types a plan applies to, each with its own price.
 *
 * At least one: a plan that applies to no category cannot be sold and is
 * indistinguishable from a draft, which this scope does not model. Duplicates
 * are refused rather than silently de-duplicated, because a client sending the
 * same id twice is a client with a bug — and which of the two prices it meant
 * would be anybody's guess.
 */
const assignmentsSchema = z
  .array(ratePlanRoomTypeAssignmentSchema)
  .min(1, 'Choose at least one room type and give it a rate.')
  .max(50, 'A plan may apply to at most 50 room types.')
  .refine((entries) => new Set(entries.map((entry) => entry.roomTypeId)).size === entries.length, {
    message: 'The same room type is listed more than once.',
  });

export const createRatePlanRequestSchema = z.object({
  code: ratePlanCodeSchema,
  name: z.string().trim().min(1, 'Give the rate plan a name.').max(120),
  description: z.string().trim().max(2000).optional(),
  kind: ratePlanKindSchema.default('STANDARD'),
  /**
   * One entry per room type, each with its own rate in integer minor units.
   * Every currency must equal the property's own; the service refuses a
   * mismatch rather than converting, because silently converting money is how
   * a rate becomes wrong by a factor of eighty.
   */
  roomTypes: assignmentsSchema,
  sortOrder: z.number().int().min(0).max(999).default(0),
});

export type CreateRatePlanRequest = z.infer<typeof createRatePlanRequestSchema>;

/**
 * Everything except `code`, and except the status.
 *
 * `code` is the plan's operator-facing identity, quoted in reports and the
 * thing a future channel mapping will point at, so renaming it would orphan
 * those references. A plan that needs a different code is a different plan.
 *
 * `isActive` and `archivedAt` are absent on purpose: status changes are their
 * own endpoint, so an edit can never deactivate a plan as a side effect of
 * fixing its description.
 *
 * `roomTypes` here REPLACES the whole set, which is why it is optional: omit
 * it and the assignments are untouched; send it and they become exactly what
 * you sent. A replace rather than add/remove deltas because the set is small,
 * the UI edits it as a whole, and two concurrent deltas against one plan would
 * produce an order-dependent result with no way to detect it.
 *
 * IMPORTANT — the replace is applied as a DIFF by the service, not as
 * delete-then-reinsert. An assignment that appears in both the old and new set
 * keeps its row, and therefore keeps its date-wise overrides. Only an
 * assignment genuinely removed loses its calendar, which is correct (the plan
 * no longer prices that category) and which the UI confirms first.
 */
export const updateRatePlanRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    kind: ratePlanKindSchema.optional(),
    roomTypes: assignmentsSchema.optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to change.',
  });

export type UpdateRatePlanRequest = z.infer<typeof updateRatePlanRequestSchema>;

/**
 * A status change, as a discriminated action rather than a boolean patch.
 *
 * `ARCHIVE` is terminal and also deactivates, which the database asserts
 * (`rate_plan_archived_implies_inactive`). There is no `UNARCHIVE`: archival
 * means the plan is out of use for good, and a plan that might come back
 * should be deactivated instead. There is also no delete -- see the model
 * comment: a plan that has ever been quoted is history.
 */
export const ratePlanStatusActionSchema = z.object({
  action: z.enum(['ACTIVATE', 'DEACTIVATE', 'ARCHIVE']),
});

export type RatePlanStatusAction = z.infer<typeof ratePlanStatusActionSchema>;

/**
 * A room type as it appears inside a rate plan, WITH its own default rate.
 *
 * `overrideCount` is how many nights the operator has priced differently under
 * this plan for this category. It is here so the UI can warn before removing
 * an assignment — doing so cascades those overrides away — rather than
 * discovering the loss afterwards.
 */
export const ratePlanRoomTypeSchema = z.object({
  roomTypeId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  defaultRate: ratePlanRateSchema,
  baseOccupancy: z.number().int().positive(),
  overrideCount: z.number().int().nonnegative(),
});

export type RatePlanRoomTypeView = z.infer<typeof ratePlanRoomTypeSchema>;

export const ratePlanSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: ratePlanKindSchema,
  /**
   * The plan's currency, which is the property's.
   *
   * There is deliberately no plan-level `defaultRate` here any more: F2 moved
   * pricing onto each entry of `roomTypes`, and keeping a plan-level figure
   * would be a second, ambiguous source of truth for a price.
   */
  currency: z.string().length(3),
  isActive: z.boolean(),
  /** ISO-8601 UTC instant, or null when the plan is not archived. */
  archivedAt: z.string().datetime().nullable(),
  sortOrder: z.number().int().nonnegative(),
  roomTypes: z.array(ratePlanRoomTypeSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RatePlanView = z.infer<typeof ratePlanSchema>;

export const ratePlanListResponseSchema = z.object({
  items: z.array(ratePlanSchema),
  /**
   * The property's currency, echoed once rather than per plan.
   *
   * The create form needs it — the client never chooses a currency — and
   * sending it with the list saves the UI a second request to property setup
   * just to render a money input.
   */
  currency: z.string().length(3),
});

export type RatePlanListResponse = z.infer<typeof ratePlanListResponseSchema>;

/** Filters for the list endpoint. All optional; none widens tenancy. */
export const listRatePlansQuerySchema = z.object({
  /** `active` and `inactive` both exclude archived plans. */
  status: z.enum(['all', 'active', 'inactive', 'archived']).default('active'),
  kind: ratePlanKindSchema.optional(),
  /** Matches code or name, case-insensitively. */
  search: z.string().trim().max(120).optional(),
  roomTypeId: z.string().uuid().optional(),
});

export type ListRatePlansQuery = z.infer<typeof listRatePlansQuerySchema>;

/**
 * Update ONE room type's default rate within a plan (F2 requirement 4D).
 *
 * A dedicated endpoint rather than a whole-plan patch, because the operator
 * action is "Deluxe is now 2,900" and nothing else should be at risk. In
 * particular this never touches date-wise overrides: the default is the
 * fallback for nights that have no override, so changing it leaves every
 * deliberately-priced night exactly as it was.
 */
export const updateRatePlanRoomTypeRequestSchema = z
  .object({
    defaultRate: ratePlanRateSchema.optional(),
    baseOccupancy: z.number().int().min(1).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to change.',
  });

export type UpdateRatePlanRoomTypeRequest = z.infer<typeof updateRatePlanRoomTypeRequestSchema>;
