/**
 * Physical rooms, and their housekeeping status.
 *
 * ===========================================================================
 * TWO OPERATIONS, TWO PERMISSIONS. Configuration (`rooms:manage`) and status
 * (`housekeeping:update_status`) are separate because housekeeping must be
 * able to mark a room clean without also being able to redefine the property's
 * rooms. The configuration update therefore REFUSES `status` and `roomTypeId`
 * in its body rather than silently dropping them.
 *
 * THIS SERVICE NEVER WRITES `inventory_day`. Neither creating a room nor
 * changing its status alters capacity on nights that already exist:
 *
 *   * `physical` is computed once, by the inventory generator, and never
 *     recomputed. A new room therefore adds capacity only to nights created
 *     after it (limitation L1). Understated capacity can only under-sell.
 *
 *   * The only status that changes physical eligibility is OUT_OF_ORDER --
 *     generation counts every room whose status is not that -- and this
 *     endpoint cannot set or clear it. So no permitted transition can move
 *     capacity, and this service needs no inventory lock at all.
 *
 * NO AVAILABILITY IS REPORTED. Whether a room is withheld from sale lives in
 * `room_block`, which has no read endpoint yet. A field that was always false
 * would read as "not blocked" rather than "unknown", so there is no field.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  Permission,
  type ChangeRoomStatusRequest,
  type CreateRoomRequest,
  type RoomListQuery,
  type RoomListResponse,
  type RoomView,
  type UpdateRoomRequest,
} from '@repo/types';

import {
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RoomRepository, type RoomRow } from './room.repository.js';
import {
  evaluateStatusTransition,
  targetAssertsOccupancy,
  type RoomStatusValue,
  type StatusRefusal,
} from './room-status.policy.js';

/**
 * The refusal copy for a status that cannot be set here.
 *
 * Deliberately names no workflow. Room blocks are the supported way to make a
 * room unavailable, but the block endpoints do not exist yet, and pointing an
 * operator at a feature they cannot reach is worse than saying less.
 */
const UNSETTABLE_STATUS_MESSAGE =
  'This status cannot be set here. Room availability is managed separately and ' +
  'is not yet available in this release.';

@Injectable()
export class RoomService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RoomRepository,
  ) {}

  async list(userId: string, codeOrId: string, query: RoomListQuery): Promise<RoomListResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RESERVATIONS_READ);

    const page = await this.repository.findPage(property.id, {
      ...(query.roomTypeId === undefined ? {} : { roomTypeId: query.roomTypeId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.floor === undefined ? {} : { floor: query.floor }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });

    return { items: page.rows.map(toView), nextCursor: page.nextCursor };
  }

  async create(userId: string, codeOrId: string, request: CreateRoomRequest): Promise<RoomView> {
    const property = await this.authorise(userId, codeOrId, Permission.ROOMS_MANAGE);

    // The category must be this property's. Checked rather than trusted: a
    // roomTypeId is a client-supplied identifier like any other. The composite
    // FK would also refuse it, but as a 500-shaped driver error rather than a
    // message an operator can act on.
    if (!(await this.repository.roomTypeExists(property.id, request.roomTypeId))) {
      throw new ValidationFailedError({
        roomTypeId: 'That room type does not belong to this property.',
      });
    }

    const row = await this.repository.create(property.id, {
      roomTypeId: request.roomTypeId,
      number: request.number,
      floor: request.floor ?? null,
      notes: request.notes ?? null,
    });

    await this.audit(property.id, userId, 'ROOM_CREATED', row.id, Prisma.DbNull, auditShape(row));

    return toView(row);
  }

  async update(
    userId: string,
    codeOrId: string,
    roomId: string,
    request: UpdateRoomRequest,
  ): Promise<RoomView> {
    const property = await this.authorise(userId, codeOrId, Permission.ROOMS_MANAGE);

    const before = await this.repository.findOne(property.id, roomId);
    if (before === null) throw new TenantScopeViolationError('Room');

    const after = await this.repository.update(property.id, roomId, {
      ...(request.number === undefined ? {} : { number: request.number }),
      ...(request.floor === undefined ? {} : { floor: request.floor }),
      ...(request.notes === undefined ? {} : { notes: request.notes }),
    });
    if (after === null) throw new TenantScopeViolationError('Room');

    await this.audit(
      property.id,
      userId,
      'ROOM_UPDATED',
      roomId,
      auditShape(before),
      auditShape(after),
    );

    return toView(after);
  }

  /**
   * Change the housekeeping status.
   *
   * Two gates, in order. The matrix is a cheap pre-check over the stored
   * status; the live `reservation_room` read is the authority, because
   * `room.status` can itself be stale and this endpoint exists to stop the two
   * representations disagreeing about whether anyone is in the room.
   */
  async changeStatus(
    userId: string,
    codeOrId: string,
    roomId: string,
    request: ChangeRoomStatusRequest,
  ): Promise<RoomView> {
    const property = await this.authorise(userId, codeOrId, Permission.HOUSEKEEPING_UPDATE_STATUS);

    const before = await this.repository.findOne(property.id, roomId);
    if (before === null) throw new TenantScopeViolationError('Room');

    const current = before.status as RoomStatusValue;
    const target = request.status as RoomStatusValue;

    const verdict = evaluateStatusTransition(current, target);
    if (!verdict.allowed) {
      throw new ValidationFailedError({ status: refusalMessage(verdict.refusal, current) });
    }

    // The live assignment decides. An in-house stay is a `reservation_room`
    // row at CHECKED_IN, which is what check-in writes and what the exclusion
    // constraint reads.
    const inHouse = await this.repository.hasInHouseStay(property.id, roomId);
    if (targetAssertsOccupancy(target) && !inHouse) {
      throw new ValidationFailedError({
        status: 'No guest is checked into this room. Occupancy is set by check-in.',
      });
    }
    if (!targetAssertsOccupancy(target) && inHouse) {
      throw new ValidationFailedError({
        status: 'A guest is checked into this room. Use check-out or a room move.',
      });
    }

    const after = await this.repository.setStatus(property.id, roomId, current, target);
    // Zero rows means the status moved under us between the read and the
    // write. Refused rather than reapplied: the transition was evaluated
    // against a state that no longer exists.
    if (after === null) {
      throw new ValidationFailedError({
        status: 'This room’s status changed while you were working. Reload and try again.',
      });
    }

    await this.audit(
      property.id,
      userId,
      'ROOM_STATUS_CHANGED',
      roomId,
      { status: current },
      {
        status: after.status,
        ...(request.note === undefined ? {} : { note: request.note }),
      },
    );

    return toView(after);
  }

  /** See the note on `RoomTypeService.audit` about transaction scope. */
  private async audit(
    propertyId: string,
    actorUserId: string,
    event: string,
    entityId: string,
    before: Prisma.InputJsonValue | typeof Prisma.DbNull,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: { propertyId, actorUserId, event, entityType: 'room', entityId, before, after },
    });
  }

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

function refusalMessage(refusal: StatusRefusal, current: RoomStatusValue): string {
  switch (refusal.kind) {
    case 'TARGET_NOT_SETTABLE':
      return UNSETTABLE_STATUS_MESSAGE;
    case 'SOURCE_FROZEN':
      return `A room that is ${current.toLowerCase().replace(/_/g, ' ')} cannot be changed here.`;
    case 'CROSSES_INTO_OCCUPIED':
      return 'No guest is checked into this room. Occupancy is set by check-in.';
    case 'CROSSES_OUT_OF_OCCUPIED':
      return 'A guest is checked into this room. Use check-out or a room move.';
    case 'NO_CHANGE':
      return 'That is already this room’s status.';
  }
}

/** Prisma row to wire shape, explicitly (section 5). */
function toView(row: RoomRow): RoomView {
  return {
    id: row.id,
    number: row.number,
    floor: row.floor,
    roomTypeId: row.roomTypeId,
    roomTypeCode: row.roomType.code,
    roomTypeName: row.roomType.name,
    status: row.status as RoomView['status'],
    notes: row.notes,
  };
}

function auditShape(row: RoomRow): Prisma.InputJsonObject {
  return {
    number: row.number,
    floor: row.floor,
    roomTypeId: row.roomTypeId,
    status: row.status,
    notes: row.notes,
  };
}
