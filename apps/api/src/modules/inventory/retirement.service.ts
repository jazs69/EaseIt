/**
 * Retiring a room or a room type (RM-02 / RM-04).
 *
 * ===========================================================================
 * RETIREMENT IS SOFT AND ONE-WAY. Stays, blocks, inventory and folio history
 * all reference these rows, so nothing is deleted; `retiredAt` is set and is
 * never cleared. Retiring an already-retired row is an idempotent success.
 *
 * WHAT REFUSES IT -- each with the typed `EntityInUseError` (409):
 *
 *   ROOM       a stay on it that has not finished and departs after today;
 *              an active block on it covering tonight or later; or a night
 *              from today on where removing the room would leave more sold
 *              and blocked than physical + overbooking allowance.
 *   ROOM TYPE  any room of the type still in service; any unfinished stay of
 *              the category departing after today (assigned or not); or an
 *              active block on it.
 *
 * "Today" is the clock's UTC calendar date, the same anchor the inventory
 * horizon uses: no running code advances `property.businessDate` yet
 * (limitation C1), so it cannot be the anchor.
 *
 * CAPACITY. A retired room stops being stock, so `physical` drops by one on
 * every configured night from today on, in the same transaction, under the
 * row-then-inventory lock order of section 3.1.1. The horizon generator also
 * stops counting it for nights created later.
 *
 * KNOWN RACE (same class as the room-block limitation F1): check-in and a
 * same-category room move take no lock on the `room` row, so a check-in into
 * this room can commit concurrently with its retirement. Both of those paths
 * refuse a room that is already retired; only a true overlap can slip through.
 * Capacity remains correct either way, because the decrement is checked
 * against `sold + blocked` under the inventory lock.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Permission, type RoomTypeView, type RoomView } from '@repo/types';

import {
  DomainError,
  EntityInUseError,
  TenantScopeViolationError,
  TransactionConflictError,
} from '../../common/errors/domain-error.js';
import { isLockTimeout, sqlState } from '../../common/errors/sql-state.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { RetirementRepository } from './retirement.repository.js';
import { RoomRepository } from './room.repository.js';
import { toView as toRoomView } from './room.service.js';
import { RoomTypeRepository } from './room-type.repository.js';
import { toView as toRoomTypeView } from './room-type.service.js';

const MAX_ATTEMPTS = 3;
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RetirementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RetirementRepository,
    private readonly rooms: RoomRepository,
    private readonly roomTypes: RoomTypeRepository,
    private readonly clock: ClockService,
  ) {}

  async retireRoom(userId: string, codeOrId: string, roomId: string): Promise<RoomView> {
    const property = await this.authorise(userId, codeOrId);
    if (!UUID.test(roomId)) throw new TenantScopeViolationError('Room');

    const now = this.clock.now();
    const today = now.toISOString().slice(0, 10);

    await this.withRetry('room retirement', () =>
      this.repository.inTransaction(property.id, async (tx) => {
        // Room row FIRST, then inventory (section 3.1.1).
        const room = await this.repository.lockRoom(tx, property.id, roomId);
        if (room === null) throw new TenantScopeViolationError('Room');
        if (room.retiredAt !== null) return;

        const stays = await this.repository.liveStaysOnRoom(tx, property.id, roomId, today);
        if (stays.length > 0) {
          throw new EntityInUseError(
            'room',
            'it has current or future stays. Move or cancel them first.',
            { confirmationCodes: stays },
          );
        }

        const blocks = await this.repository.activeBlocksOnRoom(tx, property.id, roomId, today);
        if (blocks > 0) {
          throw new EntityInUseError('room', 'it has an active block. Release it first.', {
            activeBlocks: blocks,
          });
        }

        const nights = await this.repository.lockFutureNights(
          tx,
          property.id,
          room.roomTypeId,
          today,
        );
        // Only nights that still count this room lose one; see L1 in the repository.
        const broken = nights.find(
          (night) =>
            night.physical > 0 &&
            night.sold + night.blocked > night.physical - 1 + night.overbookingAllowance,
        );
        if (broken !== undefined) {
          throw new EntityInUseError(
            'room',
            `its category is fully committed on ${broken.stayDate}, so removing a room ` +
              'would oversell that night.',
            { stayDate: broken.stayDate, sold: broken.sold, blocked: broken.blocked },
          );
        }

        const decremented = await this.repository.decrementPhysical(
          tx,
          property.id,
          room.roomTypeId,
          today,
        );
        await this.repository.markRoomRetired(tx, property.id, roomId, userId, now);

        await this.repository.audit(tx, {
          propertyId: property.id,
          actorUserId: userId,
          event: 'ROOM_RETIRED',
          entityType: 'room',
          entityId: roomId,
          after: {
            retiredAt: now.toISOString(),
            number: room.number,
            roomTypeId: room.roomTypeId,
            fromDate: today,
            nightsDecremented: decremented,
          },
        });
      }),
    );

    const row = await this.rooms.findOne(property.id, roomId);
    if (row === null) throw new TenantScopeViolationError('Room');
    return toRoomView(row);
  }

  async retireRoomType(
    userId: string,
    codeOrId: string,
    roomTypeId: string,
  ): Promise<RoomTypeView> {
    const property = await this.authorise(userId, codeOrId);
    if (!UUID.test(roomTypeId)) throw new TenantScopeViolationError('Room type');

    const now = this.clock.now();
    const today = now.toISOString().slice(0, 10);

    await this.withRetry('room type retirement', () =>
      this.repository.inTransaction(property.id, async (tx) => {
        const roomType = await this.repository.lockRoomType(tx, property.id, roomTypeId);
        if (roomType === null) throw new TenantScopeViolationError('Room type');
        if (roomType.retiredAt !== null) return;

        const activeRooms = await this.repository.activeRoomsOfType(tx, property.id, roomTypeId);
        if (activeRooms > 0) {
          throw new EntityInUseError(
            'room type',
            `${String(activeRooms)} room(s) of this type are still in service. Retire them first.`,
            { activeRooms },
          );
        }

        const stays = await this.repository.liveStaysOfType(tx, property.id, roomTypeId, today);
        if (stays.length > 0) {
          throw new EntityInUseError(
            'room type',
            'it has current or future stays. Move or cancel them first.',
            { confirmationCodes: stays },
          );
        }

        const blocks = await this.repository.activeBlocksOfType(tx, property.id, roomTypeId, today);
        if (blocks > 0) {
          throw new EntityInUseError('room type', 'it has active blocks. Release them first.', {
            activeBlocks: blocks,
          });
        }

        await this.repository.markRoomTypeRetired(tx, property.id, roomTypeId, userId, now);

        await this.repository.audit(tx, {
          propertyId: property.id,
          actorUserId: userId,
          event: 'ROOM_TYPE_RETIRED',
          entityType: 'room_type',
          entityId: roomTypeId,
          after: { retiredAt: now.toISOString(), code: roomType.code },
        });
      }),
    );

    const row = await this.roomTypes.findOne(property.id, roomTypeId);
    if (row === null) throw new TenantScopeViolationError('Room type');
    return toRoomTypeView(row);
  }

  /* ---------------------------------------------------------------------- */

  private async withRetry(operation: string, work: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await work();
        return;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (isLockTimeout(error)) throw new TransactionConflictError(operation);
        const state = sqlState(error);
        if (state === null || !TRANSIENT_SQLSTATES.has(state)) throw error;
        if (attempt >= MAX_ATTEMPTS) throw new TransactionConflictError(operation);
        const backoff = 25 * attempt + Math.floor(Math.random() * 50);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  private async authorise(userId: string, codeOrId: string): Promise<{ id: string }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    requirePermissionFromGrants(grants, Permission.ROOMS_MANAGE);

    return { id: first.property.id };
  }
}
