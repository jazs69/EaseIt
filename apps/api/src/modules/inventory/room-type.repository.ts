/**
 * Persistence for room types. No business rules live here (section 5).
 *
 * ===========================================================================
 * Every statement carries `propertyId` explicitly. There is no Prisma tenancy
 * extension and no row-level security in this repository -- section 3.2
 * describes both and neither is implemented -- so the predicate IS the tenancy
 * control, not a convenience on top of one.
 *
 * `select` is always explicit. A bare `findMany` would widen the response
 * contract silently the next time a column is added to `room_type`, and would
 * publish `propertyId` and `overbookingAllowance` -- the latter being a column
 * nothing reads and which must not appear to be authoritative.
 *
 * `P2002` is translated here, at the boundary, so a unique-constraint
 * violation reaches the caller as a typed conflict rather than as a driver
 * code (section 5).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { DuplicateIdentifierError } from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** The columns every read of a room type returns. */
const ROOM_TYPE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  maxGuests: true,
  maxAdults: true,
  baseRateMinor: true,
  currency: true,
  sortOrder: true,
  retiredAt: true,
  // Active rooms only: a retired room is no longer stock.
  _count: { select: { rooms: { where: { retiredAt: null } } } },
} as const;

export interface RoomTypeRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  maxGuests: number;
  maxAdults: number | null;
  baseRateMinor: number;
  currency: string;
  sortOrder: number;
  retiredAt: Date | null;
  _count: { rooms: number };
}

export interface RoomTypeWriteInput {
  name?: string;
  description?: string | null;
  maxGuests?: number;
  maxAdults?: number | null;
  baseRateMinor?: number;
  currency?: string;
  sortOrder?: number;
}

/**
 * Which unique constraint a `P2002` came from, mapped to the field a form
 * would mark. Read from `meta.target`, which Prisma populates with the
 * constraint or column names.
 */
function duplicateField(error: Prisma.PrismaClientKnownRequestError): 'code' | 'name' {
  const target = JSON.stringify(error.meta?.['target'] ?? '');
  return target.includes('name') ? 'name' : 'code';
}

@Injectable()
export class RoomTypeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(propertyId: string): Promise<RoomTypeRow[]> {
    return this.prisma.client.roomType.findMany({
      where: { propertyId },
      select: ROOM_TYPE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  /**
   * One room type, scoped by `propertyId` in the SAME predicate as the id.
   *
   * Not `findUnique` on the id alone followed by a property comparison: a
   * lookup that can find another property's row and then reject it has already
   * confirmed that row exists. Not found is the only correct answer (3.2).
   */
  async findOne(propertyId: string, roomTypeId: string): Promise<RoomTypeRow | null> {
    return this.prisma.client.roomType.findFirst({
      where: { id: roomTypeId, propertyId },
      select: ROOM_TYPE_SELECT,
    });
  }

  async create(
    propertyId: string,
    input: {
      code: string;
      name: string;
      description: string | null;
      maxGuests: number;
      maxAdults: number | null;
      baseRateMinor: number;
      currency: string;
      sortOrder: number;
    },
  ): Promise<RoomTypeRow> {
    try {
      return await this.prisma.client.roomType.create({
        data: { propertyId, ...input },
        select: ROOM_TYPE_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const field = duplicateField(error);
        throw new DuplicateIdentifierError(
          'room type',
          field,
          field === 'name' ? input.name : input.code,
        );
      }
      throw error;
    }
  }

  /**
   * Update, returning null when the row is not this property's.
   *
   * `updateMany` with both predicates rather than `update` on the id: a
   * zero-count result is indistinguishable from "no such row", which is what
   * a caller without a grant must be told.
   */
  async update(
    propertyId: string,
    roomTypeId: string,
    input: RoomTypeWriteInput,
  ): Promise<RoomTypeRow | null> {
    try {
      const updated = await this.prisma.client.roomType.updateMany({
        where: { id: roomTypeId, propertyId },
        data: input,
      });
      if (updated.count === 0) return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateIdentifierError('room type', 'name', input.name ?? '');
      }
      throw error;
    }

    return this.findOne(propertyId, roomTypeId);
  }
}
