/**
 * Promotion eligibility, selection and discount. Pure: no Nest, no Prisma,
 * no clock, no I/O (F5).
 *
 * ===========================================================================
 * WHERE F5 SITS. By the time anything here runs, the nightly amount is already
 * decided:
 *
 *   1. `rate-pricing.policy.ts` resolves the BASE rate (F2 override → F3
 *      seasonal → weekday → weekend → F1 assignment default).
 *   2. `occupancy-pricing.policy.ts` adds extra-adult and extra-child charges
 *      (F4).
 *   3. This file discounts the result.
 *
 * So the ELIGIBLE AMOUNT is the occupancy-adjusted nightly amount, which means
 * a percentage promotion discounts the extra-person charges along with the
 * room. That follows from the ordering the scope fixes — occupancy before
 * promotions — and it is the behaviour an operator expects from "20% off the
 * booking". A promotion never overwrites a base rate or an occupancy figure;
 * it only reduces their sum.
 *
 * PROMOTIONS DO NOT STACK. At most one applies to a night. Among eligible
 * candidates the highest `priority` wins; a tie is an AMBIGUITY, refused at
 * write time and reported — never resolved — at read time. Row order never
 * decides anything.
 *
 * EVERY DATE IS AN EXPLICIT INPUT. `bookingDate` and the stay dates are
 * passed in; this file reads no clock and knows nothing of
 * `Property.businessDate`, which is not advanced by anything yet. That is also
 * what makes the function reusable by F9 unchanged: a quote path supplies its
 * own dates.
 *
 * NO FLOATING-POINT MONEY. Percentages are integer basis points and the one
 * division is a single `Math.round` over an integer product (CLAUDE.md 3.4).
 * ===========================================================================
 */

export type CalendarDate = string;

export type PromotionDiscountKind = 'PERCENT' | 'FIXED_PER_NIGHT';

/** 100 basis points = 1%. */
export const BASIS_POINTS_PER_UNIT = 10_000;

/**
 * A discount may not exceed 100%.
 *
 * A night cannot cost less than nothing, and `computeDiscount` clamps to the
 * eligible amount regardless — so a higher cap would only let an operator
 * store a number that could never take effect. Mirrors the CHECK constraint.
 */
export const MAX_DISCOUNT_BASIS_POINTS = 10_000;
export const MAX_FIXED_DISCOUNT_MINOR = 2_000_000_000;

/** Matches F4's ceiling, so the two calculators agree on what is plausible. */
export const MAX_SAFE_AMOUNT_MINOR = 2_000_000_000;

/* -------------------------------------------------------------------------- */
/*  Promo-code normalisation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * THE normalised form of a promo code: trimmed, then upper-cased.
 *
 * One function, used by the writer that stores `codeNormalized`, by the lookup
 * that matches it, and asserted by the CHECK constraint
 * `promo_code_normalized_is_normalized` — which calls the same
 * `upper(btrim(...))` in SQL. Three places agreeing because they share one
 * definition, rather than three places that happen to agree today.
 *
 * `toUpperCase()` without a locale argument is deliberate: a locale-aware
 * upper-casing would make the Turkish dotless i fold differently from
 * Postgres's `upper()`, and a code that matched in SQL but not in TypeScript
 * is the worst kind of near-miss. Codes are restricted to ASCII by the DTO for
 * the same reason.
 */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

/** A promotion as the evaluator needs it, already scoped to one property. */
export interface PromotionCandidate {
  id: string;
  name: string;
  discountKind: PromotionDiscountKind;
  discountValue: number;
  priority: number;
  isActive: boolean;
  /** Inclusive; null means unbounded that side. */
  stayFromDate: CalendarDate | null;
  stayThroughDate: CalendarDate | null;
  bookFromDate: CalendarDate | null;
  bookThroughDate: CalendarDate | null;
  minNights: number | null;
  maxNights: number | null;
  minEligibleAmountMinor: number | null;
  appliesToAllRatePlans: boolean;
  appliesToAllRoomTypes: boolean;
  /** Meaningful only when the matching `appliesToAll*` flag is false. */
  ratePlanIds: readonly string[];
  roomTypeIds: readonly string[];
  maxRedemptions: number | null;
  redeemedCount: number;
  /**
   * The codes attached to this promotion, normalised.
   *
   * A promotion with at least one ACTIVE, unexpired code requires one to be
   * supplied. A promotion with none applies automatically.
   */
  codes: readonly {
    id: string;
    codeNormalized: string;
    isActive: boolean;
    expiresOn: CalendarDate | null;
    maxRedemptions: number | null;
    redeemedCount: number;
  }[];
}

export interface EligibilityContext {
  /** The date the booking is being made. ALWAYS explicit — never a clock. */
  bookingDate: CalendarDate;
  ratePlanId: string;
  roomTypeId: string;
  /** Every night of the stay, so a stay-window rule can be evaluated. */
  stayDates: readonly CalendarDate[];
  /** The stay's occupancy-adjusted, pre-discount, pre-tax total. */
  stayEligibleAmountMinor: number;
  /** Normalised. Null when the operator supplied none. */
  promoCodeNormalized: string | null;
}

export type IneligibilityCode =
  | 'INACTIVE'
  | 'OUTSIDE_BOOKING_WINDOW'
  | 'OUTSIDE_STAY_WINDOW'
  | 'RATE_PLAN_NOT_APPLICABLE'
  | 'ROOM_TYPE_NOT_APPLICABLE'
  | 'APPLIES_TO_NOTHING'
  | 'BELOW_MIN_NIGHTS'
  | 'ABOVE_MAX_NIGHTS'
  | 'BELOW_MIN_AMOUNT'
  | 'CODE_REQUIRED'
  | 'CODE_MISMATCH'
  | 'CODE_INACTIVE'
  | 'CODE_EXPIRED'
  | 'CODE_EXHAUSTED'
  | 'PROMOTION_EXHAUSTED';

export interface Ineligibility {
  code: IneligibilityCode;
  message: string;
}

export interface Eligibility {
  promotionId: string;
  promotionName: string;
  eligible: boolean;
  /** Empty when eligible. Every failed condition, not merely the first. */
  reasons: Ineligibility[];
  /** The code that matched, when one was required and supplied. */
  matchedCodeId: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Eligibility                                                               */
/* -------------------------------------------------------------------------- */

/** Inclusive-bound containment. `null` means unbounded that side. */
function withinWindow(
  date: CalendarDate,
  from: CalendarDate | null,
  through: CalendarDate | null,
): boolean {
  // String comparison is correct and total for `YYYY-MM-DD`, and avoids
  // constructing a Date only to compare it — the same approach F3 uses.
  if (from !== null && date < from) return false;
  if (through !== null && date > through) return false;
  return true;
}

/**
 * Evaluates one promotion against one stay.
 *
 * ALL failing conditions are collected, not just the first. An operator asking
 * "why didn't my promotion apply" is usually looking at two problems, and
 * reporting one at a time turns that into two round trips.
 *
 * STAY-WINDOW SEMANTICS: EVERY night of the stay must fall inside the stay
 * window. The alternative — any night — would let a three-night stay touching
 * one promotional night discount all three, which is not what "valid 20–25
 * December" means to the operator who typed it. This is stated because it is a
 * genuine choice, and because F9 must make the same one.
 */
export function evaluateEligibility(
  promotion: PromotionCandidate,
  context: EligibilityContext,
): Eligibility {
  const reasons: Ineligibility[] = [];
  let matchedCodeId: string | null = null;

  if (!promotion.isActive) {
    reasons.push({ code: 'INACTIVE', message: 'The promotion is not active.' });
  }

  if (!withinWindow(context.bookingDate, promotion.bookFromDate, promotion.bookThroughDate)) {
    reasons.push({
      code: 'OUTSIDE_BOOKING_WINDOW',
      message:
        `Bookings qualify ${describeWindow(promotion.bookFromDate, promotion.bookThroughDate)}, ` +
        `and this booking is dated ${context.bookingDate}.`,
    });
  }

  if (promotion.stayFromDate !== null || promotion.stayThroughDate !== null) {
    const outside = context.stayDates.filter(
      (date) => !withinWindow(date, promotion.stayFromDate, promotion.stayThroughDate),
    );
    if (outside.length > 0) {
      reasons.push({
        code: 'OUTSIDE_STAY_WINDOW',
        message:
          `Nights qualify ${describeWindow(promotion.stayFromDate, promotion.stayThroughDate)}; ` +
          `${String(outside.length)} night(s) of this stay fall outside, starting ${
            outside[0] ?? ''
          }. Every night must qualify.`,
      });
    }
  }

  // Applicability. The flag wins; the list is consulted only when it is false.
  // An empty list with a false flag means NOTHING qualifies — which is why it
  // is reported as its own reason rather than as a plan mismatch.
  const appliesToNothing =
    (!promotion.appliesToAllRatePlans && promotion.ratePlanIds.length === 0) ||
    (!promotion.appliesToAllRoomTypes && promotion.roomTypeIds.length === 0);

  if (appliesToNothing) {
    reasons.push({
      code: 'APPLIES_TO_NOTHING',
      message:
        'The promotion names no applicable rate plan or room type, so it can never apply. ' +
        'Choose "all", or list at least one of each.',
    });
  } else {
    if (!promotion.appliesToAllRatePlans && !promotion.ratePlanIds.includes(context.ratePlanId)) {
      reasons.push({
        code: 'RATE_PLAN_NOT_APPLICABLE',
        message: 'This rate plan is not one the promotion applies to.',
      });
    }
    if (!promotion.appliesToAllRoomTypes && !promotion.roomTypeIds.includes(context.roomTypeId)) {
      reasons.push({
        code: 'ROOM_TYPE_NOT_APPLICABLE',
        message: 'This room type is not one the promotion applies to.',
      });
    }
  }

  const nights = context.stayDates.length;
  if (promotion.minNights !== null && nights < promotion.minNights) {
    reasons.push({
      code: 'BELOW_MIN_NIGHTS',
      message: `Needs at least ${String(promotion.minNights)} nights; this stay is ${String(nights)}.`,
    });
  }
  if (promotion.maxNights !== null && nights > promotion.maxNights) {
    reasons.push({
      code: 'ABOVE_MAX_NIGHTS',
      message: `Applies to at most ${String(promotion.maxNights)} nights; this stay is ${String(nights)}.`,
    });
  }

  if (
    promotion.minEligibleAmountMinor !== null &&
    context.stayEligibleAmountMinor < promotion.minEligibleAmountMinor
  ) {
    reasons.push({
      code: 'BELOW_MIN_AMOUNT',
      message:
        `Needs a pre-tax stay total of at least ` +
        `${formatMinor(promotion.minEligibleAmountMinor)}; this stay is ` +
        `${formatMinor(context.stayEligibleAmountMinor)}.`,
    });
  }

  /**
   * Codes.
   *
   * A promotion with at least one usable code REQUIRES one — otherwise an
   * operator could claim a code-gated discount by not mentioning the code,
   * which defeats the gate. A promotion whose codes are all inactive or
   * expired behaves as code-gated-but-unusable rather than as automatic, for
   * the same reason: deactivating the last code must not silently open the
   * promotion to everybody.
   */
  const usableCodes = promotion.codes.filter(
    (code) =>
      code.isActive &&
      (code.expiresOn === null || context.bookingDate <= code.expiresOn) &&
      (code.maxRedemptions === null || code.redeemedCount < code.maxRedemptions),
  );

  if (promotion.codes.length > 0) {
    if (context.promoCodeNormalized === null) {
      reasons.push({
        code: 'CODE_REQUIRED',
        message: 'This promotion needs a promo code.',
      });
    } else {
      const supplied = promotion.codes.find(
        (code) => code.codeNormalized === context.promoCodeNormalized,
      );

      if (supplied === undefined) {
        reasons.push({
          code: 'CODE_MISMATCH',
          message: 'That code does not belong to this promotion.',
        });
      } else if (!supplied.isActive) {
        reasons.push({ code: 'CODE_INACTIVE', message: 'That code has been deactivated.' });
      } else if (supplied.expiresOn !== null && context.bookingDate > supplied.expiresOn) {
        reasons.push({
          code: 'CODE_EXPIRED',
          message: `That code expired on ${supplied.expiresOn}.`,
        });
      } else if (
        supplied.maxRedemptions !== null &&
        supplied.redeemedCount >= supplied.maxRedemptions
      ) {
        reasons.push({
          code: 'CODE_EXHAUSTED',
          message: 'That code has reached its redemption limit.',
        });
      } else {
        matchedCodeId = supplied.id;
      }
    }

    if (usableCodes.length === 0 && context.promoCodeNormalized === null) {
      reasons.push({
        code: 'CODE_INACTIVE',
        message: 'Every code for this promotion is inactive, expired or fully redeemed.',
      });
    }
  }

  /**
   * The promotion's own redemption ceiling.
   *
   * Reported here as an eligibility reason so a preview can say "fully
   * redeemed" — but F5 never CONSUMES a usage and `redeemedCount` is always
   * zero until F9 writes it. This check therefore does nothing today and is
   * present so the eligibility rule is complete, not as a working limiter.
   * The real enforcement is the conditional UPDATE documented in the
   * migration.
   */
  if (promotion.maxRedemptions !== null && promotion.redeemedCount >= promotion.maxRedemptions) {
    reasons.push({
      code: 'PROMOTION_EXHAUSTED',
      message: 'The promotion has reached its redemption limit.',
    });
  }

  return {
    promotionId: promotion.id,
    promotionName: promotion.name,
    eligible: reasons.length === 0,
    reasons,
    matchedCodeId: reasons.length === 0 ? matchedCodeId : null,
  };
}

function describeWindow(from: CalendarDate | null, through: CalendarDate | null): string {
  if (from === null && through === null) return 'at any time';
  if (from === null) return `up to and including ${through ?? ''}`;
  if (through === null) return `from ${from} onwards`;
  return `from ${from} to ${through} inclusive`;
}

/* -------------------------------------------------------------------------- */
/*  Selection                                                                 */
/* -------------------------------------------------------------------------- */

export interface Selection {
  /** Null when nothing qualified, or when the choice was ambiguous. */
  selectedPromotionId: string | null;
  selectedCodeId: string | null;
  isAmbiguous: boolean;
  /** The tying promotion ids, so the UI can name what needs resolving. */
  conflictingPromotionIds: readonly string[];
}

/**
 * Picks at most one promotion from the eligible candidates.
 *
 * Highest `priority` wins. A TIE IS AN AMBIGUITY, not a coin toss: the scope
 * forbids choosing by row order, and there is no other honest tiebreak — name
 * order would be arbitrary and `createdAt` would make the outcome depend on
 * configuration history rather than on configuration.
 *
 * When ambiguous, NOTHING is selected and no discount is applied. Write-time
 * refusal is the real control — two active same-priority promotions with
 * overlapping applicability cannot be stored through the API — so an ambiguity
 * here means a row written around the service. Applying no discount is the
 * safe direction: the guest is quoted the undiscounted price, which is
 * correctable, rather than a discount nobody can justify.
 */
export function selectPromotion(
  candidates: readonly { eligibility: Eligibility; priority: number }[],
): Selection {
  const eligible = candidates.filter((entry) => entry.eligibility.eligible);

  if (eligible.length === 0) {
    return {
      selectedPromotionId: null,
      selectedCodeId: null,
      isAmbiguous: false,
      conflictingPromotionIds: [],
    };
  }

  // Computed, not taken from input order: the caller's ordering must not be
  // able to change the answer.
  let best = eligible[0];
  for (const entry of eligible) {
    if (best === undefined || entry.priority > best.priority) best = entry;
  }
  if (best === undefined) {
    return {
      selectedPromotionId: null,
      selectedCodeId: null,
      isAmbiguous: false,
      conflictingPromotionIds: [],
    };
  }

  const tied = eligible.filter((entry) => entry.priority === best.priority);

  if (tied.length > 1) {
    return {
      selectedPromotionId: null,
      selectedCodeId: null,
      isAmbiguous: true,
      conflictingPromotionIds: tied.map((entry) => entry.eligibility.promotionId),
    };
  }

  return {
    selectedPromotionId: best.eligibility.promotionId,
    selectedCodeId: best.eligibility.matchedCodeId,
    isAmbiguous: false,
    conflictingPromotionIds: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  The discount                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The discount for ONE night, in minor units.
 *
 * ROUNDING: once, PER NIGHT, half-up, and only for `PERCENT`.
 *
 * `Math.round(eligible * bps / 10_000)` over integers. `eligible * bps` is at
 * most 2e9 × 1e4 = 2e13, comfortably inside `MAX_SAFE_INTEGER` (≈9e15), so the
 * product is exact and the single division is the only place a fraction can
 * appear. All inputs are nonnegative, so `Math.round` is half-up — the
 * documented property default in CLAUDE.md section 3.4.
 *
 * PER NIGHT RATHER THAN PER STAY, and the choice is deliberate and consistent
 * with F4's per-guest rounding. Section 3.4 requires a charge to be rounded
 * once when it is created, never a total computed from unrounded
 * intermediates — and a nightly discount is what a folio line will eventually
 * have to show, one line per night. The cost is that a 33.333% discount over
 * three nights may differ by a paisa from the same percentage applied to the
 * stay total. That divergence is visible and explicable; a stay-level figure
 * that cannot be decomposed into nightly lines is neither.
 *
 * F9 MUST USE THIS SAME FUNCTION so a quote and a folio agree.
 *
 * CLAMPED to the eligible amount, so a discount can never exceed what it
 * discounts and a night can never cost less than nothing. `FIXED_PER_NIGHT`
 * relies on this: a ₹5,000 fixed discount against a ₹3,000 night is ₹3,000,
 * not a ₹2,000 credit.
 */
export function computeDiscount(
  eligibleAmountMinor: number,
  kind: PromotionDiscountKind,
  value: number,
): number {
  if (eligibleAmountMinor <= 0) return 0;

  const raw =
    kind === 'PERCENT' ? Math.round((eligibleAmountMinor * value) / BASIS_POINTS_PER_UNIT) : value;

  // Never negative, never more than the amount it applies to.
  return Math.max(0, Math.min(raw, eligibleAmountMinor));
}

/** True when every intermediate and final figure is a safe, plausible integer. */
export function amountsAreSafe(...amounts: readonly number[]): boolean {
  return amounts.every(
    (amount) => Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_SAFE_AMOUNT_MINOR,
  );
}

/* -------------------------------------------------------------------------- */
/*  Write-time conflict detection                                             */
/* -------------------------------------------------------------------------- */

export interface PromotionConflict {
  existingPromotionId: string;
  existingPromotionName: string;
  priority: number;
  /** One thing the two share, for the message. */
  sharedRatePlanIds: readonly string[];
  sharedRoomTypeIds: readonly string[];
}

/**
 * A candidate promotion against those already stored, looking for the
 * ambiguity `selectPromotion` cannot resolve: both ACTIVE, same priority,
 * overlapping stay window, overlapping booking window, and intersecting
 * applicability on BOTH axes.
 *
 * ALL of those must hold. Relaxing any one would refuse legitimate
 * configuration:
 *
 *   * different priority   — that is precisely how an intended overlap is
 *                            resolved;
 *   * either inactive      — an inactive promotion participates in no
 *                            selection;
 *   * disjoint stay dates  — two promotions in different months never meet;
 *   * disjoint booking dates — nor do two with non-overlapping booking windows;
 *   * disjoint plans OR disjoint room types — a promotion on Deluxe and one on
 *                            Suite over the same fortnight are two ordinary
 *                            promotions.
 *
 * Note the applicability test needs BOTH axes to intersect, because a
 * promotion applies only where plan AND room type both match. Requiring just
 * one would refuse "20% off Deluxe on BAR" alongside "15% off Suite on BAR".
 *
 * A promotion that applies to nothing conflicts with nothing: it can never be
 * selected, so it can never tie. The service refuses to store one anyway.
 */
export function findPromotionConflicts(
  candidate: {
    id: string | null;
    isActive: boolean;
    priority: number;
    stayFromDate: CalendarDate | null;
    stayThroughDate: CalendarDate | null;
    bookFromDate: CalendarDate | null;
    bookThroughDate: CalendarDate | null;
    appliesToAllRatePlans: boolean;
    appliesToAllRoomTypes: boolean;
    ratePlanIds: readonly string[];
    roomTypeIds: readonly string[];
  },
  existing: readonly {
    id: string;
    name: string;
    isActive: boolean;
    priority: number;
    stayFromDate: CalendarDate | null;
    stayThroughDate: CalendarDate | null;
    bookFromDate: CalendarDate | null;
    bookThroughDate: CalendarDate | null;
    appliesToAllRatePlans: boolean;
    appliesToAllRoomTypes: boolean;
    ratePlanIds: readonly string[];
    roomTypeIds: readonly string[];
  }[],
): PromotionConflict[] {
  if (!candidate.isActive) return [];

  return existing.flatMap((other) => {
    if (candidate.id !== null && other.id === candidate.id) return [];
    if (!other.isActive) return [];
    if (other.priority !== candidate.priority) return [];

    if (
      !windowsOverlap(
        candidate.stayFromDate,
        candidate.stayThroughDate,
        other.stayFromDate,
        other.stayThroughDate,
      )
    ) {
      return [];
    }

    if (
      !windowsOverlap(
        candidate.bookFromDate,
        candidate.bookThroughDate,
        other.bookFromDate,
        other.bookThroughDate,
      )
    ) {
      return [];
    }

    const sharedRatePlanIds = intersect(
      candidate.appliesToAllRatePlans,
      candidate.ratePlanIds,
      other.appliesToAllRatePlans,
      other.ratePlanIds,
    );
    if (sharedRatePlanIds === null) return [];

    const sharedRoomTypeIds = intersect(
      candidate.appliesToAllRoomTypes,
      candidate.roomTypeIds,
      other.appliesToAllRoomTypes,
      other.roomTypeIds,
    );
    if (sharedRoomTypeIds === null) return [];

    return [
      {
        existingPromotionId: other.id,
        existingPromotionName: other.name,
        priority: other.priority,
        sharedRatePlanIds,
        sharedRoomTypeIds,
      },
    ];
  });
}

/**
 * Inclusive-window overlap, with `null` meaning unbounded.
 *
 * Two unbounded windows always overlap, which is correct: a promotion with no
 * dates runs always, and two such promotions at one priority genuinely tie.
 */
function windowsOverlap(
  aFrom: CalendarDate | null,
  aThrough: CalendarDate | null,
  bFrom: CalendarDate | null,
  bThrough: CalendarDate | null,
): boolean {
  if (aThrough !== null && bFrom !== null && aThrough < bFrom) return false;
  if (bThrough !== null && aFrom !== null && bThrough < aFrom) return false;
  return true;
}

/**
 * The shared members of two applicability sets, or `null` when they are
 * disjoint.
 *
 * "All" intersects everything, so an `appliesToAll` on either side means they
 * share whatever the other names — and two "all"s share everything, reported
 * as an empty array with a non-null result. `null` and `[]` therefore mean
 * different things here, which is why the return type is nullable rather than
 * an empty array standing in for "no overlap".
 */
function intersect(
  aAll: boolean,
  aIds: readonly string[],
  bAll: boolean,
  bIds: readonly string[],
): string[] | null {
  if (aAll && bAll) return [];
  if (aAll) return bIds.length > 0 ? [...bIds] : null;
  if (bAll) return aIds.length > 0 ? [...aIds] : null;

  const bSet = new Set(bIds);
  const shared = aIds.filter((id) => bSet.has(id));
  return shared.length > 0 ? shared : null;
}

/**
 * Minor units as a plain major-unit string, for a message.
 *
 * Deliberately NOT currency-formatted: this file is pure and must not depend
 * on a locale or a currency symbol. The client formats; this only has to be
 * unambiguous in the sentence it appears in. Same approach as F4's policy.
 */
function formatMinor(amountMinor: number): string {
  const major = amountMinor / 100;
  return Number.isInteger(major) ? String(major) : major.toFixed(2);
}
