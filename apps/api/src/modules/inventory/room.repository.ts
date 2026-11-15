/**
 * Persistence for physical rooms. No business rules here (section 5).
 *
 * ===========================================================================
 * Every statement carries `propertyId` explicitly -- there is no tenancy
 * extension and no row-level security, so the predicate IS the control.
 *
 * NOTHING IN THIS FILE WRITES `inventory_day`. Creating a room does not change
 * `physical` on rows that already exist: the inventory horizon generator
 * computes `physical` once, when it inserts a night, and nothing recomputes it.
 * That understates capacity on existing nights, which is the safe direction --
 * it can only under-sell, never oversell -- and it is limitation L1.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

/**
 * The `RoomStatus` enum as Prisma types it.
 *
 * Indexing `Prisma.RoomWhereInput['status']` instead would carry `undefined`
 * along with it, which `exactOptionalPropertyTypes` then refuses to assign
 * into an optional field. The cast is safe because every value reaching it has
 * already been validated by `roomStatusSchema` or `settableRoomStatusSchema`
 * at the boundary.
 */
type RoomStatusEnum = Exclude<Prisma.RoomCreateInput['status'], undefined>;

import { DuplicateIdentifierError } from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const ROOM_SELECT = {
  id: true,
  number: true,
  floor: true,
  status: true,
  notes: true,
  roomTypeId: true,
  roomType: { select: { code: true, name: true } },
} as const;

export interface RoomRow {
  id: string;
  number: string;
  floor: string | null;
  status: string;
  notes: string | null;
  roomTypeId: string;
  roomType: { code: string; name: string };
}

export interface RoomListFilter {
  roomTypeId?: string;
  status?: string;
  floor?: string;
  /** The last `number` of the previous page. Keyset, not offset. */
  cursor?: string;
  limit: number;
}

@Injectable()
export class RoomRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of rooms, ordered by number.
   *
   * Keyset pagination on `(propertyId, number)`, which is already unique and
   * already indexed, so the cursor is stable and the scan does not degrade on
   * later pages the way an offset would. One extra row is fetched to decide
   * whether a next cursor exists, rather than issuing a second count.
   */
  async findPage(
    propertyId: string,
    filter: RoomListFilter,
  ): Promise<{ rows: RoomRow[]; nextCursor: string | null }> {
    const rows = await this.prisma.client.room.findMany({
      where: {
        propertyId,
        ...(filter.roomTypeId === undefined ? {} : { roomTypeId: filter.roomTypeId }),
        ...(filter.status === undefined ? {} : { status: filter.status as RoomStatusEnum }),
        ...(filter.floor === undefined ? {} : { floor: filter.floor }),
        ...(filter.cursor === undefined ? {} : { number: { gt: filter.cursor } }),
      },
      select: ROOM_SELECT,
      orderBy: { number: 'asc' },
      take: filter.limit + 1,
    });

    const hasMore = rows.length > filter.limit;
    const page = hasMore ? rows.slice(0, filter.limit) : rows;
    const last = page[page.length - 1];

    return {
      rows: page,
      nextCursor: hasMore && last !== undefined ? last.number : null,
    };
  }

  /** Scoped by `propertyId` in the same predicate as the id (section 3.2). */
  async findOne(propertyId: string, roomId: string): Promise<RoomRow | null> {
    return this.prisma.client.room.findFirst({
      where: { id: roomId, propertyId },
      select: ROOM_SELECT,
    });
  }

  /** Does this property own this room type? Checked before a room names it. */
  async roomTypeExists(propertyId: string, roomTypeId: string): Promise<boolean> {
    const found = await this.prisma.client.roomType.findFirst({
      where: { id: roomTypeId, propertyId },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Is a guest checked into this room right now?
   *
   * Reads `reservation_room.status`, which check-in sets to CHECKED_IN and the
   * exclusion constraint also reads. This is the AUTHORITATIVE answer for a
   * status change -- `room.status` itself can be stale, which is precisely the
   * disagreement the status endpoint exists to avoid creating.
   */
  async hasInHouseStay(propertyId: string, roomId: string): Promise<boolean> {
    const found = await this.prisma.client.reservationRoom.findFirst({
      where: { propertyId, roomId, status: 'CHECKED_IN' },
      select: { id: true },
    });
    return found !== null;
  }

  async create(
    propertyId: string,
    input: {
      roomTypeId: string;
      number: string;
      floor: string | null;
      notes: string | null;
    },
  ): Promise<RoomRow> {
    try {
      return await this.prisma.client.room.create({
        data: { propertyId, ...input },
        select: ROOM_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateIdentifierError('room', 'number', input.number);
      }
      throw error;
    }
  }

  /** Configuration fields only. `status` and `roomTypeId` are not writable here. */
  async update(
    propertyId: string,
    roomId: string,
    input: { number?: string; floor?: string | null; notes?: string | null },
  ): Promise<RoomRow | null> {
    try {
      const updated = await this.prisma.client.room.updateMany({
        where: { id: roomId, propertyId },
        data: input,
      });
      if (updated.count === 0) return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateIdentifierError('room', 'number', input.number ?? '');
      }
      throw error;
    }

    return this.findOne(propertyId, roomId);
  }

  /**
   * Set the housekeeping status, and nothing else.
   *
   * `expectedCurrent` is in the predicate, so the write only lands if the
   * status is still what the transition was evaluated against. A zero count
   * means somebody else moved the room first and the caller is told to re-read
   * rather than having its decision applied to a state it never saw.
   */
  async setStatus(
    propertyId: string,
    roomId: string,
    expectedCurrent: string,
    next: string,
  ): Promise<RoomRow | null> {
    const updated = await this.prisma.client.room.updateMany({
      where: {
        id: roomId,
        propertyId,
        status: expectedCurrent as RoomStatusEnum,
      },
      data: { status: next as RoomStatusEnum },
    });
    if (updated.count === 0) return null;

    return this.findOne(propertyId, roomId);
  }
}
