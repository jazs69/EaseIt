/**
 * The date-wise rate calendar (scope F2).
 *
 * ===========================================================================
 * AUTHORISATION ORDER IS LOAD-BEARING. The grant is resolved first and a
 * caller with no grant gets not-found; only a caller who has already proven a
 * grant can reach a 403. Reversing the two would let a permission refusal
 * confirm that another property exists (section 3.2). Identical shape to
 * `rate-plan.service.ts` and `room-type.service.ts`.
 *
 * THEN the assignment is resolved in ONE scoped read, which settles three
 * things at once: the plan belongs to this property, the room type is really
 * assigned to the plan, and the plan is editable. Any of them failing is
 * *not found*, never 403 and never a 400 that confirms the plan exists.
 *
 * THE EFFECTIVE-RATE RULE LIVES IN `rate-calendar.policy.ts`, not here. One
 * pure function, no I/O, so F9 can call it per night and sum without dragging
 * a repository in. There is exactly one of it in the codebase.
 *
 * WHAT THIS DOES NOT TOUCH.
 *
 *   * `inventory_day`, `reservation`, `reservation_room`, `folio_line` --
 *     never read, never written. No path here enters the lock protocol of
 *     section 3.1.1, so the five existing inventory writers are unaffected
 *     and no `lock_timeout` is required: nothing contends for a row they hold.
 *   * `room_type.baseRateMinor` -- still what the booking path prices from.
 *     F2 changes no quote. That integration is F9.
 *   * Historical money. A folio line is immutable and carries its own amount,
 *     so repricing a future night cannot alter a past charge (section 3.4).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  MAX_RATE_CALENDAR_DAYS,
  Permission,
  type ClearRateCalendarRequest,
  type RateCalendarQuery,
  type RateCalendarResponse,
  type RateCalendarWriteResult,
  type UpdateRateCalendarRequest,
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
  buildCalendarWindow,
  isRangeRefusal,
  parseRange,
  type RangeRefusal,
} from './rate-calendar.policy.js';
import { RateCalendarRepository, type AssignmentRow } from './rate-calendar.repository.js';
import { RatePricingRuleRepository } from './rate-pricing-rule.repository.js';

@Injectable()
export class RateCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RateCalendarRepository,
    /**
     * F3's rules, read through their own repository rather than duplicating
     * the queries here. The calendar consults them; it does not own them.
     */
    private readonly rules: RatePricingRuleRepository,
  ) {}

  async read(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    query: RateCalendarQuery,
  ): Promise<RateCalendarResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    const assignment = await this.requireAssignment(property.id, ratePlanId, query.roomTypeId);

    return this.loadWindow(property.id, assignment, query.fromDate, query.toDate);
  }

  /**
   * Bulk upsert the listed dates. Dates not listed are untouched.
   *
   * VALIDATION IS COMPLETE BEFORE ANY WRITE, which the scope requires and
   * which the ordering below delivers: grant, then assignment, then plan
   * editability, then every date parsed. Only then does the single upsert
   * statement run, and Postgres applies all of its tuples or none.
   */
  async update(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: UpdateRateCalendarRequest,
  ): Promise<RateCalendarWriteResult> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const assignment = await this.requireAssignment(property.id, ratePlanId, request.roomTypeId);
    this.requireEditable(assignment);

    // Every date is validated as a real calendar date before anything is
    // written. The DTO has already checked the shape and rejected duplicates;
    // this catches `2026-02-30`, which matches the shape and is not a date.
    const dates = request.entries.map((entry) => entry.stayDate);
    this.requireRealDates(dates, 'entries');

    // Sorted so the statement's tuple order is deterministic. It does not
    // affect the result -- one statement, one conflict target -- but a stable
    // order makes two identical requests produce identical plans, which is
    // worth having for free.
    const entries = [...request.entries].sort((a, b) => a.stayDate.localeCompare(b.stayDate));

    const before = await this.repository.findOverrides(
      property.id,
      ratePlanId,
      request.roomTypeId,
      entries[0]?.stayDate ?? dates[0] ?? '',
      entries.at(-1)?.stayDate ?? dates[0] ?? '',
    );

    const outcome = await this.repository.upsertDays(
      property.id,
      ratePlanId,
      request.roomTypeId,
      entries,
      userId,
    );

    await this.audit(property.id, userId, 'RATE_CALENDAR_UPDATED', ratePlanId, {
      roomTypeId: request.roomTypeId,
      ratePlanId,
      // The window the change covered, so an auditor can see the span without
      // reading every date out of the arrays below.
      fromDate: entries[0]?.stayDate ?? null,
      toDate: entries.at(-1)?.stayDate ?? null,
      dateCount: entries.length,
      created: outcome.created,
      updated: outcome.updated,
      // Before/after per date. `null` in `before` means the night had no
      // override and so was priced at the default -- a different fact from an
      // override of zero, which is why it is null and not 0.
      before: entries.map((entry) => ({
        stayDate: entry.stayDate,
        amountMinor: before.get(entry.stayDate) ?? null,
      })),
      after: entries.map((entry) => ({
        stayDate: entry.stayDate,
        amountMinor: entry.amountMinor,
      })),
    });

    return {
      roomTypeId: request.roomTypeId,
      datesWritten: entries.length,
      created: outcome.created,
      updated: outcome.updated,
      cleared: 0,
      // Reloaded rather than reconstructed from the request, so the client is
      // shown what the database actually holds. The window spans the dates the
      // caller wrote, which is what they are looking at.
      calendar: await this.loadWindow(
        property.id,
        assignment,
        entries[0]?.stayDate ?? '',
        entries.at(-1)?.stayDate ?? '',
      ),
    };
  }

  /**
   * Clear the listed dates' overrides, so they fall back to the default.
   *
   * The assignment's `defaultRateMinor` is NOT touched -- clearing an override
   * removes a row from `rate_plan_day` and nothing else, which is why the
   * effective rate afterwards is the default by construction rather than by a
   * copy somebody has to keep in step.
   */
  async clear(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: ClearRateCalendarRequest,
  ): Promise<RateCalendarWriteResult> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const assignment = await this.requireAssignment(property.id, ratePlanId, request.roomTypeId);
    this.requireEditable(assignment);
    this.requireRealDates(request.stayDates, 'stayDates');

    const dates = [...request.stayDates].sort((a, b) => a.localeCompare(b));
    const first = dates[0] ?? '';
    const last = dates.at(-1) ?? '';

    const before = await this.repository.findOverrides(
      property.id,
      ratePlanId,
      request.roomTypeId,
      first,
      last,
    );

    const cleared = await this.repository.clearDays(
      property.id,
      ratePlanId,
      request.roomTypeId,
      dates,
    );

    await this.audit(property.id, userId, 'RATE_CALENDAR_CLEARED', ratePlanId, {
      roomTypeId: request.roomTypeId,
      ratePlanId,
      fromDate: first,
      toDate: last,
      dateCount: dates.length,
      cleared,
      // Only the dates that actually had an override are recorded as changed;
      // clearing an already-default night is a no-op worth nothing to an
      // auditor.
      before: dates
        .filter((stayDate) => before.has(stayDate))
        .map((stayDate) => ({ stayDate, amountMinor: before.get(stayDate) ?? null })),
      after: null,
    });

    return {
      roomTypeId: request.roomTypeId,
      datesWritten: 0,
      created: 0,
      updated: 0,
      cleared,
      calendar: await this.loadWindow(property.id, assignment, first, last),
    };
  }

  /**
   * Reads a window and assembles the response.
   *
   * Shared by the read endpoint and by both writes, so the shape a client gets
   * after a write is byte-identical to the shape it would get by re-reading --
   * there is no second assembly path that could drift.
   */
  private async loadWindow(
    propertyId: string,
    assignment: AssignmentRow,
    fromDate: string,
    toDate: string,
  ): Promise<RateCalendarResponse> {
    const range = parseRange(fromDate, toDate, MAX_RATE_CALENDAR_DAYS);
    if (isRangeRefusal(range)) throw rangeError(range);

    const overrides = await this.repository.findOverrides(
      propertyId,
      assignment.ratePlanId,
      assignment.roomTypeId,
      fromDate,
      toDate,
    );

    /**
     * F3: the rules that can price THIS category under THIS plan, plus the
     * property's own weekend definition.
     *
     * Both are fetched in parallel with each other because neither depends on
     * the other, and both are needed before a single day can be resolved.
     * They are filtered in the database to this room type, so a plan with
     * fifteen rules across five categories does not ship all seventy-five
     * price rows to resolve one column of the grid.
     */
    const [rules, weekendDays] = await Promise.all([
      this.rules.findForResolution(propertyId, assignment.ratePlanId, assignment.roomTypeId),
      this.rules.weekendDays(propertyId),
    ]);

    // The ONE place a day's price is decided, via the shared resolver. The
    // controller does not decide it, the repository does not, and the frontend
    // explicitly does not.
    const days = buildCalendarWindow(
      range.dates,
      assignment.defaultRateMinor,
      overrides,
      rules,
      weekendDays,
    );

    return {
      ratePlanId: assignment.ratePlanId,
      ratePlanCode: assignment.ratePlanCode,
      roomTypeId: assignment.roomTypeId,
      roomTypeCode: assignment.roomTypeCode,
      roomTypeName: assignment.roomTypeName,
      currency: assignment.currency,
      defaultRateMinor: assignment.defaultRateMinor,
      baseOccupancy: assignment.baseOccupancy,
      fromDate: range.dates[0] ?? fromDate,
      toDate: range.dates.at(-1) ?? toDate,
      days,
      // F2's meaning, unchanged: nights carrying an EXPLICIT date override.
      // A seasonal rate is not an override and is not counted here.
      overrideCount: days.filter((day) => day.hasOverride).length,
      weekendDays,
      ruleDrivenCount: days.filter(
        (day) => day.source === 'SEASONAL' || day.source === 'WEEKDAY' || day.source === 'WEEKEND',
      ).length,
      ambiguousCount: days.filter((day) => day.isAmbiguous).length,
      isEditable: assignment.isActive && assignment.archivedAt === null,
    } as RateCalendarResponse;
  }

  /**
   * The assignment, or not-found.
   *
   * "No such plan", "no such room type", "that room type is not assigned to
   * this plan" and "that plan belongs to another property" all answer the same
   * way, deliberately. Distinguishing them would tell a caller which ids exist
   * at a property they hold no grant at (section 3.2), and the operator-facing
   * UI never needs the distinction because it only ever offers assignments it
   * has already been shown.
   */
  private async requireAssignment(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
  ): Promise<AssignmentRow> {
    const assignment = await this.repository.findAssignment(propertyId, ratePlanId, roomTypeId);
    if (assignment === null) throw new TenantScopeViolationError('Rate plan assignment');
    return assignment;
  }

  /**
   * An inactive or archived plan's calendar is read-only.
   *
   * Requirement 11 of the scope. Refused as an illegal state transition rather
   * than a validation failure, because the request is well formed -- the plan
   * is simply not in a state that accepts pricing, which is the same category
   * of refusal as editing an archived plan.
   */
  private requireEditable(assignment: AssignmentRow): void {
    if (assignment.archivedAt !== null) {
      throw new InvalidStateTransitionError('rate plan', 'ARCHIVED', 'repriced');
    }
    if (!assignment.isActive) {
      throw new InvalidStateTransitionError('rate plan', 'INACTIVE', 'repriced');
    }
  }

  /**
   * Every date must be a real calendar date.
   *
   * `businessDateSchema` in the DTO checks the shape and that `Date.parse`
   * accepts it -- but `Date.parse('2026-02-30T00:00:00Z')` succeeds and rolls
   * over to 2 March. `parseRange`'s strict parse catches that by re-formatting
   * and comparing, and this applies the same check to a bare list.
   */
  private requireRealDates(dates: readonly string[], field: string): void {
    for (const date of dates) {
      const parsed = parseRange(date, date, MAX_RATE_CALENDAR_DAYS);
      if (isRangeRefusal(parsed)) {
        throw new ValidationFailedError({ [field]: `"${date}" is not a real calendar date.` });
      }
    }
  }

  /**
   * Audit every calendar mutation: actor, property, entity, before/after
   * (section 3.4).
   *
   * Written after the mutation rather than inside one transaction with it --
   * the same known weakening the sibling rate-plan, room-type and room
   * services carry, and for the same reason: the repository contract does not
   * accept a transaction client. The scope asks for one transaction "where
   * practical"; doing it here would mean reshaping the raw bulk upsert to run
   * inside an interactive transaction, which would reintroduce the held-open
   * transaction that statement exists to avoid. Recorded rather than left to
   * be discovered: a crash between the two statements loses the audit row, not
   * the price change.
   *
   * `entityType` is `rate_plan_day` and `entityId` is the PLAN, not a day row:
   * one write spans up to 180 rows and there is no single day id to name. The
   * payload carries the room type and the date window, which is what an
   * auditor actually searches by.
   */
  private async audit(
    propertyId: string,
    actorUserId: string,
    event: string,
    ratePlanId: string,
    payload: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: {
        propertyId,
        actorUserId,
        event,
        entityType: 'rate_plan_day',
        entityId: ratePlanId,
        before: Prisma.DbNull,
        after: payload,
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
 * A range refusal as the typed error the caller should see.
 *
 * Kept out of the policy file so that file stays free of Nest and of HTTP, and
 * out of the service body so the three call sites cannot answer differently
 * for the same refusal.
 */
function rangeError(refusal: RangeRefusal): ValidationFailedError {
  switch (refusal.kind) {
    case 'UNPARSEABLE':
      return new ValidationFailedError({
        [refusal.field]: 'Expected a real calendar date in YYYY-MM-DD form.',
      });
    case 'INVERTED':
      return new ValidationFailedError({
        toDate: 'The end of the range cannot be before its start.',
      });
    case 'TOO_WIDE':
      return new ValidationFailedError({
        toDate:
          `That window is ${String(refusal.days)} days. ` +
          `Ask for at most ${String(refusal.limit)} at a time.`,
      });
  }
}
