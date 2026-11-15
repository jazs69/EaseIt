/**
 * Occupancy and extra-person pricing (F4).
 *
 * ===========================================================================
 * AUTHORISATION ORDER IS LOAD-BEARING. The grant is resolved first and a
 * caller with no grant gets not-found; only a caller who has already proven a
 * grant can reach a 403. Reversing the two would let a permission refusal
 * confirm that another property exists (section 3.2). Identical shape to
 * `rate-plan.service.ts`, `rate-calendar.service.ts` and
 * `rate-pricing-rule.service.ts`.
 *
 * THE PREVIEW REUSES THE F2/F3 RESOLVER. It does not re-derive a base rate:
 * it reads the same overrides and rules the calendar reads, calls the same
 * `resolveRate`, and then applies `resolveOccupancyPricing` on top. There is
 * exactly one base-rate resolver in this codebase and F4 did not add a second
 * -- which is why a preview and the calendar can never disagree about what a
 * night's base rate is.
 *
 * WHAT THIS DOES NOT TOUCH.
 *
 *   * `rate_plan_day` and `rate_pricing_rule*` -- read for the preview, never
 *     written. F4 cannot change an override or a rule.
 *   * `defaultRateMinor` -- not writable here. The rate itself is changed
 *     through F2's own endpoint; a second way to set it would be a second
 *     place for the audit trail to record a price change.
 *   * `inventory_day`, `reservation`, `reservation_room`, `folio_line` --
 *     never read or written. No path here enters the lock protocol of section
 *     3.1.1, so the five inventory writers are unaffected.
 *   * `create-reservation.service.ts` -- not opened. Reservation pricing stays
 *     on its existing path until F9.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  MAX_RATE_CALENDAR_DAYS,
  Permission,
  type OccupancyPricingConfig,
  type OccupancyPricingPreview,
  type PreviewOccupancyPricingRequest,
  type UpdateOccupancyPricingRequest,
} from '@repo/types';

import {
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  resolveOccupancyPricing,
  type OccupancyConfig,
  type OccupancyRefusal,
} from './occupancy-pricing.policy.js';
import {
  OccupancyPricingRepository,
  type OccupancyAssignmentRow,
  type OccupancyWriteInput,
} from './occupancy-pricing.repository.js';
import { isRangeRefusal, parseRange } from './rate-calendar.policy.js';
import { RateCalendarRepository } from './rate-calendar.repository.js';
import { resolveRate } from './rate-pricing.policy.js';
import { RatePricingRuleRepository } from './rate-pricing-rule.repository.js';

@Injectable()
export class OccupancyPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OccupancyPricingRepository,
    /** F2's overrides, read for the preview's base rate. Never written here. */
    private readonly calendar: RateCalendarRepository,
    /** F3's rules and the property's weekend definition. Never written here. */
    private readonly rules: RatePricingRuleRepository,
  ) {}

  async read(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    roomTypeId: string,
  ): Promise<OccupancyPricingConfig> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    const assignment = await this.requireAssignment(property.id, ratePlanId, roomTypeId);
    return toConfig(assignment);
  }

  async update(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    roomTypeId: string,
    request: UpdateOccupancyPricingRequest,
  ): Promise<OccupancyPricingConfig> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const before = await this.requireAssignment(property.id, ratePlanId, roomTypeId);
    this.requireEditable(before);

    /**
     * VALIDATED AGAINST THE MERGED STATE, not the patch.
     *
     * Lowering `baseOccupancy` alone can invalidate an `includedChildren` set
     * months ago, and raising `includedChildren` alone can exceed a base
     * occupancy the request never mentions. The DTO catches the case where both
     * arrive together; only the merge catches the other two. This is the same
     * reasoning `room-type.service.ts` applies to `maxGuests`/`maxAdults`.
     */
    const merged = {
      baseOccupancy: request.baseOccupancy ?? before.baseOccupancy,
      includedChildren: request.includedChildren ?? before.includedChildren,
    };

    if (merged.includedChildren > merged.baseOccupancy) {
      throw new ValidationFailedError({
        includedChildren:
          `${String(merged.includedChildren)} included children cannot exceed a base ` +
          `occupancy of ${String(merged.baseOccupancy)}. Included children are a ` +
          'subset of the guests the base rate already covers.',
      });
    }

    /**
     * The cross-table rule no CHECK constraint can express.
     *
     * `maxGuests` lives on `room_type`, and a CHECK may only reference columns
     * of its own row — see the migration's section 5 for why a trigger and a
     * denormalised copy were both rejected. So it is enforced here, and the
     * resolver reports it at read time too rather than assuming it cannot
     * happen.
     */
    if (merged.baseOccupancy > before.maxGuests) {
      throw new ValidationFailedError({
        baseOccupancy:
          `A base occupancy of ${String(merged.baseOccupancy)} exceeds this room ` +
          `type's limit of ${String(before.maxGuests)} guests. Raise the room ` +
          'type’s maximum first, or lower the base occupancy.',
      });
    }

    const data: OccupancyWriteInput = {
      ...(request.baseOccupancy === undefined ? {} : { baseOccupancy: request.baseOccupancy }),
      ...(request.includedChildren === undefined
        ? {}
        : { includedChildren: request.includedChildren }),
      ...(request.enabled === undefined ? {} : { occupancyPricingEnabled: request.enabled }),
      // The discriminated union means kind and value always move together, so
      // a FIXED amount can never be left behind in a PERCENT field.
      ...(request.adult === undefined
        ? {}
        : {
            extraAdultChargeKind: request.adult.kind,
            extraAdultChargeValue: request.adult.value,
          }),
      ...(request.child === undefined
        ? {}
        : {
            extraChildChargeKind: request.child.kind,
            extraChildChargeValue: request.child.value,
          }),
    };

    const after = await this.repository.update(property.id, ratePlanId, roomTypeId, data);

    // Null here means the row vanished between the two statements. Reported as
    // not-found rather than retried: the operator was editing something that
    // no longer exists.
    if (after === null) throw new TenantScopeViolationError('Rate plan assignment');

    await this.audit(
      property.id,
      userId,
      'OCCUPANCY_PRICING_UPDATED',
      ratePlanId,
      roomTypeId,
      auditShape(before),
      auditShape(after),
    );

    return toConfig(after);
  }

  /**
   * Price one night for one guest composition.
   *
   * OPERATOR-FACING CONFIGURATION ONLY. It creates nothing and reserves
   * nothing. `rates:read` rather than `rates:manage`, deliberately: it mutates
   * nothing and computes only over data the caller can already read, and front
   * desk holds `rates:read` — requiring manage would deny a reception clerk the
   * ability to see what a third adult costs. The scope allowed either "if
   * consistent with existing conventions", and every other non-mutating rates
   * endpoint in this module is `rates:read`.
   *
   * REFUSALS ARE RETURNED, NOT THROWN, for a preview. An operator trying
   * four adults in a three-guest room needs to see the limit beside the
   * figures, not a 400 that clears the form. The write path above throws
   * instead, because there a bad configuration must not be stored.
   */
  async preview(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: PreviewOccupancyPricingRequest,
  ): Promise<OccupancyPricingPreview> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    const assignment = await this.requireAssignment(property.id, ratePlanId, request.roomTypeId);

    // A real calendar date. `businessDateSchema` accepts `2026-02-30` -- it
    // matches the shape and `Date.parse` rolls it over -- so the strict parse
    // from F2's policy is applied here too.
    const parsed = parseRange(request.stayDate, request.stayDate, MAX_RATE_CALENDAR_DAYS);
    if (isRangeRefusal(parsed)) {
      throw new ValidationFailedError({
        stayDate: 'Expected a real calendar date in YYYY-MM-DD form.',
      });
    }

    /**
     * The base rate for that night, through the EXISTING F2/F3 path.
     *
     * Three reads, in parallel because none depends on another: the explicit
     * override for the night, the enabled rules that price this category, and
     * the property's weekend definition. Then the same `resolveRate` the
     * calendar calls. F4 adds no second resolver and reinterprets nothing.
     */
    const [overrides, rules, weekendDays] = await Promise.all([
      this.calendar.findOverrides(
        property.id,
        ratePlanId,
        request.roomTypeId,
        request.stayDate,
        request.stayDate,
      ),
      this.rules.findForResolution(property.id, ratePlanId, request.roomTypeId),
      this.rules.weekendDays(property.id),
    ]);

    const base = resolveRate({
      stayDate: request.stayDate,
      defaultRateMinor: assignment.defaultRateMinor,
      overrideRateMinor: overrides.get(request.stayDate) ?? null,
      rules,
      weekendDays,
    });

    const occupancy = resolveOccupancyPricing({
      baseRateMinor: base.effectiveRateMinor,
      currency: assignment.currency,
      config: toPolicyConfig(assignment),
      capacity: { maxGuests: assignment.maxGuests, maxAdults: assignment.maxAdults },
      guests: {
        adults: request.adults,
        children: request.children,
        infants: request.infants,
      },
    });

    return {
      stayDate: request.stayDate,
      roomTypeId: assignment.roomTypeId,
      currency: assignment.currency,
      // F2/F3 metadata carried through UNCHANGED, so a preview can say why the
      // base rate is what it is. F4 does not alter or reinterpret it.
      baseRateMinor: base.effectiveRateMinor,
      baseRateSource: base.source,
      baseRateRuleName: base.ruleName,
      includedAdultCount: occupancy.includedAdultCount,
      includedChildCount: occupancy.includedChildCount,
      extraAdultCount: occupancy.extraAdultCount,
      extraChildCount: occupancy.extraChildCount,
      adultUnitChargeMinor: occupancy.adultUnitChargeMinor,
      adultExtraChargeMinor: occupancy.adultExtraChargeMinor,
      childUnitChargeMinor: occupancy.childUnitChargeMinor,
      childExtraChargeMinor: occupancy.childExtraChargeMinor,
      totalExtraChargeMinor: occupancy.totalExtraChargeMinor,
      effectiveNightlyRateMinor: occupancy.effectiveNightlyRateMinor,
      infantCount: occupancy.infantCount,
      breakdown: occupancy.breakdown,
      refusals: occupancy.refusals as OccupancyRefusal[],
    } as OccupancyPricingPreview;
  }

  /* -- Guards ------------------------------------------------------------- */

  /**
   * The assignment, or not-found.
   *
   * "No such plan", "no such room type", "that room type is not assigned to
   * this plan" and "that plan belongs to another property" all answer the same
   * way, deliberately. Distinguishing them would tell a caller which ids exist
   * at a property they hold no grant at (section 3.2).
   */
  private async requireAssignment(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
  ): Promise<OccupancyAssignmentRow> {
    const assignment = await this.repository.findAssignment(propertyId, ratePlanId, roomTypeId);
    if (assignment === null) throw new TenantScopeViolationError('Rate plan assignment');
    return assignment;
  }

  /** An inactive or archived plan's configuration is read-only. */
  private requireEditable(assignment: OccupancyAssignmentRow): void {
    if (assignment.archivedAt !== null) {
      throw new InvalidStateTransitionError('rate plan', 'ARCHIVED', 'repriced');
    }
    if (!assignment.isActive) {
      throw new InvalidStateTransitionError('rate plan', 'INACTIVE', 'repriced');
    }
  }

  /**
   * Audit the configuration change: actor, property, entity, before/after
   * (section 3.4).
   *
   * Written after the mutation rather than inside one transaction with it.
   * This is the established pattern in `rate-plan.service.ts`,
   * `rate-calendar.service.ts`, `rate-pricing-rule.service.ts`,
   * `room-type.service.ts` and `room.service.ts`; the scope says to record it
   * as a hardening item rather than refactor the audit subsystem here. A crash
   * between the two statements loses the audit row, not the change.
   *
   * `entityType` is `rate_plan_room_type` and `entityId` is the room type,
   * with the plan in the payload: an auditor searches by either, so both are
   * present.
   */
  private async audit(
    propertyId: string,
    actorUserId: string,
    event: string,
    ratePlanId: string,
    roomTypeId: string,
    before: Prisma.InputJsonValue,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: {
        propertyId,
        actorUserId,
        event,
        entityType: 'rate_plan_room_type',
        entityId: roomTypeId,
        before: { ratePlanId, ...(before as Prisma.InputJsonObject) },
        after: { ratePlanId, ...(after as Prisma.InputJsonObject) },
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

/** The stored configuration, in the shape the pure policy expects. */
function toPolicyConfig(row: OccupancyAssignmentRow): OccupancyConfig {
  return {
    baseOccupancy: row.baseOccupancy,
    includedChildren: row.includedChildren,
    enabled: row.enabled,
    adult: { kind: row.adultKind, value: row.adultValue },
    child: { kind: row.childKind, value: row.childValue },
  };
}

/**
 * Prisma row to wire shape. Explicit, never a spread: a Prisma model is a
 * persistence detail and returning one leaks `propertyId` and every future
 * addition (section 5).
 */
function toConfig(row: OccupancyAssignmentRow): OccupancyPricingConfig {
  return {
    ratePlanId: row.ratePlanId,
    ratePlanCode: row.ratePlanCode,
    roomTypeId: row.roomTypeId,
    roomTypeCode: row.roomTypeCode,
    roomTypeName: row.roomTypeName,
    defaultRateMinor: row.defaultRateMinor,
    currency: row.currency,
    baseOccupancy: row.baseOccupancy,
    includedChildren: row.includedChildren,
    // Derived server-side and sent, so the UI never has to compute an
    // allocation -- the one place that arithmetic lives is the policy file.
    includedAdults: Math.max(0, row.baseOccupancy - row.includedChildren),
    enabled: row.enabled,
    adult: { kind: row.adultKind, value: row.adultValue },
    child: { kind: row.childKind, value: row.childValue },
    capacity: { maxGuests: row.maxGuests, maxAdults: row.maxAdults },
    isEditable: row.isActive && row.archivedAt === null,
    updatedAt: row.updatedAt.toISOString(),
  } as OccupancyPricingConfig;
}

/** The audit payload: the fields a change can actually alter. */
function auditShape(row: OccupancyAssignmentRow): Prisma.InputJsonObject {
  return {
    roomTypeCode: row.roomTypeCode,
    baseOccupancy: row.baseOccupancy,
    includedChildren: row.includedChildren,
    occupancyPricingEnabled: row.enabled,
    extraAdultChargeKind: row.adultKind,
    extraAdultChargeValue: row.adultValue,
    extraChildChargeKind: row.childKind,
    extraChildChargeValue: row.childValue,
  };
}
