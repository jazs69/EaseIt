/**
 * The wire contract for seasonal, weekday and weekend pricing rules (F3).
 *
 * ===========================================================================
 * THREE KINDS, ONE SHAPE. A season and a weekday rule differ only in how they
 * decide whether a night matches. So one request type covers all three, with a
 * discriminating `kind` and a refinement per kind — rather than three nearly
 * identical schemas that would drift the first time a field was added.
 *
 * The API exposes them under TWO route families, `/seasons` and
 * `/pricing-rules`, because an operator's mental model separates "Christmas"
 * from "Saturdays are dearer" even though the storage does not. The season
 * routes accept only `SEASONAL`; the pricing-rule routes accept only `WEEKDAY`
 * and `WEEKEND`. That is enforced server-side, not merely by convention.
 *
 * PRICES ARE PER ROOM TYPE, exactly as `RatePlanRoomType` holds the default. A
 * rule that priced every category the same could not express "Christmas:
 * Standard 2,500, Suite 7,000", which is the ordinary case.
 *
 * SEASON DATES ARE INCLUSIVE AT BOTH ENDS. This differs from stay ranges
 * elsewhere in the system, which are half-open because a departure day is
 * still sellable. A season is a set of nights an operator named: "20 December
 * through 10 January" means both of those nights.
 *
 * NOTHING SERVER-OWNED CROSSES THE WIRE INBOUND: no `propertyId`, no
 * `ratePlanId` in a body (it is a path parameter), no `id`, no timestamps, no
 * `createdByUserId`, no `isEnabled` (status is its own endpoint, so an edit can
 * never silently disable a rule).
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const ratePricingRuleKindSchema = z.enum(['SEASONAL', 'WEEKDAY', 'WEEKEND']);

export type RatePricingRuleKind = z.infer<typeof ratePricingRuleKindSchema>;

export const RATE_PRICING_RULE_KIND_LABELS: Record<RatePricingRuleKind, string> = {
  SEASONAL: 'Season',
  WEEKDAY: 'Weekday',
  WEEKEND: 'Weekend',
};

/**
 * 0 = Sunday … 6 = Saturday.
 *
 * Matching `Date.prototype.getUTCDay`, so there is no translation layer
 * between the wire, the resolver and the database to get wrong.
 */
export const dayOfWeekSchema = z.number().int().min(0).max(6);

export const DAY_OF_WEEK_LABELS: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

/** Short labels, for a seven-checkbox row that must fit on a phone. */
export const DAY_OF_WEEK_SHORT: Record<number, string> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
};

/**
 * One room type's price under a rule.
 *
 * Nonnegative. Zero is accepted on purpose — a complimentary or staff season
 * is priced at nothing, which is a real configuration rather than a mistake.
 * The bound lives here rather than on the shared money type for the same
 * reason `rackRateSchema` does: a folio line, a refund and a reversal are all
 * legitimately negative, so the floor belongs on the field that cannot be.
 */
export const ratePricingRulePriceInputSchema = z.object({
  roomTypeId: z.string().uuid('That is not a room-type id.'),
  amountMinor: z
    .number()
    .int('A rate must be a whole number of minor units.')
    .min(0, 'A rate cannot be negative.')
    .max(2_000_000_000, 'That rate is implausibly large.'),
});

export type RatePricingRulePriceInput = z.infer<typeof ratePricingRulePriceInputSchema>;

const pricesSchema = z
  .array(ratePricingRulePriceInputSchema)
  .min(1, 'Price at least one room type.')
  .max(50, 'A rule may price at most 50 room types.')
  .refine((entries) => new Set(entries.map((entry) => entry.roomTypeId)).size === entries.length, {
    message: 'The same room type is priced more than once.',
  });

/**
 * The fields common to every kind, before the per-kind refinement.
 *
 * `priority` defaults to 0. It only matters when two rules of the same kind
 * compete for the same night and room type: higher wins, and an equal-priority
 * collision is refused rather than resolved by row order.
 */
const ruleBodyShape = {
  name: z.string().trim().min(1, 'Give the rule a name.').max(120),
  priority: z.number().int().min(0).max(1000).default(0),
  prices: pricesSchema,
};

/**
 * Per-kind field coherence, applied to both create and update.
 *
 * A `SEASONAL` rule without dates would match nothing and be
 * indistinguishable from a bug; a `WEEKDAY` rule that also carried dates would
 * raise the question of which decides. The database refuses both
 * (`rate_pricing_rule_*_shape`); this refuses them earlier, with a field name
 * a form can mark.
 */
function refineKindShape(
  value: {
    // `| undefined` is spelled out rather than relying on `?`, because
    // `exactOptionalPropertyTypes` makes "absent" and "present but undefined"
    // different types — and a zod-inferred optional field is the second.
    startDate?: string | null | undefined;
    endDate?: string | null | undefined;
    daysOfWeek?: readonly number[] | undefined;
  },
  ctx: z.RefinementCtx,
  kind: RatePricingRuleKind,
): void {
  if (kind === 'SEASONAL') {
    if (value.startDate === undefined || value.startDate === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['startDate'],
        message: 'A season needs a start date.',
      });
    }
    if (value.endDate === undefined || value.endDate === null) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'A season needs an end date.' });
    }
    if (
      typeof value.startDate === 'string' &&
      typeof value.endDate === 'string' &&
      value.endDate < value.startDate
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'The season cannot end before it starts.',
      });
    }
    if (value.daysOfWeek !== undefined && value.daysOfWeek.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['daysOfWeek'],
        message: 'A season is a date range, not a set of weekdays.',
      });
    }
    return;
  }

  if (value.startDate !== undefined && value.startDate !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['startDate'],
      message: 'A recurring rule repeats; it carries no dates.',
    });
  }
  if (value.endDate !== undefined && value.endDate !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'A recurring rule repeats; it carries no dates.',
    });
  }

  if (kind === 'WEEKDAY') {
    if (value.daysOfWeek === undefined || value.daysOfWeek.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['daysOfWeek'],
        message: 'Choose at least one day of the week.',
      });
    }
    return;
  }

  // WEEKEND takes its days from the property's own configuration, so naming
  // them here would create a second, disagreeing answer.
  if (value.daysOfWeek !== undefined && value.daysOfWeek.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['daysOfWeek'],
      message: "A weekend rule uses the property's configured weekend days.",
    });
  }
}

export const createRatePricingRuleRequestSchema = z
  .object({
    kind: ratePricingRuleKindSchema,
    ...ruleBodyShape,
    /** SEASONAL only. Inclusive. */
    startDate: businessDateSchema.optional(),
    /** SEASONAL only. INCLUSIVE — the last night the season covers. */
    endDate: businessDateSchema.optional(),
    /** WEEKDAY only. */
    daysOfWeek: z
      .array(dayOfWeekSchema)
      .max(7)
      .refine((days) => new Set(days).size === days.length, {
        message: 'The same day is listed more than once.',
      })
      .default([]),
  })
  .superRefine((value, ctx) => {
    refineKindShape(value, ctx, value.kind);
  });

export type CreateRatePricingRuleRequest = z.infer<typeof createRatePricingRuleRequestSchema>;

/**
 * An edit. `kind` is NOT editable.
 *
 * Changing a season into a weekday rule is not an edit, it is a different
 * rule: every field that defines it would have to be replaced at once, and the
 * audit trail would record a mutation nobody could read. Delete and recreate.
 *
 * `isEnabled` is absent on purpose — status is its own endpoint, so an edit can
 * never disable a rule as a side effect of fixing its name.
 *
 * `prices` REPLACES the whole set when supplied. The service applies it as a
 * diff, so a room type present before and after keeps its row.
 */
export const updateRatePricingRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    startDate: businessDateSchema.optional(),
    endDate: businessDateSchema.optional(),
    daysOfWeek: z
      .array(dayOfWeekSchema)
      .max(7)
      .refine((days) => new Set(days).size === days.length, {
        message: 'The same day is listed more than once.',
      })
      .optional(),
    prices: pricesSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to change.',
  });

export type UpdateRatePricingRuleRequest = z.infer<typeof updateRatePricingRuleRequestSchema>;

/**
 * Enable or disable. A separate endpoint, like the rate plan's own status.
 *
 * Re-enabling runs the same conflict check a create does: a rule that was
 * disabled may have been disabled precisely because it collided with another,
 * and switching it back on must not resurrect the ambiguity.
 */
export const ratePricingRuleStatusSchema = z.object({
  action: z.enum(['ENABLE', 'DISABLE']),
});

export type RatePricingRuleStatusAction = z.infer<typeof ratePricingRuleStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  Views                                                                     */
/* -------------------------------------------------------------------------- */

export const ratePricingRulePriceSchema = z.object({
  roomTypeId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  amountMinor: z.number().int().nonnegative(),
});

export type RatePricingRulePriceView = z.infer<typeof ratePricingRulePriceSchema>;

export const ratePricingRuleSchema = z.object({
  id: z.string().uuid(),
  ratePlanId: z.string().uuid(),
  kind: ratePricingRuleKindSchema,
  name: z.string(),
  /** Non-null only for SEASONAL. Inclusive. */
  startDate: businessDateSchema.nullable(),
  /** Non-null only for SEASONAL. INCLUSIVE. */
  endDate: businessDateSchema.nullable(),
  /** Non-empty only for WEEKDAY. */
  daysOfWeek: z.array(dayOfWeekSchema),
  priority: z.number().int().nonnegative(),
  isEnabled: z.boolean(),
  prices: z.array(ratePricingRulePriceSchema),
  /** The property's currency. Every amount is in its minor unit. */
  currency: z.string().length(3),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RatePricingRuleView = z.infer<typeof ratePricingRuleSchema>;

export const ratePricingRuleListResponseSchema = z.object({
  items: z.array(ratePricingRuleSchema),
  currency: z.string().length(3),
  /**
   * The property's weekend days, echoed so the UI can label a WEEKEND rule
   * with what it actually means here rather than assuming Saturday–Sunday.
   */
  weekendDays: z.array(dayOfWeekSchema),
  /** False when the plan is inactive or archived: rules are read-only. */
  isEditable: z.boolean(),
});

export type RatePricingRuleListResponse = z.infer<typeof ratePricingRuleListResponseSchema>;

/** Filters for the list endpoints. */
export const listRatePricingRulesQuerySchema = z.object({
  kind: ratePricingRuleKindSchema.optional(),
  enabled: z.enum(['all', 'enabled', 'disabled']).default('all'),
  roomTypeId: z.string().uuid().optional(),
});

export type ListRatePricingRulesQuery = z.infer<typeof listRatePricingRulesQuerySchema>;
