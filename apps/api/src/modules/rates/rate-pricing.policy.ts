/**
 * THE pricing resolver. Pure: no Nest, no Prisma, no clock, no I/O (F3).
 *
 * ===========================================================================
 * ONE PLACE WHERE PRECEDENCE LIVES. This file is the only thing in the
 * codebase that decides what a night costs. The controller does not, the
 * repository does not, and the frontend explicitly does not — it renders the
 * `effectiveRateMinor` the API returns. Duplicating precedence in a React
 * component is how a grid comes to show a price the booking path will not
 * honour, and F9 will call exactly this function, so a second copy would be a
 * second answer.
 *
 * THE ORDER, highest priority first:
 *
 *   1. DATE_OVERRIDE — an explicit `rate_plan_day` row for that night (F2).
 *   2. SEASONAL      — a dated range naming those nights.
 *   3. WEEKDAY       — a named set of weekdays.
 *   4. WEEKEND       — whatever the property calls its weekend.
 *   5. DEFAULT       — `rate_plan_room_type.defaultRateMinor` (F2).
 *
 * WHY THAT ORDER. Each tier is more specific about *these particular nights*
 * than the one below it. An operator who typed a number into 24 December meant
 * that number, whatever any rule says — so the F2 override always wins, which
 * the scope requires and which also means F3 cannot silently reprice a night
 * somebody set by hand. A dated season is a statement about named nights;
 * "Saturdays are dearer" is a statement about a pattern. And a rule naming
 * Saturday explicitly is more specific than one deferring to the property's
 * weekend definition, which is why WEEKDAY beats WEEKEND.
 *
 * WITHIN A TIER, higher `priority` wins. A tie between two enabled rules of
 * the same kind that both match the same night AND share the room type is an
 * AMBIGUITY. It is refused at write time by the service. If one exists anyway
 * — written before this code, or by something that bypassed the service — this
 * resolver reports it instead of picking: see `AMBIGUITY` below.
 *
 * WEEKDAYS NEED NO TIMEZONE. `2026-12-20` is a Sunday everywhere on Earth; the
 * weekday is a property of the calendar date, not of an observer. What matters
 * is never routing the date through a local `Date` on the way to asking, which
 * is why `dayOfWeek` below anchors at UTC noon — twelve hours of slack either
 * side of any real zone offset, so it cannot land on the wrong day the way a
 * midnight anchor can (CLAUDE.md section 3.3).
 * ===========================================================================
 */

/** `YYYY-MM-DD`. The same shape `businessDateSchema` validates. */
export type CalendarDate = string;

/** Which tier decided the price. */
export type RateSource = 'DATE_OVERRIDE' | 'SEASONAL' | 'WEEKDAY' | 'WEEKEND' | 'DEFAULT';

/** Precedence of the rule kinds, as a number so the tiers sort explicitly. */
const KIND_RANK: Record<'SEASONAL' | 'WEEKDAY' | 'WEEKEND', number> = {
  SEASONAL: 3,
  WEEKDAY: 2,
  WEEKEND: 1,
};

/**
 * A rule as the resolver needs it: already filtered to one rate plan, with
 * this room type's price attached.
 *
 * `amountMinor` is this ROOM TYPE's price under the rule, not the rule's only
 * price — a rule prices each category separately, and a rule with no price for
 * the category in question simply does not apply to it and must be left out by
 * the caller.
 */
export interface PricingRuleCandidate {
  id: string;
  name: string;
  kind: 'SEASONAL' | 'WEEKDAY' | 'WEEKEND';
  /** Inclusive. Both set for SEASONAL, both null otherwise. */
  startDate: CalendarDate | null;
  endDate: CalendarDate | null;
  /** 0 = Sunday … 6 = Saturday. Non-empty for WEEKDAY, empty otherwise. */
  daysOfWeek: readonly number[];
  priority: number;
  amountMinor: number;
}

export interface ResolveInput {
  stayDate: CalendarDate;
  /** `rate_plan_room_type.defaultRateMinor` — the floor of the hierarchy. */
  defaultRateMinor: number;
  /** An explicit F2 override for this night, or null. */
  overrideRateMinor: number | null;
  /** Enabled rules for this plan that carry a price for this room type. */
  rules: readonly PricingRuleCandidate[];
  /** `property_settings.weekendDays`. Empty means the property has no weekend. */
  weekendDays: readonly number[];
}

export interface RateResolution {
  stayDate: CalendarDate;
  /** What this night actually costs. */
  effectiveRateMinor: number;
  source: RateSource;
  /** The rule that decided it, or null for DATE_OVERRIDE and DEFAULT. */
  ruleId: string | null;
  ruleName: string | null;
  /** The assignment default, always reported so a day row stands alone. */
  defaultRateMinor: number;
  /** The F2 override, or null. Unchanged in meaning from F2. */
  overrideRateMinor: number | null;
  /** The rule-derived rate that applies when there is no override, or null. */
  ruleRateMinor: number | null;
  /**
   * What WOULD have applied had there been no explicit override.
   *
   * Non-null only when an override is winning and a rule also matched. This is
   * what lets the UI say "overridden — the Christmas season would price this
   * at 4,500", which the scope asks for: an operator must be able to see that
   * the rule still exists and is currently being overridden, or they will
   * delete the rule wondering why it does nothing.
   */
  maskedSource: RateSource | null;
  maskedRuleId: string | null;
  maskedRuleName: string | null;
  /**
   * True when two equally-ranked rules tied and the configuration is
   * ambiguous. See the AMBIGUITY note below for what the price falls back to.
   */
  isAmbiguous: boolean;
  /** The tying rule ids, so the UI can name what needs resolving. */
  conflictingRuleIds: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*  Date helpers — string in, no local Date ever                              */
/* -------------------------------------------------------------------------- */

/**
 * 0 = Sunday … 6 = Saturday, for a `YYYY-MM-DD` calendar date.
 *
 * Anchored at UTC **noon**, not midnight. A midnight anchor plus a negative
 * zone offset can land on the previous day in some environments; noon has
 * twelve hours of slack either side and cannot cross a boundary for any real
 * offset. `getUTCDay` then reads the day without consulting the host's zone at
 * all, which is the point.
 */
export function dayOfWeek(date: CalendarDate): number {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

/**
 * Does `date` fall inside `[startDate, endDate]`, both INCLUSIVE?
 *
 * String comparison, which is correct and total for `YYYY-MM-DD` and avoids
 * constructing two Dates to compare them. Inclusive at both ends because a
 * season is a set of nights an operator named — "20 December through 10
 * January" means both — unlike a stay, which is half-open because its
 * departure day is still sellable.
 *
 * A season crossing New Year needs nothing special: 2026-12-20 … 2027-01-10 is
 * an ordinary range whose end sorts after its start.
 */
export function withinSeason(
  date: CalendarDate,
  startDate: CalendarDate | null,
  endDate: CalendarDate | null,
): boolean {
  if (startDate === null || endDate === null) return false;
  return date >= startDate && date <= endDate;
}

/**
 * Does this rule match this night?
 *
 * The one place "matches" is defined, so the resolver, the conflict detector
 * and the service's write-time validation cannot disagree about it.
 */
export function ruleMatches(
  rule: PricingRuleCandidate,
  date: CalendarDate,
  weekendDays: readonly number[],
): boolean {
  switch (rule.kind) {
    case 'SEASONAL':
      return withinSeason(date, rule.startDate, rule.endDate);
    case 'WEEKDAY':
      return rule.daysOfWeek.includes(dayOfWeek(date));
    case 'WEEKEND':
      // An empty `weekendDays` means the property has no weekend, so a WEEKEND
      // rule matches nothing. That is a real configuration, not a bug.
      return weekendDays.includes(dayOfWeek(date));
  }
}

/* -------------------------------------------------------------------------- */
/*  The resolver                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolves one night's price. Deterministic, total, and the only such function.
 *
 * AMBIGUITY. When the winning tier contains two rules with the same priority,
 * there is no honest answer and the scope forbids picking by row order. What
 * happens instead:
 *
 *   * `isAmbiguous` is true and `conflictingRuleIds` names the tying rules.
 *   * `effectiveRateMinor` falls back to `defaultRateMinor` — the one figure in
 *     the input that is unambiguous — and `source` is `DEFAULT`.
 *
 * Falling back rather than throwing is a deliberate trade. Write-time refusal
 * in the service is the real control: you cannot create the ambiguity through
 * the API. But if one exists anyway, throwing here would fail the whole
 * 90-night calendar read and leave the operator unable to SEE the problem,
 * let alone fix it. So the read succeeds, the day is flagged loudly, and the
 * price it reports is the one number nobody can argue with. The UI shows the
 * conflict and links to the rules.
 *
 * An override still wins over an ambiguity: a hand-typed price is not made
 * uncertain by two rules disagreeing underneath it.
 */
export function resolveRate(input: ResolveInput): RateResolution {
  const { stayDate, defaultRateMinor, overrideRateMinor, rules, weekendDays } = input;

  const matching = rules.filter((rule) => ruleMatches(rule, stayDate, weekendDays));

  // The winning tier is the highest kind rank present; within it, the highest
  // priority. Computed rather than assumed from input order — the caller's
  // ordering must not be able to change the answer.
  let best: PricingRuleCandidate | null = null;
  for (const rule of matching) {
    if (best === null) {
      best = rule;
      continue;
    }
    const rank = KIND_RANK[rule.kind] - KIND_RANK[best.kind];
    if (rank > 0 || (rank === 0 && rule.priority > best.priority)) best = rule;
  }

  // Everything tied with the winner on BOTH kind and priority. Length > 1 is
  // the ambiguity. Note a rule is only here if it already matched and already
  // carries a price for this room type, so two rules pricing different
  // categories never collide — which is exactly why this check lives here and
  // not in a single-table database constraint.
  const tied =
    best === null
      ? []
      : matching.filter(
          (rule) =>
            KIND_RANK[rule.kind] === KIND_RANK[best.kind] && rule.priority === best.priority,
        );

  const isAmbiguous = tied.length > 1;
  const conflictingRuleIds = isAmbiguous ? tied.map((rule) => rule.id) : [];

  // The rule-derived rate, when there is exactly one winner.
  const ruleRateMinor = best !== null && !isAmbiguous ? best.amountMinor : null;
  const ruleSource: RateSource | null = best !== null && !isAmbiguous ? best.kind : null;

  // 1. An explicit override always wins.
  if (overrideRateMinor !== null) {
    return {
      stayDate,
      effectiveRateMinor: overrideRateMinor,
      source: 'DATE_OVERRIDE',
      ruleId: null,
      ruleName: null,
      defaultRateMinor,
      overrideRateMinor,
      ruleRateMinor,
      // What the override is masking, so the UI can say the rule still exists.
      maskedSource: ruleSource,
      maskedRuleId: best !== null && !isAmbiguous ? best.id : null,
      maskedRuleName: best !== null && !isAmbiguous ? best.name : null,
      isAmbiguous,
      conflictingRuleIds,
    };
  }

  // 2. An ambiguity: report it, price at the default, name the culprits.
  if (isAmbiguous) {
    return {
      stayDate,
      effectiveRateMinor: defaultRateMinor,
      source: 'DEFAULT',
      ruleId: null,
      ruleName: null,
      defaultRateMinor,
      overrideRateMinor: null,
      ruleRateMinor: null,
      maskedSource: null,
      maskedRuleId: null,
      maskedRuleName: null,
      isAmbiguous: true,
      conflictingRuleIds,
    };
  }

  // 3. One winning rule.
  if (best !== null) {
    return {
      stayDate,
      effectiveRateMinor: best.amountMinor,
      source: best.kind,
      ruleId: best.id,
      ruleName: best.name,
      defaultRateMinor,
      overrideRateMinor: null,
      ruleRateMinor: best.amountMinor,
      maskedSource: null,
      maskedRuleId: null,
      maskedRuleName: null,
      isAmbiguous: false,
      conflictingRuleIds: [],
    };
  }

  // 4. Nothing matched.
  return {
    stayDate,
    effectiveRateMinor: defaultRateMinor,
    source: 'DEFAULT',
    ruleId: null,
    ruleName: null,
    defaultRateMinor,
    overrideRateMinor: null,
    ruleRateMinor: null,
    maskedSource: null,
    maskedRuleId: null,
    maskedRuleName: null,
    isAmbiguous: false,
    conflictingRuleIds: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Write-time conflict detection                                             */
/* -------------------------------------------------------------------------- */

export interface RuleConflict {
  /** The rule already stored that the candidate collides with. */
  existingRuleId: string;
  existingRuleName: string;
  /** The room types both rules price. */
  roomTypeIds: readonly string[];
  /** One night that proves the collision, for the error message. */
  exampleDate: CalendarDate | null;
  kind: 'SEASONAL' | 'WEEKDAY' | 'WEEKEND';
  priority: number;
}

/**
 * A candidate rule against the rules already stored, looking for the ambiguity
 * the resolver cannot resolve: same kind, same priority, overlapping match,
 * and at least one room type in common.
 *
 * ALL FOUR must hold. Relaxing any one of them would refuse legitimate
 * configuration:
 *
 *   * different kind      — a season is *meant* to beat a weekend rule;
 *   * different priority  — that is precisely how the scope says to resolve an
 *                           intended overlap;
 *   * no date overlap     — two seasons in different months do not interact;
 *   * no shared room type — "Christmas Suites" and "Christmas Standard" over
 *                           the same fortnight are two ordinary rules.
 *
 * Disabled rules are not checked, because a disabled rule participates in no
 * resolution. Re-enabling one is therefore its own conflict check, which the
 * service performs on the status endpoint.
 *
 * For the recurring kinds the "dates" are weekday sets, so overlap is set
 * intersection: two WEEKDAY rules collide when they share a day, and two
 * WEEKEND rules always collide (they match the same property-defined days by
 * definition).
 */
export function findRuleConflicts(
  candidate: {
    id: string | null;
    kind: 'SEASONAL' | 'WEEKDAY' | 'WEEKEND';
    startDate: CalendarDate | null;
    endDate: CalendarDate | null;
    daysOfWeek: readonly number[];
    priority: number;
    roomTypeIds: readonly string[];
  },
  existing: readonly {
    id: string;
    name: string;
    kind: 'SEASONAL' | 'WEEKDAY' | 'WEEKEND';
    startDate: CalendarDate | null;
    endDate: CalendarDate | null;
    daysOfWeek: readonly number[];
    priority: number;
    isEnabled: boolean;
    roomTypeIds: readonly string[];
  }[],
): RuleConflict[] {
  const candidateRooms = new Set(candidate.roomTypeIds);

  return existing.flatMap((other) => {
    // An edit compares against everything except itself.
    if (candidate.id !== null && other.id === candidate.id) return [];
    if (!other.isEnabled) return [];
    if (other.kind !== candidate.kind) return [];
    if (other.priority !== candidate.priority) return [];

    const sharedRooms = other.roomTypeIds.filter((id) => candidateRooms.has(id));
    if (sharedRooms.length === 0) return [];

    if (candidate.kind === 'SEASONAL') {
      const overlaps = rangesOverlap(
        candidate.startDate,
        candidate.endDate,
        other.startDate,
        other.endDate,
      );
      if (!overlaps) return [];
      return [
        {
          existingRuleId: other.id,
          existingRuleName: other.name,
          roomTypeIds: sharedRooms,
          // The later of the two starts is always inside both ranges.
          exampleDate: laterOf(candidate.startDate, other.startDate),
          kind: other.kind,
          priority: other.priority,
        },
      ];
    }

    if (candidate.kind === 'WEEKDAY') {
      const sharedDays = other.daysOfWeek.filter((day) => candidate.daysOfWeek.includes(day));
      if (sharedDays.length === 0) return [];
      return [
        {
          existingRuleId: other.id,
          existingRuleName: other.name,
          roomTypeIds: sharedRooms,
          exampleDate: null,
          kind: other.kind,
          priority: other.priority,
        },
      ];
    }

    // Two WEEKEND rules at the same priority always match the same nights.
    return [
      {
        existingRuleId: other.id,
        existingRuleName: other.name,
        roomTypeIds: sharedRooms,
        exampleDate: null,
        kind: other.kind,
        priority: other.priority,
      },
    ];
  });
}

/** Inclusive-range overlap, by string comparison. */
function rangesOverlap(
  aStart: CalendarDate | null,
  aEnd: CalendarDate | null,
  bStart: CalendarDate | null,
  bEnd: CalendarDate | null,
): boolean {
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

function laterOf(a: CalendarDate | null, b: CalendarDate | null): CalendarDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}
