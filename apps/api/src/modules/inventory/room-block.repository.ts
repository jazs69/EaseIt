/**
 * Persistence for room blocks, and the `inventory_day.blocked` counter they
 * drive.
 *
 * ===========================================================================
 * THIS IS AN `inventory_day` WRITER, so it follows CLAUDE.md section 3.1.1:
 *
 *   * `lock_timeout` is set transaction-locally, from the shared
 *     `ROW_LOCK_TIMEOUT_MS`, before the first blocking statement.
 *   * A release locks the `room_block` row first (scoped by `propertyId` in the
 *     same predicate as the id), THEN `inventory_day`. A create has no
 *     existing row to contend for, so it locks inventory first -- the same
 *     reasoning that lets `create-reservation` do so.
 *   * `inventory_day` is always locked
 *     `ORDER BY "stayDate" ASC, "roomTypeId" ASC FOR UPDATE`.
 *
 * Every statement carries `propertyId` explicitly. There is no tenancy
 * extension and no RLS (MT-02..04), so the predicate is the control.
 *
 * No business rules here: whether a block is allowed is decided by the
 * service from the facts these methods return.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma, type RoomBlockReason, type RoomBlockStatus } from '@repo/database';

import { ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** The transaction a block operation runs in, for callers composing one (MA-01). */
export type BlockTx = Tx;

/** Generous for at most 730 rows; the lock wait itself is bounded separately. */
const TRANSACTION_TIMEOUT_MS = 10_000;
const TRANSACTION_MAX_WAIT_MS = 5_000;

export interface LockedNight {
  stayDate: string;
  physical: number;
  sold: number;
  blocked: number;
}

export interface RoomBlockRow {
  id: string;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  roomId: string | null;
  roomNumber: string | null;
  rooms: number;
  /** Inclusive, `YYYY-MM-DD`. */
  fromDate: string;
  /** EXCLUSIVE, `YYYY-MM-DD`, exactly as stored. */
  throughDateExclusive: string;
  reason: RoomBlockReason;
  note: string | null;
  status: RoomBlockStatus;
  createdByUserId: string;
  releasedByUserId: string | null;
  releasedAt: Date | null;
}

const ROW_SELECT = {
  id: true,
  roomTypeId: true,
  roomId: true,
  rooms: true,
  fromDate: true,
  throughDate: true,
  reason: true,
  note: true,
  status: true,
  createdByUserId: true,
  releasedByUserId: true,
  releasedAt: true,
  roomType: { select: { code: true, name: true } },
  room: { select: { number: true } },
} as const satisfies Prisma.RoomBlockSelect;

type SelectedRow = Prisma.RoomBlockGetPayload<{ select: typeof ROW_SELECT }>;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function utcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toRow(row: SelectedRow): RoomBlockRow {
  return {
    id: row.id,
    roomTypeId: row.roomTypeId,
    roomTypeCode: row.roomType.code,
    roomTypeName: row.roomType.name,
    roomId: row.roomId,
    roomNumber: row.room?.number ?? null,
    rooms: row.rooms,
    fromDate: dateOnly(row.fromDate),
    throughDateExclusive: dateOnly(row.throughDate),
    reason: row.reason,
    note: row.note,
    status: row.status,
    createdByUserId: row.createdByUserId,
    releasedByUserId: row.releasedByUserId,
    releasedAt: row.releasedAt,
  };
}

@Injectable()
export class RoomBlockRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One short transaction with a bounded lock wait.
   *
   * `lock_timeout` is the third argument `true` -- `SET LOCAL` semantics, so it
   * reverts at COMMIT/ROLLBACK and never changes the global setting.
   */
  async inTransaction<T>(propertyId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
        return work(tx);
      },
      {
        maxWait: TRANSACTION_MAX_WAIT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
        isolationLevel: 'ReadCommitted',
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /*  Reads outside a transaction (validation, listing)                     */
  /* ---------------------------------------------------------------------- */

  async roomTypeExists(propertyId: string, roomTypeId: string): Promise<boolean> {
    const count = await this.prisma.client.roomType.count({
      // A retired category has no capacity left to withhold.
      where: { id: roomTypeId, propertyId, retiredAt: null },
    });
    return count > 0;
  }

  async findRoom(
    propertyId: string,
    roomId: string,
  ): Promise<{ id: string; roomTypeId: string; number: string } | null> {
    return this.prisma.client.room.findFirst({
      // A retired room is no longer stock, so blocking it would withhold twice.
      where: { id: roomId, propertyId, retiredAt: null },
      select: { id: true, roomTypeId: true, number: true },
    });
  }

  async findById(propertyId: string, blockId: string): Promise<RoomBlockRow | null> {
    const row = await this.prisma.client.roomBlock.findFirst({
      where: { id: blockId, propertyId },
      select: ROW_SELECT,
    });
    return row === null ? null : toRow(row);
  }

  /**
   * Newest first, `limit + 1` rows so the caller can tell whether another
   * page exists without a second count. The cursor is resolved only within
   * this property: a foreign id simply matches nothing.
   */
  async list(
    propertyId: string,
    filter: {
      status?: RoomBlockStatus | undefined;
      roomTypeId?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<RoomBlockRow[]> {
    let cursorCreatedAt: Date | null = null;
    if (filter.cursor !== undefined) {
      const anchor = await this.prisma.client.roomBlock.findFirst({
        where: { id: filter.cursor, propertyId },
        select: { createdAt: true },
      });
      if (anchor === null) return [];
      cursorCreatedAt = anchor.createdAt;
    }

    const rows = await this.prisma.client.roomBlock.findMany({
      where: {
        propertyId,
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.roomTypeId === undefined ? {} : { roomTypeId: filter.roomTypeId }),
        ...(cursorCreatedAt === null || filter.cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursorCreatedAt } },
                { createdAt: cursorCreatedAt, id: { lt: filter.cursor } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
      select: ROW_SELECT,
    });
    return rows.map(toRow);
  }

  /* ---------------------------------------------------------------------- */
  /*  Inside the transaction                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * The block row, locked. Scoped by `propertyId` in the same predicate as
   * the id (section 3.1.1): another property's block is not found, and the
   * lock is never taken on a row the caller cannot see.
   */
  async lockBlock(
    tx: Tx,
    propertyId: string,
    blockId: string,
  ): Promise<{ id: string; status: RoomBlockStatus } | null> {
    const rows = await tx.$queryRaw<{ id: string; status: RoomBlockStatus }[]>`
      SELECT "id", "status"
      FROM room_block
      WHERE "id" = ${blockId}::uuid
        AND "propertyId" = ${propertyId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /** Re-read under the lock, with everything the release needs. */
  async readLockedBlock(tx: Tx, propertyId: string, blockId: string): Promise<RoomBlockRow> {
    const row = await tx.roomBlock.findFirstOrThrow({
      where: { id: blockId, propertyId },
      select: ROW_SELECT,
    });
    return toRow(row);
  }

  /**
   * Lock the category's nights in the one order every writer uses.
   *
   * Returns only the rows that exist; the caller compares the count with the
   * nights it asked for, because a missing row is a configuration gap and not
   * something to paper over.
   */
  async lockNights(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    nights: readonly string[],
  ): Promise<LockedNight[]> {
    const rows = await tx.$queryRaw<
      { stay_date: Date; physical: number; sold: number; blocked: number }[]
    >`
      SELECT "stayDate" AS stay_date, "physical", "sold", "blocked"
      FROM inventory_day
      WHERE "propertyId" = ${propertyId}::uuid
        AND "roomTypeId" = ${roomTypeId}::uuid
        AND "stayDate" IN (${Prisma.join(nights.map(utcMidnight))})
      ORDER BY "stayDate" ASC, "roomTypeId" ASC
      FOR UPDATE
    `;
    return rows.map((row) => ({
      stayDate: dateOnly(row.stay_date),
      physical: row.physical,
      sold: row.sold,
      blocked: row.blocked,
    }));
  }

  /**
   * Live stays on one physical room overlapping a half-open range.
   *
   * Every status except CANCELLED and NO_SHOW counts -- the same set the
   * `reservation_room_no_overlap` exclusion constraint guards -- so a checked
   * out stay on these nights is also a refusal: those nights were sold.
   */
  async findOverlappingStays(
    tx: Tx,
    propertyId: string,
    roomId: string,
    fromDate: string,
    throughExclusive: string,
  ): Promise<{ confirmationCode: string; arrivalDate: string; departureDate: string }[]> {
    const rows = await tx.reservationRoom.findMany({
      where: {
        propertyId,
        roomId,
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
        arrivalDate: { lt: utcMidnight(throughExclusive) },
        departureDate: { gt: utcMidnight(fromDate) },
      },
      select: {
        arrivalDate: true,
        departureDate: true,
        reservation: { select: { confirmationCode: true } },
      },
      orderBy: { arrivalDate: 'asc' },
      take: 5,
    });
    return rows.map((row) => ({
      confirmationCode: row.reservation.confirmationCode,
      arrivalDate: dateOnly(row.arrivalDate),
      departureDate: dateOnly(row.departureDate),
    }));
  }

  /** Active blocks already holding this physical room on overlapping nights. */
  async findOverlappingRoomBlocks(
    tx: Tx,
    propertyId: string,
    roomId: string,
    fromDate: string,
    throughExclusive: string,
  ): Promise<number> {
    return tx.roomBlock.count({
      where: {
        propertyId,
        roomId,
        status: 'ACTIVE',
        fromDate: { lt: utcMidnight(throughExclusive) },
        throughDate: { gt: utcMidnight(fromDate) },
      },
    });
  }

  /**
   * Move the counter by `delta` on exactly the locked nights.
   *
   * Returns the number of rows updated so the caller can assert it touched
   * every night it locked -- a short count means the counters and the request
   * disagree, and the transaction must not commit.
   */
  async adjustBlocked(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    nights: readonly string[],
    delta: number,
  ): Promise<number> {
    const result = await tx.inventoryDay.updateMany({
      where: {
        propertyId,
        roomTypeId,
        stayDate: { in: nights.map(utcMidnight) },
      },
      data: { blocked: { increment: delta } },
    });
    return result.count;
  }

  async insertBlock(
    tx: Tx,
    data: {
      propertyId: string;
      roomTypeId: string;
      roomId: string | null;
      rooms: number;
      fromDate: string;
      throughExclusive: string;
      reason: RoomBlockReason;
      note: string | null;
      createdByUserId: string;
    },
  ): Promise<RoomBlockRow> {
    const row = await tx.roomBlock.create({
      data: {
        propertyId: data.propertyId,
        roomTypeId: data.roomTypeId,
        roomId: data.roomId,
        rooms: data.rooms,
        fromDate: utcMidnight(data.fromDate),
        throughDate: utcMidnight(data.throughExclusive),
        reason: data.reason,
        note: data.note,
        createdByUserId: data.createdByUserId,
      },
      select: ROW_SELECT,
    });
    return toRow(row);
  }

  /**
   * Ends an active block at `throughExclusive` (earlier than its current end,
   * later than its start). Only under the block's row lock.
   */
  async shortenBlock(
    tx: Tx,
    propertyId: string,
    blockId: string,
    throughExclusive: string,
  ): Promise<RoomBlockRow> {
    const result = await tx.roomBlock.updateMany({
      where: { id: blockId, propertyId, status: 'ACTIVE' },
      data: { throughDate: utcMidnight(throughExclusive) },
    });
    if (result.count !== 1) {
      throw new Error('Room block changed under its own row lock.');
    }
    return this.readLockedBlock(tx, propertyId, blockId);
  }

  async markReleased(
    tx: Tx,
    propertyId: string,
    blockId: string,
    releasedByUserId: string,
    releasedAt: Date,
  ): Promise<RoomBlockRow> {
    const result = await tx.roomBlock.updateMany({
      where: { id: blockId, propertyId, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedByUserId, releasedAt },
    });
    if (result.count !== 1) {
      // Impossible while the row lock is held; asserted rather than assumed.
      throw new Error('Room block changed under its own row lock.');
    }
    return this.readLockedBlock(tx, propertyId, blockId);
  }

  async audit(
    tx: Tx,
    entry: {
      propertyId: string;
      actorUserId: string;
      event: string;
      blockId: string;
      before: Prisma.InputJsonObject | null;
      after: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId: entry.propertyId,
        actorUserId: entry.actorUserId,
        event: entry.event,
        entityType: 'room_block',
        entityId: entry.blockId,
        before: entry.before ?? Prisma.DbNull,
        after: entry.after,
      },
    });
  }
}
