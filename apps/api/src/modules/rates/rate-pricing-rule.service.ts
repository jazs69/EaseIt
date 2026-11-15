/**
 * Seasonal, weekday and weekend pricing rules (F3).
 *
 * ===========================================================================
 * AUTHORISATION ORDER IS LOAD-BEARING. The grant is resolved first and a
 * caller with no grant gets not-found; only a caller who has already proven a
 * grant can reach a 403. Reversing the two would let a permission refusal
 * confirm that another property exists (section 3.2). Identical shape to
 * `rate-plan.service.ts`, `rate-calendar.service.ts` and
 * `room-type.service.ts`.
 *
 * THEN the plan is resolved in one scoped read, which settles three things at
 * once: the plan belongs to this property, it is editable, and which room
 * types it is assigned to. Any of them failing is *not found*, never a 403 and
 * never a 400 that confirms the plan exists.
 *
 * PRECEDENCE AND CONFLICT LOGIC ARE NOT HERE. They live in
 * `rate-pricing.policy.ts` as pure functions, so the write-time check, the
 * calendar read and F9 all consult the same definition of "matches" and of
 * "ambiguous". This service decides *whether to refuse*; the policy decides
 * *what collides*.
 *
 * WHAT THIS DOES NOT TOUCH.
 *
 *   * `rate_plan_day` — F2's explicit overrides. Never read, never written,
 *     never deleted by anything in this file. An override always outranks
 *     every rule here, so F3 cannot reprice a night somebody set by hand.
 *   * `inventory_day`, `reservation`, `reservation_room`, `folio_line` — never
 *     touched. No path here enters the lock protocol of section 3.1.1, so the
 *     five existing inventory writers are unaffected and no `lock_timeout` is
 *     needed: nothing contends for a row they hold.
 *   * `room_type.baseRateMinor` — still what the booking path prices from.
 *     F3 changes no quote. That integration is F9.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  DAY_OF_WEEK_LABELS,
  Permission,
  type CreateRatePricingRuleRequest,
  type ListRatePricingRulesQuery,
  type RatePricingRuleKind,
  type RatePricingRuleListResponse,
  type RatePricingRuleStatusAction,
  type RatePricingRuleView,
  type UpdateRatePricingRuleRequest,
} from '@repo/types';

import {
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { findRuleConflicts, type RuleConflict } from './rate-pricing.policy.js';
import {
  RatePricingRuleRepository,
  type RuleKind,
  type RuleRow,
} from './rate-pricing-rule.repository.js';

/** Which kinds each route family accepts. Enforced, not merely documented. */
export const SEASON_KINDS: readonly RuleKind[] = ['SEASONAL'];
export const RECURRING_KINDS: readonly RuleKind[] = ['WEEKDAY', 'WEEKEND'];

interface PlanContext {
  propertyId: string;
  ratePlanId: string;
  currency: string;
  isEditable: boolean;
  /** AV-06: a derived plan is priced from its parent and holds no rules. */
  isDerived: boolean;
  /** Room type ids currently assigned to the plan. */
  assignedRoomTypeIds: string[];
}

@Injectable()
export class RatePricingRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RatePricingRuleRepository,
  ) {}

  async list(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    query: ListRatePricingRulesQuery,
    kinds: readonly RuleKind[],
  ): Promise<RatePricingRuleListResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    const plan = await this.requirePlan(property.id, ratePlanId);

    // A `kind` filter from the query may only narrow what the route family
    // already allows -- it can never widen it, so the season routes cannot be
    // used to read weekday rules.
    const effectiveKinds =
      query.kind === undefined
        ? kinds
        : kinds.includes(query.kind as RuleKind)
          ? [query.kind as RuleKind]
          : [];

    const rows =
      effectiveKinds.length === 0
        ? []
        : await this.repository.findMany(property.id, ratePlanId, {
            kinds: effectiveKinds,
            enabled: query.enabled,
            ...(query.roomTypeId === undefined ? {} : { roomTypeId: query.roomTypeId }),
          });

    const weekendDays = await this.repository.weekendDays(property.id);

    return {
      items: rows.map((row) => toView(row, plan.currency)),
      currency: plan.currency,
      weekendDays,
      isEditable: plan.isEditable,
    };
  }

  async detail(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    ruleId: string,
    kinds: readonly RuleKind[],
  ): Promise<RatePricingRuleView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    const plan = await this.requirePlan(property.id, ratePlanId);

    const row = await this.requireRule(property.id, ratePlanId, ruleId, kinds);
    return toView(row, plan.currency);
  }

  async create(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: CreateRatePricingRuleRequest,
    kinds: readonly RuleKind[],
  ): Promise<RatePricingRuleView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const plan = await this.requirePlan(property.id, ratePlanId);
    this.requireEditable(plan);

    // The route family decides which kinds are legal here. A WEEKDAY body sent
    // to the seasons route is refused rather than quietly accepted, so the two
    // surfaces cannot be used to bypass each other's validation.
    this.requireKindAllowed(request.kind, kinds);

    this.requireAssignedRoomTypes(
      plan,
      request.prices.map((price) => price.roomTypeId),
    );

    await this.requireNoConflict(plan, {
      id: null,
      kind: request.kind as RuleKind,
      startDate: request.startDate ?? null,
      endDate: request.endDate ?? null,
      daysOfWeek: request.daysOfWeek,
      priority: request.priority,
      roomTypeIds: request.prices.map((price) => price.roomTypeId),
    });

    const row = await this.repository.create(
      property.id,
      ratePlanId,
      {
        kind: request.kind as RuleKind,
        name: request.name,
        startDate: request.startDate ?? null,
        endDate: request.endDate ?? null,
        daysOfWeek: [...request.daysOfWeek],
        priority: request.priority,
      },
      request.prices,
      userId,
    );

    await this.audit(
      property.id,
      userId,
      'RATE_PRICING_RULE_CREATED',
      ratePlanId,
      row.id,
      Prisma.DbNull,
      auditShape(row, ratePlanId),
    );

    return toView(row, plan.currency);
  }

  async update(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    ruleId: string,
    request: UpdateRatePricingRuleRequest,
    kinds: readonly RuleKind[],
  ): Promise<RatePricingRuleView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const plan = await this.requirePlan(property.id, ratePlanId);
    this.requireEditable(plan);

    const before = await this.requireRule(property.id, ratePlanId, ruleId, kinds);

    // `kind` is not editable, so the merged shape keeps the stored kind and the
    // per-kind field rules are checked against THAT, not against whatever the
    // request implies.
    const merged = {
      kind: before.kind,
      startDate: request.startDate === undefined ? before.startDate : request.startDate,
      endDate: request.endDate === undefined ? before.endDate : request.endDate,
      daysOfWeek: request.daysOfWeek === undefined ? before.daysOfWeek : [...request.daysOfWeek],
      priority: request.priority === undefined ? before.priority : request.priority,
      roomTypeIds: (request.prices ?? before.prices).map((price) => price.roomTypeId),
    };

    this.requireKindShape(merged);

    if (request.prices !== undefined) {
      this.requireAssignedRoomTypes(
        plan,
        request.prices.map((price) => price.roomTypeId),
      );
    }

    // Only re-check conflicts when something that affects matching changed.
    // Renaming a rule cannot create an ambiguity, and refusing a rename
    // because of a pre-existing conflict elsewhere would be unhelpful.
    const matchingChanged =
      request.startDate !== undefined ||
      request.endDate !== undefined ||
      request.daysOfWeek !== undefined ||
      request.priority !== undefined ||
      request.prices !== undefined;

    if (matchingChanged && before.isEnabled) {
      await this.requireNoConflict(plan, { id: ruleId, ...merged });
    }

    const after = await this.repository.update(
      property.id,
      ratePlanId,
      ruleId,
      {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(request.startDate === undefined ? {} : { startDate: request.startDate }),
        ...(request.endDate === undefined ? {} : { endDate: request.endDate }),
        ...(request.daysOfWeek === undefined ? {} : { daysOfWeek: [...request.daysOfWeek] }),
      },
      request.prices,
    );

    // Null here means the row vanished between the two statements. Reported as
    // not-found rather than retried: the operator was editing something that
    // no longer exists.
    if (after === null) throw new TenantScopeViolationError('Pricing rule');

    await this.audit(
      property.id,
      userId,
      'RATE_PRICING_RULE_UPDATED',
      ratePlanId,
      ruleId,
      auditShape(before, ratePlanId),
      auditShape(after, ratePlanId),
    );

    return toView(after, plan.currency);
  }

  /**
   * Enable or disable.
   *
   * ENABLING RE-RUNS THE CONFLICT CHECK, which matters: a rule may have been
   * disabled precisely because it collided with another, and switching it back
   * on must not resurrect an ambiguity the resolver cannot resolve. Disabling
   * never conflicts with anything, so it is unconditional.
   */
  async setStatus(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    ruleId: string,
    request: RatePricingRuleStatusAction,
    kinds: readonly RuleKind[],
  ): Promise<RatePricingRuleView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const plan = await this.requirePlan(property.id, ratePlanId);
    this.requireEditable(plan);

    const before = await this.requireRule(property.id, ratePlanId, ruleId, kinds);
    const next = request.action === 'ENABLE';

    if (before.isEnabled === next) {
      // A no-op is refused rather than silently succeeding, so an operator who
      // enables an already-enabled rule is told why nothing changed -- the
      // same convention the rate plan's own status endpoint follows.
      throw new InvalidStateTransitionError(
        'pricing rule',
        before.isEnabled ? 'ENABLED' : 'DISABLED',
        request.action,
      );
    }

    if (next) {
      await this.requireNoConflict(plan, {
        id: ruleId,
        kind: before.kind,
        startDate: before.startDate,
        endDate: before.endDate,
        daysOfWeek: before.daysOfWeek,
        priority: before.priority,
        roomTypeIds: before.prices.map((price) => price.roomTypeId),
      });
    }

    const after = await this.repository.setEnabled(property.id, ratePlanId, ruleId, next);
    if (after === null) throw new TenantScopeViolationError('Pricing rule');

    await this.audit(
      property.id,
      userId,
      next ? 'RATE_PRICING_RULE_ENABLED' : 'RATE_PRICING_RULE_DISABLED',
      ratePlanId,
      ruleId,
      auditShape(before, ratePlanId),
      auditShape(after, ratePlanId),
    );

    return toView(after, plan.currency);
  }

  /**
   * Delete a rule.
   *
   * A real delete, unlike a rate plan, which only archives. A pricing rule is
   * pure configuration: nothing references it, and no reservation or folio
   * points at one because F9 has not integrated pricing yet. Deleting changes
   * future effective rates and nothing else. The before-state is captured
   * first so the audit row records what was removed.
   */
  async remove(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    ruleId: string,
    kinds: readonly RuleKind[],
  ): Promise<void> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const plan = await this.requirePlan(property.id, ratePlanId);
    this.requireEditable(plan);

    const before = await this.requireRule(property.id, ratePlanId, ruleId, kinds);

    const removed = await this.repository.remove(property.id, ratePlanId, ruleId);
    if (!removed) throw new TenantScopeViolationError('Pricing rule');

    await this.audit(
      property.id,
      userId,
      'RATE_PRICING_RULE_DELETED',
      ratePlanId,
      ruleId,
      auditShape(before, ratePlanId),
      Prisma.DbNull,
    );
  }

  /* -- Guards ------------------------------------------------------------- */

  /**
   * The plan, with its currency, editability and assigned room types.
   *
   * One read settles all three, so they cannot disagree by having been read at
   * different moments. Scoped by `propertyId` in the same predicate as the id,
   * so another property's plan is not found rather than forbidden (3.2).
   */
  private async requirePlan(propertyId: string, ratePlanId: string): Promise<PlanContext> {
    const plan = await this.prisma.client.ratePlan.findFirst({
      where: { id: ratePlanId, propertyId },
      select: {
        currency: true,
        isActive: true,
        archivedAt: true,
        parentRatePlanId: true,
        roomTypes: { select: { roomTypeId: true } },
      },
    });

    if (plan === null) throw new TenantScopeViolationError('Rate plan');

    return {
      propertyId,
      ratePlanId,
      currency: plan.currency,
      isEditable: plan.isActive && plan.archivedAt === null,
      isDerived: plan.parentRatePlanId !== null,
      assignedRoomTypeIds: plan.roomTypes.map((entry) => entry.roomTypeId),
    };
  }

  /**
   * The rule, restricted to the kinds this route family owns.
   *
   * A weekday rule addressed through the seasons route answers not-found, not
   * a 400: the seasons surface genuinely has no such resource, and saying so
   * any other way would confirm an id that surface should not expose.
   */
  private async requireRule(
    propertyId: string,
    ratePlanId: string,
    ruleId: string,
    kinds: readonly RuleKind[],
  ): Promise<RuleRow> {
    const row = await this.repository.findOne(propertyId, ratePlanId, ruleId);
    if (row === null || !kinds.includes(row.kind)) {
      throw new TenantScopeViolationError('Pricing rule');
    }
    return row;
  }

  /** An inactive or archived plan's rules are read-only (scope requirement D). */
  private requireEditable(plan: PlanContext): void {
    if (plan.isDerived) {
      throw new InvalidStateTransitionError('rate plan', 'DERIVED', 'repriced');
    }
    if (!plan.isEditable) {
      throw new InvalidStateTransitionError('rate plan', 'ARCHIVED_OR_INACTIVE', 'repriced');
    }
  }

  private requireKindAllowed(kind: RatePricingRuleKind, kinds: readonly RuleKind[]): void {
    if (!kinds.includes(kind as RuleKind)) {
      throw new ValidationFailedError({
        kind:
          `This endpoint accepts ${kinds.join(' or ')} rules. ` +
          `Use the other pricing endpoint for a ${kind} rule.`,
      });
    }
  }

  /**
   * Every room type priced must be assigned to the plan.
   *
   * The composite foreign key `rate_pricing_rule_price_assignment` would refuse
   * an unassigned category anyway -- that is the real guarantee (section 3.2) --
   * but it would arrive as a driver error. This turns it into a 400 naming the
   * field, and it does not disclose whether the unknown ids exist elsewhere:
   * the message is the same for a category of another property and for one
   * simply not assigned to this plan.
   */
  private requireAssignedRoomTypes(plan: PlanContext, roomTypeIds: readonly string[]): void {
    const assigned = new Set(plan.assignedRoomTypeIds);
    const stray = roomTypeIds.filter((id) => !assigned.has(id));

    if (stray.length > 0) {
      throw new ValidationFailedError({
        prices:
          'One or more of those room types is not assigned to this rate plan. ' +
          'Assign it to the plan first, then price it here.',
      });
    }
  }

  /**
   * Per-kind field coherence against the MERGED state.
   *
   * The DTO checks the request; this checks what the row will actually look
   * like afterwards. Clearing `daysOfWeek` on a WEEKDAY rule passes the DTO
   * (the field is simply absent from the patch) and would leave a rule that
   * matches nothing -- which the database CHECK refuses, as an opaque
   * constraint violation. This refuses it with a field name instead.
   */
  private requireKindShape(merged: {
    kind: RuleKind;
    startDate: string | null;
    endDate: string | null;
    daysOfWeek: readonly number[];
  }): void {
    if (merged.kind === 'SEASONAL') {
      if (merged.startDate === null || merged.endDate === null) {
        throw new ValidationFailedError({ startDate: 'A season needs both of its dates.' });
      }
      if (merged.endDate < merged.startDate) {
        throw new ValidationFailedError({ endDate: 'The season cannot end before it starts.' });
      }
      return;
    }

    if (merged.kind === 'WEEKDAY' && merged.daysOfWeek.length === 0) {
      throw new ValidationFailedError({
        daysOfWeek: 'A weekday rule needs at least one day.',
      });
    }
  }

  /**
   * Refuse an ambiguous configuration before it is stored.
   *
   * THIS IS THE REAL ENFORCEMENT of the scope's "reject rather than rely on
   * row order". The policy decides what collides -- same kind, same priority,
   * overlapping match, shared room type -- and this turns a collision into a
   * 400 that names the other rule and, for a season, a date that proves it.
   *
   * A database exclusion constraint cannot express this: the room types live
   * in a child table and PostgreSQL exclusion constraints are single-table, so
   * a constraint on the parent row would reject the legitimate case of two
   * same-priority seasons pricing different categories. That is recorded in
   * the migration, and it is why the resolver ALSO detects an ambiguity at
   * read time rather than trusting that this check was the only writer.
   */
  private async requireNoConflict(
    plan: PlanContext,
    candidate: {
      id: string | null;
      kind: RuleKind;
      startDate: string | null;
      endDate: string | null;
      daysOfWeek: readonly number[];
      priority: number;
      roomTypeIds: readonly string[];
    },
  ): Promise<void> {
    const existing = await this.repository.findForConflictCheck(plan.propertyId, plan.ratePlanId);
    const conflicts = findRuleConflicts(candidate, existing);

    if (conflicts.length === 0) return;

    throw new ValidationFailedError({ priority: describeConflicts(conflicts, candidate.priority) });
  }

  /**
   * Audit every mutation: actor, property, entity, before/after (section 3.4).
   *
   * Written after the mutation rather than inside one transaction with it.
   * This is the established pattern in `rate-plan.service.ts`,
   * `rate-calendar.service.ts`, `room-type.service.ts` and `room.service.ts`,
   * and the scope says to preserve it and record it as a hardening item rather
   * than refactor the audit subsystem here. A crash between the two statements
   * loses the audit row, not the change.
   *
   * `entityType` is `rate_pricing_rule` and `entityId` the rule, with the plan
   * carried in the payload -- an auditor searches by plan or by rule, and both
   * are therefore present.
   */
  private async audit(
    propertyId: string,
    actorUserId: string,
    event: string,
    ratePlanId: string,
    ruleId: string,
    before: Prisma.InputJsonValue | typeof Prisma.DbNull,
    after: Prisma.InputJsonValue | typeof Prisma.DbNull,
  ): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: {
        propertyId,
        actorUserId,
        event,
        entityType: 'rate_pricing_rule',
        entityId: ruleId,
        before,
        after: after === Prisma.DbNull ? { ratePlanId, deleted: true } : after,
      },
    });
  }

  /** See the identical helper in `rate-plan.service.ts`. */
  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<{ id: string }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    requirePermissionFromGrants(grants, required);

    return { id: first.property.id };
  }
}

/**
 * A conflict list as one operator-readable sentence.
 *
 * It names the other rule and says what to do, because "conflict" alone leaves
 * someone staring at a form with no next move. The remedy is always the same:
 * change the priority so one rule outranks the other, or narrow what they
 * share.
 */
function describeConflicts(conflicts: readonly RuleConflict[], priority: number): string {
  const first = conflicts[0];
  if (first === undefined) return 'That rule conflicts with an existing one.';

  const where =
    first.exampleDate === null
      ? 'the same days'
      : `the same dates (for example ${first.exampleDate})`;

  const others = conflicts.length > 1 ? ` (and ${String(conflicts.length - 1)} other rule(s))` : '';

  return (
    `"${first.existingRuleName}"${others} already prices ${where} ` +
    `for at least one of these room types at priority ${String(priority)}. ` +
    'Two rules of the same kind, same priority and the same room type would ' +
    'give a night two prices with no way to choose. Give one a higher ' +
    'priority, or change which room types or dates they cover.'
  );
}

/**
 * Prisma row to wire shape. Explicit, never a spread: a Prisma model is a
 * persistence detail and returning one leaks `propertyId`, `createdByUserId`
 * and every future addition (section 5).
 */
function toView(row: RuleRow, currency: string): RatePricingRuleView {
  return {
    id: row.id,
    ratePlanId: row.ratePlanId,
    kind: row.kind,
    name: row.name,
    startDate: row.startDate as RatePricingRuleView['startDate'],
    endDate: row.endDate as RatePricingRuleView['endDate'],
    daysOfWeek: row.daysOfWeek,
    priority: row.priority,
    isEnabled: row.isEnabled,
    prices: row.prices.map((price) => ({
      roomTypeId: price.roomTypeId,
      code: price.roomType.code,
      name: price.roomType.name,
      amountMinor: price.amountMinor,
    })),
    currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The audit payload: the fields a change can actually alter. */
function auditShape(row: RuleRow, ratePlanId: string): Prisma.InputJsonObject {
  return {
    ratePlanId,
    kind: row.kind,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    // Spelled out, because `[5, 6]` in an audit row a year later is less
    // readable than the day names an operator actually chose.
    daysOfWeek: row.daysOfWeek,
    dayNames: row.daysOfWeek.map((day) => DAY_OF_WEEK_LABELS[day] ?? String(day)),
    priority: row.priority,
    isEnabled: row.isEnabled,
    prices: row.prices.map((price) => ({
      roomTypeId: price.roomTypeId,
      roomTypeCode: price.roomType.code,
      amountMinor: price.amountMinor,
    })),
  };
}
