/**
 * Per-night `inventory_day` reads, and the overbooking-allowance write.
 *
 * An `inventory_day` writer, so it follows CLAUDE.md section 3.1.1: a
 * transaction-local `lock_timeout` from `ROW_LOCK_TIMEOUT_MS` before the first
 * blocking statement, and rows locked
 * `ORDER BY "stayDate" ASC, "roomTypeId" ASC FOR UPDATE`. It has no existing
 * reservation or block row to contend for, so inventory is its first lock.
 *
 * `propertyId` is in every predicate; it is the only tenancy control (MT-02..04).
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

const TRANSACTION_TIMEOUT_MS = 10_000;
const TRANSACTION_MAX_WAIT_MS = 5_000;

export interface InventoryNight {
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
export class InventoryDayRepository {
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

  async roomTypeExists(propertyId: string, roomTypeId: string): Promise<boolean> {
    return (await this.prisma.client.roomType.count({ where: { id: roomTypeId, propertyId } })) > 0;
  }

  /** Unlocked, advisory read for display. Both ends inclusive. */
  async readNights(
    propertyId: string,
    roomTypeId: string,
    fromDate: string,
    toDate: string,
  ): Promise<InventoryNight[]> {
    const rows = await this.prisma.client.inventoryDay.findMany({
      where: {
        propertyId,
        roomTypeId,
        stayDate: { gte: utcMidnight(fromDate), lte: utcMidnight(toDate) },
      },
      orderBy: { stayDate: 'asc' },
      select: {
        stayDate: true,
        physical: true,
        sold: true,
        blocked: true,
        overbookingAllowance: true,
      },
    });
    return rows.map((row) => ({ ...row, stayDate: dateOnly(row.stayDate) }));
  }

  async lockNights(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    nights: readonly string[],
  ): Promise<InventoryNight[]> {
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
        AND "stayDate" IN (${Prisma.join(nights.map(utcMidnight))})
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

  async setAllowance(
    tx: Tx,
    propertyId: string,
    roomTypeId: string,
    nights: readonly string[],
    allowance: number,
  ): Promise<number> {
    const result = await tx.inventoryDay.updateMany({
      where: { propertyId, roomTypeId, stayDate: { in: nights.map(utcMidnight) } },
      data: { overbookingAllowance: allowance },
    });
    return result.count;
  }

  async audit(
    tx: Tx,
    entry: {
      propertyId: string;
      actorUserId: string;
      roomTypeId: string;
      before: Prisma.InputJsonObject;
      after: Prisma.InputJsonObject;
      reason: string;
    },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId: entry.propertyId,
        actorUserId: entry.actorUserId,
        event: 'INVENTORY_OVERBOOKING_SET',
        entityType: 'inventory_day',
        entityId: entry.roomTypeId,
        before: entry.before,
        after: entry.after,
        reason: entry.reason,
      },
    });
  }
}
