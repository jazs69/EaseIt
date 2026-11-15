/**
 * Rate-plan configuration: what price lists a property sells.
 *
 * ===========================================================================
 * AUTHORISATION ORDER IS LOAD-BEARING. The grant is resolved first and a
 * caller with no grant gets not-found; only a caller who has already proven a
 * grant can reach a 403. Reversing the two would let a permission refusal
 * confirm that another property exists (section 3.2). This is the same
 * `authorise` shape as `room-type.service.ts` and `inventory-horizon.service.ts`.
 *
 * WHAT THIS DOES NOT TOUCH.
 *
 *   * **`room_type.baseRateMinor`.** Untouched, unread, unmigrated. It is
 *     still what the booking path prices from. Integrating plans into quoting
 *     and booking is F9.
 *   * **`inventory_day`.** Not read, not written. No row of this module enters
 *     the lock protocol of section 3.1.1, so the five existing inventory
 *     writers are unaffected and no `lock_timeout` is needed here: nothing
 *     contends for a row any of them holds.
 *   * **Any reservation or folio.** No historical price can move, because no
 *     historical price points here yet.
 *
 * WHY THERE IS NO DELETE. A plan that has ever been quoted is history. When
 * F9 adds `reservation.ratePlanId` it will be an `onDelete: Restrict` foreign
 * key, so deletion stays impossible rather than being offered now and taken
 * away later. `DEACTIVATE` is the reversible stop; `ARCHIVE` is terminal. The
 * brief's "prevent deletion when reservations depend on it" is therefore
 * satisfied structurally rather than by a dependency count that would, today,
 * always be zero and so prove nothing.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { Permission } from '@repo/types';
import type {
  CreateRatePlanRequest,
  ListRatePlansQuery,
  RatePlanListResponse,
  RatePlanStatusAction,
  RatePlanView,
  UpdateRatePlanRequest,
  UpdateRatePlanRoomTypeRequest,
} from '@repo/types';

import { ClockService } from '../platform/clock.service.js';
import {
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RatePlanRepository, type RatePlanRow } from './rate-plan.repository.js';

/**
 * One audit event per action, spelled out rather than derived from the action
 * string. A derived name reads as clever and then quietly changes the audit
 * vocabulary the first time an action is renamed — and an audit row's event is
 * the thing a reader greps for years later.
 */
const AUDIT_EVENT_BY_ACTION: Record<RatePlanStatusAction['action'], string> = {
  ACTIVATE: 'RATE_PLAN_ACTIVATED',
  DEACTIVATE: 'RATE_PLAN_DEACTIVATED',
  ARCHIVE: 'RATE_PLAN_ARCHIVED',
};

@Injectable()
export class RatePlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RatePlanRepository,
    private readonly clock: ClockService,
  ) {}

  async list(
    userId: string,
    codeOrId: string,
    query: ListRatePlansQuery,
  ): Promise<RatePlanListResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);

    const rows = await this.repository.findMany(property.id, {
      status: query.status,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.roomTypeId === undefined ? {} : { roomTypeId: query.roomTypeId }),
    });

    return { items: rows.map(toView), currency: property.currency };
  }

  async detail(userId: string, codeOrId: string, ratePlanId: string): Promise<RatePlanView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);

    const row = await this.repository.findOne(property.id, ratePlanId);
    if (row === null) throw new TenantScopeViolationError('Rate plan');

    return toView(row);
  }

  async create(
    userId: string,
    codeOrId: string,
    request: CreateRatePlanRequest,
  ): Promise<RatePlanView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);

    this.assertAssignmentCurrencies(property.currency, request.roomTypes);
    await this.assertRoomTypesAreOwned(
      property.id,
      request.roomTypes.map((entry) => entry.roomTypeId),
    );

    const row = await this.repository.create(property.id, {
      code: request.code,
      name: request.name,
      description: request.description ?? null,
      kind: request.kind,
      // Taken from the property, never from the request. The DTO comment
      // explains why a client-chosen currency is not a configuration anyone
      // wants to be able to express.
      currency: property.currency,
      sortOrder: request.sortOrder,
      createdByUserId: userId,
      // F2: one price per category, carried on the assignment. Integer minor
      // units, paired with the plan's currency, never a float (3.4).
      roomTypes: request.roomTypes.map((entry) => ({
        roomTypeId: entry.roomTypeId,
        defaultRateMinor: entry.defaultRate.amountMinor,
        baseOccupancy: entry.baseOccupancy,
      })),
    });

    await this.audit(
      property.id,
      userId,
      'RATE_PLAN_CREATED',
      row.id,
      Prisma.DbNull,
      auditShape(row),
    );

    return toView(row);
  }

  async update(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: UpdateRatePlanRequest,
  ): Promise<RatePlanView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);

    // Read the before-state through the same tenancy predicate, so the audit
    // row cannot be written about another property's plan.
    const before = await this.repository.findOne(property.id, ratePlanId);
    if (before === null) throw new TenantScopeViolationError('Rate plan');

    // An archived plan is terminal. Editing one would produce configuration
    // nobody can ever sell, and would make the archive a soft state the UI has
    // to keep explaining.
    if (before.archivedAt !== null) {
      throw new InvalidStateTransitionError('rate plan', 'ARCHIVED', 'edited');
    }

    if (request.roomTypes !== undefined) {
      this.assertAssignmentCurrencies(property.currency, request.roomTypes);
      await this.assertRoomTypesAreOwned(
        property.id,
        request.roomTypes.map((entry) => entry.roomTypeId),
      );
    }

    const after = await this.repository.update(
      property.id,
      ratePlanId,
      {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder }),
      },
      // The repository applies this as a DIFF, so an assignment present before
      // and after keeps its row and therefore keeps its date-wise overrides.
      // Only a genuinely removed category loses its calendar.
      request.roomTypes?.map((entry) => ({
        roomTypeId: entry.roomTypeId,
        defaultRateMinor: entry.defaultRate.amountMinor,
        baseOccupancy: entry.baseOccupancy,
      })),
    );

    // Null here means the row vanished between the two statements. Reported as
    // not-found rather than retried: the operator was editing something that
    // no longer exists.
    if (after === null) throw new TenantScopeViolationError('Rate plan');

    await this.audit(
      property.id,
      userId,
      'RATE_PLAN_UPDATED',
      ratePlanId,
      auditShape(before),
      auditShape(after),
    );

    return toView(after);
  }

  /**
   * Activate, deactivate or archive.
   *
   * A separate endpoint from `update` so that "stop selling this" is never a
   * side effect of an edit, and so the audit event names what actually
   * happened rather than recording a boolean flip inside a field diff.
   *
   * Every transition is checked against the current state and refused when it
   * is a no-op or illegal, rather than silently succeeding: an operator who
   * clicks Activate on an archived plan needs to be told why nothing changed.
   */
  async setStatus(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: RatePlanStatusAction,
  ): Promise<RatePlanView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);

    const before = await this.repository.findOne(property.id, ratePlanId);
    if (before === null) throw new TenantScopeViolationError('Rate plan');

    const current =
      before.archivedAt !== null ? 'ARCHIVED' : before.isActive ? 'ACTIVE' : 'INACTIVE';

    if (current === 'ARCHIVED') {
      // Terminal in both directions. There is deliberately no UNARCHIVE: a
      // plan that might come back should have been deactivated.
      throw new InvalidStateTransitionError('rate plan', current, request.action);
    }

    const next = ((): { isActive: boolean; archivedAt: Date | null } => {
      switch (request.action) {
        case 'ACTIVATE':
          if (current === 'ACTIVE') {
            throw new InvalidStateTransitionError('rate plan', current, request.action);
          }
          return { isActive: true, archivedAt: null };
        case 'DEACTIVATE':
          if (current === 'INACTIVE') {
            throw new InvalidStateTransitionError('rate plan', current, request.action);
          }
          return { isActive: false, archivedAt: null };
        case 'ARCHIVE':
          // Both fields together, because the database asserts the pair
          // (`rate_plan_archived_implies_inactive`). The clock is injected so
          // this is testable and so the instant is the one the rest of the
          // system agrees on (section 5).
          return { isActive: false, archivedAt: this.clock.now() };
      }
    })();

    const after = await this.repository.setStatus(property.id, ratePlanId, next);
    if (after === null) throw new TenantScopeViolationError('Rate plan');

    await this.audit(
      property.id,
      userId,
      AUDIT_EVENT_BY_ACTION[request.action],
      ratePlanId,
      auditShape(before),
      auditShape(after),
    );

    return toView(after);
  }

  /**
   * Update ONE room type's default rate within a plan (F2 requirement 4D).
   *
   * DOES NOT TOUCH DATE-WISE OVERRIDES, which is requirement 5. That is a
   * property of the model rather than of this code: the default is the
   * fallback for nights with no `rate_plan_day` row, so changing it leaves
   * every deliberately-priced night exactly as it was. Nothing here reads or
   * writes `rate_plan_day`.
   */
  async updateRoomTypeRate(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    roomTypeId: string,
    request: UpdateRatePlanRoomTypeRequest,
  ): Promise<RatePlanView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);

    const before = await this.repository.findOne(property.id, ratePlanId);
    if (before === null) throw new TenantScopeViolationError('Rate plan');

    if (before.archivedAt !== null) {
      throw new InvalidStateTransitionError('rate plan', 'ARCHIVED', 'repriced');
    }

    // The category must already be assigned. Not-found rather than a
    // validation error, so the answer is the same whether the assignment is
    // missing or belongs to another property (section 3.2).
    const assigned = before.roomTypes.some((entry) => entry.roomTypeId === roomTypeId);
    if (!assigned) throw new TenantScopeViolationError('Rate plan assignment');

    if (request.defaultRate !== undefined) {
      this.assertCurrencyMatches(property.currency, request.defaultRate.currency);
    }

    const after = await this.repository.updateAssignment(property.id, ratePlanId, roomTypeId, {
      ...(request.defaultRate === undefined
        ? {}
        : { defaultRateMinor: request.defaultRate.amountMinor }),
      ...(request.baseOccupancy === undefined ? {} : { baseOccupancy: request.baseOccupancy }),
    });

    if (after === null) throw new TenantScopeViolationError('Rate plan assignment');

    await this.audit(
      property.id,
      userId,
      'RATE_PLAN_ROOM_TYPE_REPRICED',
      ratePlanId,
      auditShape(before),
      auditShape(after),
    );

    return toView(after);
  }

  /**
   * A plan's money must be in the property's own currency.
   *
   * Refused rather than converted. Converting silently is how a rate becomes
   * wrong by a factor of eighty, and `Money` in `packages/types` throws on
   * mixed currencies for the same reason (section 3.4).
   */
  private assertCurrencyMatches(propertyCurrency: string, requested: string): void {
    if (requested !== propertyCurrency) {
      throw new ValidationFailedError({
        'defaultRate.currency':
          `This property prices in ${propertyCurrency}. ` +
          `A rate plan cannot be denominated in ${requested}.`,
      });
    }
  }

  /**
   * Every assignment's rate must be in the property's currency.
   *
   * Checked per entry so the error names the offending index rather than the
   * request as a whole -- with several categories in one request, "wrong
   * currency" without a position is not actionable.
   */
  private assertAssignmentCurrencies(
    propertyCurrency: string,
    entries: readonly { defaultRate: { currency: string } }[],
  ): void {
    entries.forEach((entry, index) => {
      if (entry.defaultRate.currency !== propertyCurrency) {
        throw new ValidationFailedError({
          [`roomTypes.${String(index)}.defaultRate.currency`]:
            `This property prices in ${propertyCurrency}. ` +
            `A rate plan cannot be denominated in ${entry.defaultRate.currency}.`,
        });
      }
    });
  }

  /**
   * Every room type named must belong to this property.
   *
   * The composite foreign key would refuse a foreign id anyway -- that is the
   * real guarantee (section 3.2) -- but it would arrive as a driver error. This
   * turns it into a 400 naming the field, and it does not disclose whether the
   * unknown ids exist elsewhere: the message is the same for a deleted id and
   * for another hotel's.
   */
  private async assertRoomTypesAreOwned(propertyId: string, roomTypeIds: string[]): Promise<void> {
    const owned = await this.repository.countOwnedRoomTypes(propertyId, roomTypeIds);
    if (owned !== roomTypeIds.length) {
      throw new ValidationFailedError({
        roomTypeIds: 'One or more of those room types is not a category of this property.',
      });
    }
  }

  /**
   * Audit every mutation: actor, property, entity, before/after (section 3.4).
   *
   * Written after the mutation rather than inside one transaction with it,
   * which is the same known weakening of that section's "same transaction"
   * rule that `room-type.service.ts` and `room.service.ts` carry, and for the
   * same reason: the repository contract does not accept a transaction client,
   * and reshaping it is not in this increment's scope. Recorded here rather
   * than left to be discovered -- a crash between the two statements loses the
   * audit row, not the change.
   */
  private async audit(
    propertyId: string,
    actorUserId: string,
    event: string,
    entityId: string,
    // `Prisma.DbNull` writes a SQL NULL, which is what "there was no before
    // state" means. A plain `null` would be the JSON value `null` -- a
    // different fact, and one a reader could not distinguish from a recorded
    // empty state.
    before: Prisma.InputJsonValue | typeof Prisma.DbNull,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: {
        propertyId,
        actorUserId,
        event,
        entityType: 'rate_plan',
        entityId,
        before,
        after,
      },
    });
  }

  /**
   * See the identical helper in `room-type.service.ts`.
   *
   * `currency` is selected here as well, because every write needs it and
   * fetching the property twice to learn what it prices in would be a second
   * round trip for a value this query already has in hand.
   */
  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<{ id: string; currency: string }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, currency: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    requirePermissionFromGrants(grants, required);

    return { id: first.property.id, currency: first.property.currency };
  }
}

/**
 * Prisma row to wire shape. Explicit, never a spread: a Prisma model is a
 * persistence detail and returning one leaks `propertyId`, `createdByUserId`
 * and every future addition (section 5).
 *
 * Instants cross the wire as ISO-8601 UTC strings, calendar dates as
 * `YYYY-MM-DD`. These are instants (section 3.3).
 */
function toView(row: RatePlanRow): RatePlanView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    currency: row.currency,
    isActive: row.isActive,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    sortOrder: row.sortOrder,
    // F2: each assignment carries its own price. There is deliberately no
    // plan-level rate to fall back to -- two sources for one price is the
    // ambiguity the correction removed.
    roomTypes: row.roomTypes.map((link) => ({
      roomTypeId: link.roomTypeId,
      code: link.roomType.code,
      name: link.roomType.name,
      defaultRate: { amountMinor: link.defaultRateMinor, currency: row.currency },
      baseOccupancy: link.baseOccupancy,
      overrideCount: link._count.days,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The audit payload: the fields a change can actually alter. */
function auditShape(row: RatePlanRow): Prisma.InputJsonObject {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    currency: row.currency,
    isActive: row.isActive,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    sortOrder: row.sortOrder,
    // Ordered by the repository's `orderBy`, so a diff between two audit rows
    // reflects a real change of assignment or price rather than a change of
    // row order. Each entry carries its own rate, so a repricing of one
    // category is visible as exactly that.
    roomTypes: row.roomTypes.map((link) => ({
      roomTypeId: link.roomTypeId,
      defaultRateMinor: link.defaultRateMinor,
      baseOccupancy: link.baseOccupancy,
    })),
  };
}
