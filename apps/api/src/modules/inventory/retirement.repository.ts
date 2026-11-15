/**
 * Persistence for retiring rooms and room types.
 *
 * ===========================================================================
 * Retiring a ROOM is an `inventory_day` writer: the room stops being stock, so
 * `physical` drops by one on every night from today onward. It therefore
 * follows CLAUDE.md section 3.1.1 -- the `room` row is locked first (scoped by
 * `propertyId` in the same predicate as the id), then `inventory_day` in
 * `ORDER BY "stayDate" ASC, "roomTypeId" ASC`, under a transaction-local
 * `lock_timeout`.
 *
 * No other writer locks a `room` row, so taking it first cannot form a cycle
 * with the reservation paths, which lock `reservation` then `inventory_day`.
 *
 * Retiring a ROOM TYPE writes no counter: it is refused while any room of the
 * type is still active, so by then retiring its rooms has already zeroed
 * `physical` on future nights.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

const TRANSACTION_TIMEOUT_MS = 10_000;
const TRANSACTION_MAX_WAIT_MS = 5_000;

/** Statuses that no longer hold a room: the same set the exclusion constraint ignores, plus departed. */
const FINISHED_STAY_STATUSES = ['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'] as const;

export interface FutureNight {
  stayDate: string;
  physical: number;
  sold: number;
  blocked: number;
  overbookingAllowance: number;
}

function utcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class RetirementRepository {
  constructor(private readonly prisma: PrismaService) {}

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
  /*  Rooms                                                                 */
  /* ---------------------------------------------------------------------- */

  async lockRoom(
    tx: Tx,
    propertyId: string,
    roomId: string,
  ): Promise<{ id: string; roomTypeId: string; number: string; retiredAt: Date | null } | null> {
    const rows = await tx.$queryRaw<
      { id: string; roomTypeId: string; number: string; retiredAt: Date | null }[]
    >`
      SELECT "id", "roomTypeId", "number", "retiredAt"
      FROM room
      WHERE "id" = ${roomId}::uuid
        AND "propertyId" = ${propertyId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /** Stays on this room that have not finished and depart after `today`. */
  async liveStaysOnRoom(
    tx: Tx,
    propertyId: string,
    roomId: string,
    today: string,
  ): Promise<string[]> {
    const rows = await tx.reservationRoom.findMany({
      where: {
        propertyId,
        roomId,
        status: { notIn: [...FINISHED_STAY_STATUSES] },
        departureDate: { gt: utcMidnight(today) },
      },
      select: { reservation: { select: { confirmationCode: true } } },
      orderBy: { arrivalDate: 'asc' },
      take: 5,
    });
    return rows.map((row) => row.reservation.confirmationCode);
  }

  async activeBlocksOnRoom(
    tx: Tx,
    propertyId: string,
    roomId: string,
    today: string,
  ): Promise<number> {
    return tx.roomBlock.count({
      where: { propertyId, roomId, status: 'ACTIVE', throughDate: { gt: utcMidnight(today) } },
    });
  }

  /** Every configured night from `today` on, locked in the shared order. */
  async lockFutureNights(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    today: string,
  ): Promise<FutureNight[]> {
    const rows = await tx.$queryRaw<
      {
        stay_date: Date;
        physical: number;
        sold: number;
        blocked: number;
        overbooking_allowance: number;
      }[]
    >`
      SELECT "stayDate" AS stay_date, "physical", "sold", "blocked",
             "overbookingAllowance" AS overbooking_allowance
      FROM inventory_day
      WHERE "propertyId" = ${propertyId}::uuid
        AND "roomTypeId" = ${roomTypeId}::uuid
        AND "stayDate" >= ${utcMidnight(today)}
      ORDER BY "stayDate" ASC, "roomTypeId" ASC
      FOR UPDATE
    `;
    return rows.map((row) => ({
      stayDate: dateOnly(row.stay_date),
      physical: row.physical,
      sold: row.sold,
      blocked: row.blocked,
      overbookingAllowance: row.overbooking_allowance,
    }));
  }

  /**
   * One room fewer from `today` on, on nights that still count one.
   *
   * `physical > 0` matters because of limitation L1: a room added after a
   * night was generated was never counted on it, so there is nothing to take
   * back. Decrementing anyway could only understate capacity, but skipping
   * zero rows keeps `inventory_day_counters_non_negative` from ever firing.
   */
  async decrementPhysical(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    today: string,
  ): Promise<number> {
    const result = await tx.inventoryDay.updateMany({
      where: {
        propertyId,
        roomTypeId,
        stayDate: { gte: utcMidnight(today) },
        physical: { gt: 0 },
      },
      data: { physical: { decrement: 1 } },
    });
    return result.count;
  }

  async markRoomRetired(
    tx: Tx,
    propertyId: string,
    roomId: string,
    userId: string,
    at: Date,
  ): Promise<void> {
    const result = await tx.room.updateMany({
      where: { id: roomId, propertyId, retiredAt: null },
      data: { retiredAt: at, retiredByUserId: userId },
    });
    if (result.count !== 1) throw new Error('Room changed under its own row lock.');
  }

  /* ---------------------------------------------------------------------- */
  /*  Room types                                                            */
  /* ---------------------------------------------------------------------- */

  async lockRoomType(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
  ): Promise<{ id: string; code: string; retiredAt: Date | null } | null> {
    const rows = await tx.$queryRaw<{ id: string; code: string; retiredAt: Date | null }[]>`
      SELECT "id", "code", "retiredAt"
      FROM room_type
      WHERE "id" = ${roomTypeId}::uuid
        AND "propertyId" = ${propertyId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async activeRoomsOfType(tx: Tx, propertyId: string, roomTypeId: string): Promise<number> {
    return tx.room.count({ where: { propertyId, roomTypeId, retiredAt: null } });
  }

  /** Includes stays with no room assigned yet: they still hold the category. */
  async liveStaysOfType(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    today: string,
  ): Promise<string[]> {
    const rows = await tx.reservationRoom.findMany({
      where: {
        propertyId,
        roomTypeId,
        status: { notIn: [...FINISHED_STAY_STATUSES] },
        departureDate: { gt: utcMidnight(today) },
      },
      select: { reservation: { select: { confirmationCode: true } } },
      orderBy: { arrivalDate: 'asc' },
      take: 5,
    });
    return rows.map((row) => row.reservation.confirmationCode);
  }

  async activeBlocksOfType(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    today: string,
  ): Promise<number> {
    return tx.roomBlock.count({
      where: { propertyId, roomTypeId, status: 'ACTIVE', throughDate: { gt: utcMidnight(today) } },
    });
  }

  async markRoomTypeRetired(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    userId: string,
    at: Date,
  ): Promise<void> {
    const result = await tx.roomType.updateMany({
      where: { id: roomTypeId, propertyId, retiredAt: null },
      data: { retiredAt: at, retiredByUserId: userId },
    });
    if (result.count !== 1) throw new Error('Room type changed under its own row lock.');
  }

  async audit(
    tx: Tx,
    entry: {
      propertyId: string;
      actorUserId: string;
      event: string;
      entityType: 'room' | 'room_type';
      entityId: string;
      after: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId: entry.propertyId,
        actorUserId: entry.actorUserId,
        event: entry.event,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: { retiredAt: null },
        after: entry.after,
      },
    });
  }
}
