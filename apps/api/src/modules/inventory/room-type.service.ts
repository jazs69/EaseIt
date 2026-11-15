/**
 * Room-type configuration: what categories a property sells.
 *
 * ===========================================================================
 * AUTHORISATION ORDER IS LOAD-BEARING. The grant is resolved first and a
 * caller with no grant gets not-found; only a caller who has already proven a
 * grant can reach a 403. Reversing the two would let a permission refusal
 * confirm that another property exists (section 3.2).
 *
 * WHAT THIS DOES NOT TOUCH. Creating or renaming a category writes no
 * `inventory_day` row. Inventory generation is operator-triggered and separate,
 * and it is the only writer of `physical`. A category created today therefore
 * has no calendar until someone extends the horizon -- which the inventory
 * screen reports rather than hiding.
 *
 * Deletion and archival are absent, not forgotten: `inventory_day.roomTypeId`
 * cascades, so removing a category would destroy its calendar, and
 * cancellation refuses any stay whose nights have no inventory row. Archival
 * needs the deferred recompute to settle what happens to capacity.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { Permission, type RoomTypeListResponse, type RoomTypeView } from '@repo/types';
import type { CreateRoomTypeRequest, UpdateRoomTypeRequest } from '@repo/types';

import {
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RoomTypeRepository, type RoomTypeRow } from './room-type.repository.js';

@Injectable()
export class RoomTypeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RoomTypeRepository,
  ) {}

  async list(userId: string, codeOrId: string): Promise<RoomTypeListResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RESERVATIONS_READ);
    const rows = await this.repository.findMany(property.id);
    return { items: rows.map(toView) };
  }

  async create(
    userId: string,
    codeOrId: string,
    request: CreateRoomTypeRequest,
  ): Promise<RoomTypeView> {
    const property = await this.authorise(userId, codeOrId, Permission.ROOMS_MANAGE);

    const row = await this.repository.create(property.id, {
      code: request.code,
      name: request.name,
      description: request.description ?? null,
      maxGuests: request.maxGuests,
      maxAdults: request.maxAdults ?? null,
      // Integer minor units, paired with the currency, never a float (3.4).
      baseRateMinor: request.baseRate.amountMinor,
      currency: request.baseRate.currency,
      sortOrder: request.sortOrder,
    });

    await this.audit(
      property.id,
      userId,
      'ROOM_TYPE_CREATED',
      row.id,
      Prisma.DbNull,
      auditShape(row),
    );

    return toView(row);
  }

  async update(
    userId: string,
    codeOrId: string,
    roomTypeId: string,
    request: UpdateRoomTypeRequest,
  ): Promise<RoomTypeView> {
    const property = await this.authorise(userId, codeOrId, Permission.ROOMS_MANAGE);

    // Read the before-state through the same tenancy predicate, so the audit
    // row cannot be written about another property's category.
    const before = await this.repository.findOne(property.id, roomTypeId);
    if (before === null) throw new TenantScopeViolationError('Room type');

    // Occupancy limits are checked against the MERGED state, not the request:
    // lowering maxGuests alone can invalidate a maxAdults set months ago.
    const mergedGuests = request.maxGuests ?? before.maxGuests;
    const mergedAdults = request.maxAdults === undefined ? before.maxAdults : request.maxAdults;
    if (mergedAdults !== null && mergedAdults > mergedGuests) {
      throw new ValidationFailedError({
        maxAdults: 'The adult limit cannot exceed the total guest limit.',
      });
    }

    const after = await this.repository.update(property.id, roomTypeId, {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.maxGuests === undefined ? {} : { maxGuests: request.maxGuests }),
      ...(request.maxAdults === undefined ? {} : { maxAdults: request.maxAdults }),
      ...(request.baseRate === undefined
        ? {}
        : { baseRateMinor: request.baseRate.amountMinor, currency: request.baseRate.currency }),
      ...(request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder }),
    });

    // Null here means the row vanished between the two statements. Reported as
    // not-found rather than retried: the operator was editing something that
    // no longer exists.
    if (after === null) throw new TenantScopeViolationError('Room type');

    await this.audit(
      property.id,
      userId,
      'ROOM_TYPE_UPDATED',
      roomTypeId,
      auditShape(before),
      auditShape(after),
    );

    return toView(after);
  }

  /**
   * Audit every mutation, using the existing convention: actor, property,
   * entity, before/after (section 3.4).
   *
   * Written after the mutation rather than inside one transaction with it,
   * which is a known weakening of that section's "same transaction" rule.
   * Doing it properly needs the repository to accept a transaction client, and
   * this increment's scope does not extend to reshaping the repository
   * contract. Recorded here rather than left to be discovered: a crash between
   * the two statements loses the audit row, not the change.
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
        entityType: 'room_type',
        entityId,
        before,
        after,
      },
    });
  }

  /** See the identical helper in `inventory-horizon.service.ts`. */
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
 * Prisma row to wire shape. Explicit, never a spread: a Prisma model is a
 * persistence detail and returning one leaks `propertyId`, the unread
 * `overbookingAllowance` column and every future addition (section 5).
 */
export function toView(row: RoomTypeRow): RoomTypeView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    maxGuests: row.maxGuests,
    maxAdults: row.maxAdults,
    baseRate: { amountMinor: row.baseRateMinor, currency: row.currency },
    sortOrder: row.sortOrder,
    roomCount: row._count.rooms,
    retiredAt: row.retiredAt === null ? null : row.retiredAt.toISOString(),
  };
}

/** The audit payload: the fields a change can actually alter. */
function auditShape(row: RoomTypeRow): Prisma.InputJsonObject {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    maxGuests: row.maxGuests,
    maxAdults: row.maxAdults,
    baseRateMinor: row.baseRateMinor,
    currency: row.currency,
    sortOrder: row.sortOrder,
  };
}
