/**
 * Occupancy and extra-person pricing. Pure: no Nest, no Prisma, no I/O (F4).
 *
 * ===========================================================================
 * THIS IS NOT A SECOND RESOLVER. The nightly BASE rate is decided entirely by
 * `rate-pricing.policy.ts` — override → seasonal → weekday → weekend →
 * default — and this file never participates in that. It takes the base rate
 * that resolver produced and adds extra-guest charges on top:
 *
 *     nightly total = resolved base rate
 *                   + extra adults × adult charge
 *                   + extra children × child charge
 *
 * So F4 extends the hierarchy rather than entering it. An F2 override or an F3
 * rule changes the base, and therefore changes any PERCENT charge computed
 * from it, which is the point of expressing a charge as a percentage. A FIXED
 * charge is an absolute amount and never inherits the base rate.
 *
 * GUEST ALLOCATION — the chosen interpretation, stated once.
 *
 *     includedAdults   = baseOccupancy − includedChildren
 *     extraAdults      = max(0, adults   − includedAdults)
 *     extraChildren    = max(0, children − includedChildren)
 *
 * `baseOccupancy` is the TOTAL headcount the base rate covers, and
 * `includedChildren` says how many of those may be children. F1's schema
 * comment already defined `baseOccupancy` as "the occupancy
 * `defaultRateMinor` assumes", so reading it as a total — rather than as an
 * adult count with children added on — is the reading that does not change
 * what existing configuration means. That mattered: the alternative would have
 * silently widened every existing assignment's included headcount.
 *
 * The allocation is deliberately NOT a pooled one. Spare child allowance does
 * not absorb an extra adult, and spare adult allowance does not absorb an
 * extra child: a property that includes one child is making a statement about
 * children, and letting a second adult consume that allowance would price a
 * two-adult booking as if a child had come. Each count is measured against its
 * own allowance, which is also why the breakdown can explain itself.
 *
 * INFANTS ARE NEVER CHARGED AND NEVER COUNTED. This is not an invention: the
 * schema already says so at `Reservation.infants` — "they do not consume
 * occupancy for rate or capacity purposes, so folding them into `children`
 * would inflate both the occupancy figure and the price". F4 honours that
 * existing policy exactly: an infant count is accepted, echoed back for the
 * operator's confidence, excluded from `maxGuests` and `maxAdults`, and
 * contributes zero.
 *
 * NO FLOATING-POINT MONEY ANYWHERE. Percentages are integer basis points and
 * the one division is a single `Math.round` over an integer product
 * (CLAUDE.md section 3.4).
 *
 * REUSABLE BY F9 UNCHANGED: it is a total function of its arguments, so a
 * quote path can call it per night and sum. It is deliberately not wired to
 * reservation creation now.
 * ===========================================================================
 */

export type ExtraGuestChargeKind = 'FIXED' | 'PERCENT';

/** 100 basis points = 1%. 10,000 = 100%. */
export const BASIS_POINTS_PER_UNIT = 10_000;

/** Matches the CHECK constraints: minor units for FIXED, bps for PERCENT. */
export const MAX_FIXED_CHARGE_MINOR = 2_000_000_000;
export const MAX_PERCENT_BASIS_POINTS = 100_000;

/**
 * The ceiling for any computed nightly total.
 *
 * Well inside `Number.MAX_SAFE_INTEGER` (2^53 − 1 ≈ 9.0e15), so the integer
 * arithmetic below cannot lose precision, and inside what an `Int` column can
 * hold should a later scope persist a computed figure.
 */
export const MAX_NIGHTLY_TOTAL_MINOR = 2_000_000_000;

export interface ExtraGuestCharge {
  kind: ExtraGuestChargeKind;
  /** Minor units when FIXED; basis points when PERCENT. */
  value: number;
}

export interface OccupancyConfig {
  /** Total guests the base rate covers. */
  baseOccupancy: number;
  /** How many of `baseOccupancy` may be children. */
  includedChildren: number;
  /** False means no extra-guest charge applies at all. */
  enabled: boolean;
  adult: ExtraGuestCharge;
  child: ExtraGuestCharge;
}

export interface RoomCapacity {
  maxGuests: number;
  /** Null means "no separate adult limit" — only `maxGuests` binds. */
  maxAdults: number | null;
}

export interface GuestComposition {
  adults: number;
  children: number;
  /** Never charged, never counted toward capacity. */
  infants: number;
}

export interface OccupancyPricingInput {
  /** The F2/F3 resolved nightly base rate, in minor units. */
  baseRateMinor: number;
  currency: string;
  config: OccupancyConfig;
  capacity: RoomCapacity;
  guests: GuestComposition;
}

/** One line of the operator-facing explanation. */
export interface BreakdownLine {
  label: string;
  /** Minor units. Zero for a purely explanatory line. */
  amountMinor: number;
  detail: string;
}

export type OccupancyRefusalCode =
  | 'ADULTS_BELOW_ONE'
  | 'NEGATIVE_COUNT'
  | 'NON_INTEGER_COUNT'
  | 'EXCEEDS_MAX_GUESTS'
  | 'EXCEEDS_MAX_ADULTS'
  | 'INCLUDED_CHILDREN_EXCEED_BASE'
  | 'BASE_OCCUPANCY_EXCEEDS_CAPACITY'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'TOTAL_OUT_OF_RANGE';

export interface OccupancyRefusal {
  code: OccupancyRefusalCode;
  /** The field a form should mark, where one applies. */
  field: string | null;
  message: string;
}

export interface OccupancyPricing {
  baseRateMinor: number;
  includedAdultCount: number;
  includedChildCount: number;
  extraAdultCount: number;
  extraChildCount: number;
  /** Per extra adult, per night. Zero when none apply. */
  adultUnitChargeMinor: number;
  adultExtraChargeMinor: number;
  childUnitChargeMinor: number;
  childExtraChargeMinor: number;
  totalExtraChargeMinor: number;
  /** base + extras. What the night costs for this composition. */
  effectiveNightlyRateMinor: number;
  currency: string;
  /** Echoed so the operator can see infants were received and cost nothing. */
  infantCount: number;
  breakdown: BreakdownLine[];
  /** Non-empty when the composition or configuration is unusable. */
  refusals: OccupancyRefusal[];
}

/* -------------------------------------------------------------------------- */
/*  The one charge calculation                                                */
/* -------------------------------------------------------------------------- */

/**
 * The per-guest charge for one extra guest, in minor units.
 *
 * ROUNDING POLICY — once, per guest, half-up, and only for PERCENT.
 *
 * `Math.round(base * bps / BASIS_POINTS_PER_UNIT)` over integers. `base * bps`
 * is at most 2e9 × 1e5 = 2e14, comfortably inside `MAX_SAFE_INTEGER` (≈9e15),
 * so the product is exact and the single division is the only place a fraction
 * can appear. All inputs are nonnegative, so `Math.round` is half-up — ties go
 * away from zero — which is the documented property-level default in
 * CLAUDE.md section 3.4.
 *
 * ROUNDED PER GUEST, THEN MULTIPLIED — deliberately, not rounded once over the
 * total. Two reasons. Each extra guest is then charged the same amount, which
 * is what an operator quotes and what a per-guest folio line would have to
 * show; and section 3.4 requires rounding to be applied once when a charge is
 * created, not to a total computed from unrounded intermediates. The cost is
 * that three guests at 33.333% of 100.00 come to 3 × 33.33 = 99.99 rather than
 * 100.00. That one-paisa divergence is visible and explicable; the alternative
 * — guests charged different amounts for the same thing — is neither.
 *
 * FIXED never touches the base rate. That is the distinction between the two
 * kinds, and conflating them would make a configured "₹500 per extra adult"
 * drift with the season.
 */
export function extraGuestUnitCharge(charge: ExtraGuestCharge, baseRateMinor: number): number {
  if (charge.kind === 'FIXED') return charge.value;
  return Math.round((baseRateMinor * charge.value) / BASIS_POINTS_PER_UNIT);
}

/* -------------------------------------------------------------------------- */
/*  The resolver                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Prices one night for one guest composition. Deterministic and total.
 *
 * REFUSALS ARE RETURNED, NOT THROWN. An unusable composition is an expected,
 * recoverable outcome with a reason the caller should display — CLAUDE.md
 * section 5: "expected-and-recoverable is a result, not an exception". The
 * service turns refusals into a typed 400 for a write and surfaces them inline
 * for a preview, which is what lets the configuration screen explain "4 adults
 * exceeds this room's limit of 3" instead of failing opaquely.
 *
 * When there are refusals the money fields are still populated on a
 * best-effort basis so the UI can show the shape of the calculation beside the
 * problem, but a caller MUST check `refusals` before treating
 * `effectiveNightlyRateMinor` as a price. The service does.
 */
export function resolveOccupancyPricing(input: OccupancyPricingInput): OccupancyPricing {
  const { baseRateMinor, currency, config, capacity, guests } = input;
  const refusals: OccupancyRefusal[] = [];

  /* -- 1. The composition must be a real one -------------------------- */

  for (const [field, value] of [
    ['adults', guests.adults],
    ['children', guests.children],
    ['infants', guests.infants],
  ] as const) {
    if (!Number.isInteger(value)) {
      refusals.push({
        code: 'NON_INTEGER_COUNT',
        field,
        message: 'A guest count must be a whole number.',
      });
    } else if (value < 0) {
      refusals.push({
        code: 'NEGATIVE_COUNT',
        field,
        message: 'A guest count cannot be negative.',
      });
    }
  }

  if (Number.isInteger(guests.adults) && guests.adults < 1) {
    refusals.push({
      code: 'ADULTS_BELOW_ONE',
      field: 'adults',
      message: 'A night needs at least one adult.',
    });
  }

  /* -- 2. Capacity. Infants are excluded, per the existing policy ----- */

  const occupyingGuests = guests.adults + guests.children;

  if (occupyingGuests > capacity.maxGuests) {
    refusals.push({
      code: 'EXCEEDS_MAX_GUESTS',
      field: 'adults',
      message:
        `${String(occupyingGuests)} guests exceed this room type's limit of ` +
        `${String(capacity.maxGuests)}. Infants are not counted.`,
    });
  }

  if (capacity.maxAdults !== null && guests.adults > capacity.maxAdults) {
    refusals.push({
      code: 'EXCEEDS_MAX_ADULTS',
      field: 'adults',
      message:
        `${String(guests.adults)} adults exceed this room type's adult limit of ` +
        `${String(capacity.maxAdults)}.`,
    });
  }

  /* -- 3. The configuration must be coherent -------------------------- */

  if (config.includedChildren > config.baseOccupancy) {
    refusals.push({
      code: 'INCLUDED_CHILDREN_EXCEED_BASE',
      field: 'includedChildren',
      message:
        `${String(config.includedChildren)} included children exceed the base ` +
        `occupancy of ${String(config.baseOccupancy)}.`,
    });
  }

  // Reported rather than assumed impossible: the cross-table rule is enforced
  // by the service, not by a database constraint, so a row written around the
  // service can hold this state. See the migration's section 5.
  if (config.baseOccupancy > capacity.maxGuests) {
    refusals.push({
      code: 'BASE_OCCUPANCY_EXCEEDS_CAPACITY',
      field: 'baseOccupancy',
      message:
        `The base occupancy of ${String(config.baseOccupancy)} exceeds this room ` +
        `type's limit of ${String(capacity.maxGuests)} guests.`,
    });
  }

  for (const [field, charge] of [
    ['extraAdultChargeValue', config.adult],
    ['extraChildChargeValue', config.child],
  ] as const) {
    const limit = charge.kind === 'FIXED' ? MAX_FIXED_CHARGE_MINOR : MAX_PERCENT_BASIS_POINTS;
    if (!Number.isInteger(charge.value) || charge.value < 0 || charge.value > limit) {
      refusals.push({
        code: 'AMOUNT_OUT_OF_RANGE',
        field,
        message:
          charge.kind === 'FIXED'
            ? 'A fixed extra-guest charge must be a whole, nonnegative amount.'
            : 'A percentage extra-guest charge must be between 0 and 1000%.',
      });
    }
  }

  /* -- 4. Allocation -------------------------------------------------- */

  // Clamped at zero so a (refused) incoherent configuration cannot produce a
  // negative allowance and then a negative charge further down.
  const includedChildCount = Math.max(0, Math.min(config.includedChildren, config.baseOccupancy));
  const includedAdultCount = Math.max(0, config.baseOccupancy - includedChildCount);

  const adults = Number.isInteger(guests.adults) ? Math.max(0, guests.adults) : 0;
  const children = Number.isInteger(guests.children) ? Math.max(0, guests.children) : 0;

  // Each count against its OWN allowance. No pooling: spare child allowance
  // does not absorb an extra adult, nor the reverse.
  const extraAdultCount = Math.max(0, adults - includedAdultCount);
  const extraChildCount = Math.max(0, children - includedChildCount);

  /* -- 5. Charges ----------------------------------------------------- */

  // A disabled configuration contributes nothing. This is the branch that
  // makes every pre-F4 assignment price exactly as it did before.
  const adultUnitChargeMinor = config.enabled
    ? extraGuestUnitCharge(config.adult, baseRateMinor)
    : 0;
  const childUnitChargeMinor = config.enabled
    ? extraGuestUnitCharge(config.child, baseRateMinor)
    : 0;

  const adultExtraChargeMinor = adultUnitChargeMinor * extraAdultCount;
  const childExtraChargeMinor = childUnitChargeMinor * extraChildCount;
  const totalExtraChargeMinor = adultExtraChargeMinor + childExtraChargeMinor;
  const effectiveNightlyRateMinor = baseRateMinor + totalExtraChargeMinor;

  // The guard the scope asks for. Every bound above keeps the arithmetic exact,
  // so reaching here means a configuration at the extremes rather than a
  // precision loss — but it is checked rather than assumed, because a silently
  // wrong large number is worse than a refusal.
  if (
    !Number.isSafeInteger(effectiveNightlyRateMinor) ||
    effectiveNightlyRateMinor > MAX_NIGHTLY_TOTAL_MINOR
  ) {
    refusals.push({
      code: 'TOTAL_OUT_OF_RANGE',
      field: null,
      message: 'That combination produces an implausibly large nightly total.',
    });
  }

  return {
    baseRateMinor,
    includedAdultCount,
    includedChildCount,
    extraAdultCount,
    extraChildCount,
    adultUnitChargeMinor,
    adultExtraChargeMinor,
    childUnitChargeMinor,
    childExtraChargeMinor,
    totalExtraChargeMinor,
    effectiveNightlyRateMinor,
    currency,
    infantCount: Number.isInteger(guests.infants) ? Math.max(0, guests.infants) : 0,
    breakdown: buildBreakdown({
      baseRateMinor,
      config,
      includedAdultCount,
      includedChildCount,
      extraAdultCount,
      extraChildCount,
      adultUnitChargeMinor,
      childUnitChargeMinor,
      adultExtraChargeMinor,
      childExtraChargeMinor,
      effectiveNightlyRateMinor,
      infants: guests.infants,
    }),
    refusals,
  };
}

/**
 * The operator-facing explanation.
 *
 * Built here rather than in a React component so that the server is the single
 * authority on *why* a price is what it is, not merely on what it is. A UI that
 * assembled its own explanation could describe a calculation the server did
 * not perform — which is the same class of bug as a UI computing its own price.
 *
 * Every line states its own arithmetic. "2 extra adults × ₹500" is checkable
 * by the operator reading it; "extras: ₹1,000" is not.
 */
function buildBreakdown(args: {
  baseRateMinor: number;
  config: OccupancyConfig;
  includedAdultCount: number;
  includedChildCount: number;
  extraAdultCount: number;
  extraChildCount: number;
  adultUnitChargeMinor: number;
  childUnitChargeMinor: number;
  adultExtraChargeMinor: number;
  childExtraChargeMinor: number;
  effectiveNightlyRateMinor: number;
  infants: number;
}): BreakdownLine[] {
  const lines: BreakdownLine[] = [
    {
      label: 'Base rate',
      amountMinor: args.baseRateMinor,
      detail:
        `Includes ${String(args.config.baseOccupancy)} guest` +
        `${args.config.baseOccupancy === 1 ? '' : 's'}` +
        (args.includedChildCount > 0
          ? ` — ${String(args.includedAdultCount)} adult${
              args.includedAdultCount === 1 ? '' : 's'
            } and up to ${String(args.includedChildCount)} child${
              args.includedChildCount === 1 ? '' : 'ren'
            }`
          : ''),
    },
  ];

  if (!args.config.enabled) {
    lines.push({
      label: 'Extra-guest pricing is off',
      amountMinor: 0,
      detail: 'No charge is added for guests beyond the base occupancy.',
    });
    lines.push({
      label: 'Nightly total',
      amountMinor: args.effectiveNightlyRateMinor,
      detail: 'Base rate only.',
    });
    return lines;
  }

  if (args.extraAdultCount > 0) {
    lines.push({
      label: `Extra adult${args.extraAdultCount === 1 ? '' : 's'}`,
      amountMinor: args.adultExtraChargeMinor,
      detail:
        `${String(args.extraAdultCount)} × ${describeCharge(args.config.adult)}` +
        (args.config.adult.kind === 'PERCENT'
          ? ` of the base rate = ${formatMinor(args.adultUnitChargeMinor)} each`
          : ''),
    });
  }

  if (args.extraChildCount > 0) {
    lines.push({
      label: `Extra child${args.extraChildCount === 1 ? '' : 'ren'}`,
      amountMinor: args.childExtraChargeMinor,
      detail:
        `${String(args.extraChildCount)} × ${describeCharge(args.config.child)}` +
        (args.config.child.kind === 'PERCENT'
          ? ` of the base rate = ${formatMinor(args.childUnitChargeMinor)} each`
          : ''),
    });
  }

  if (args.extraAdultCount === 0 && args.extraChildCount === 0) {
    lines.push({
      label: 'No extra guests',
      amountMinor: 0,
      detail: 'This composition fits inside the base occupancy.',
    });
  }

  if (args.infants > 0) {
    lines.push({
      label: `${String(args.infants)} infant${args.infants === 1 ? '' : 's'}`,
      amountMinor: 0,
      detail: 'Infants are never charged and do not count toward occupancy.',
    });
  }

  lines.push({
    label: 'Nightly total',
    amountMinor: args.effectiveNightlyRateMinor,
    detail: 'Base rate plus extra-guest charges.',
  });

  return lines;
}

function describeCharge(charge: ExtraGuestCharge): string {
  return charge.kind === 'FIXED' ? formatMinor(charge.value) : `${String(charge.value / 100)}%`;
}

/**
 * Minor units as a plain major-unit string, for a detail line.
 *
 * Deliberately NOT currency-formatted: this file is pure and must not depend
 * on a locale or a currency symbol. The client formats; this only has to be
 * unambiguous in the sentence it appears in.
 */
function formatMinor(amountMinor: number): string {
  const major = amountMinor / 100;
  return Number.isInteger(major) ? String(major) : major.toFixed(2);
}
