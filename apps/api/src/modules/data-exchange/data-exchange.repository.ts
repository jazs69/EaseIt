/**
 * Persistence for IE-01 import and IE-02 export. No business rules (section 5).
 *
 * Every statement names `propertyId` itself rather than leaving it to RLS:
 * RLS is the backstop, and (PF-03) its predicate never serves an index.
 * Import methods take the import's transaction; nothing here opens one except
 * `transaction`.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';

export type Tx = Prisma.TransactionClient;

export type RoomTypeState = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  maxGuests: number;
  maxAdults: number | null;
  baseRateMinor: number;
  currency: string;
  sortOrder: number;
  retired: boolean;
};

export type RoomState = {
  id: string;
  number: string;
  roomTypeId: string;
  floor: string | null;
  notes: string | null;
  status: string;
  retired: boolean;
};

export type RatePlanState = {
  id: string;
  code: string;
  currency: string;
  isActive: boolean;
  archived: boolean;
  derived: boolean;
};

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
} as const;

@Injectable()
export class DataExchangeRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    // A large rates file writes tens of thousands of nights; the default 5 s
    // is a booking-path budget, not an import's.
    return this.prisma.client.$transaction(work, { timeout: 60_000, maxWait: 10_000 });
  }

  /** Serialise imports per property, so a dry run and a commit see settled state. */
  async lockImports(tx: Tx, propertyId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`data-import:${propertyId}`}))`;
  }

  async property(tx: Tx, propertyId: string): Promise<{ currency: string; code: string }> {
    const row = await tx.property.findFirst({
      where: { id: propertyId },
      select: { currency: true, code: true },
    });
    // Resolved by the caller's grant a moment ago; absent only if deleted since.
    if (row === null) throw new Error('Property vanished during import.');
    return row;
  }

  async roomTypes(tx: Tx | null, propertyId: string): Promise<RoomTypeState[]> {
    const rows = await (tx ?? this.prisma.client).roomType.findMany({
      where: { propertyId },
      select: ROOM_TYPE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    return rows.map(({ retiredAt, ...rest }) => ({ ...rest, retired: retiredAt !== null }));
  }

  async rooms(tx: Tx | null, propertyId: string): Promise<RoomState[]> {
    const rows = await (tx ?? this.prisma.client).room.findMany({
      where: { propertyId },
      select: {
        id: true,
        number: true,
        roomTypeId: true,
        floor: true,
        notes: true,
        status: true,
        retiredAt: true,
      },
      orderBy: { number: 'asc' },
    });
    return rows.map(({ retiredAt, status, ...rest }) => ({
      ...rest,
      status: String(status),
      retired: retiredAt !== null,
    }));
  }

  async ratePlans(tx: Tx | null, propertyId: string): Promise<RatePlanState[]> {
    const rows = await (tx ?? this.prisma.client).ratePlan.findMany({
      where: { propertyId },
      select: {
        id: true,
        code: true,
        currency: true,
        isActive: true,
        archivedAt: true,
        parentRatePlanId: true,
      },
      orderBy: { code: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      currency: row.currency,
      isActive: row.isActive,
      archived: row.archivedAt !== null,
      derived: row.parentRatePlanId !== null,
    }));
  }

  /** `ratePlanId:roomTypeId` → default rate. */
  async assignments(tx: Tx | null, propertyId: string): Promise<Map<string, number>> {
    const rows = await (tx ?? this.prisma.client).ratePlanRoomType.findMany({
      where: { propertyId },
      select: { ratePlanId: true, roomTypeId: true, defaultRateMinor: true },
    });
    return new Map(rows.map((r) => [`${r.ratePlanId}:${r.roomTypeId}`, r.defaultRateMinor]));
  }

  /** Existing overrides for one assignment over a window: date → amount. */
  async overrides(
    tx: Tx,
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    fromDate: string,
    toDate: string,
  ): Promise<Map<string, number>> {
    const rows = await tx.$queryRaw<{ day: string; amount: number }[]>`
      SELECT to_char("stayDate", 'YYYY-MM-DD') AS day, "amountMinor" AS amount
        FROM "rate_plan_day"
       WHERE "propertyId" = ${propertyId}::uuid AND "ratePlanId" = ${ratePlanId}::uuid
         AND "roomTypeId" = ${roomTypeId}::uuid
         AND "stayDate" BETWEEN ${fromDate}::date AND ${toDate}::date`;
    return new Map(rows.map((r) => [r.day, r.amount]));
  }

  createRoomType(
    tx: Tx,
    propertyId: string,
    data: Omit<RoomTypeState, 'id' | 'retired'>,
  ): Promise<{ id: string }> {
    return tx.roomType.create({ data: { propertyId, ...data }, select: { id: true } });
  }

  async updateRoomType(
    tx: Tx,
    propertyId: string,
    id: string,
    data: Omit<RoomTypeState, 'id' | 'retired' | 'code' | 'currency'>,
  ): Promise<void> {
    await tx.roomType.updateMany({ where: { id, propertyId }, data });
  }

  createRoom(
    tx: Tx,
    propertyId: string,
    data: { number: string; roomTypeId: string; floor: string | null; notes: string | null },
  ): Promise<{ id: string }> {
    return tx.room.create({ data: { propertyId, ...data }, select: { id: true } });
  }

  async updateRoom(
    tx: Tx,
    propertyId: string,
    id: string,
    data: { floor: string | null; notes: string | null },
  ): Promise<void> {
    await tx.room.updateMany({ where: { id, propertyId }, data });
  }

  async upsertAssignment(
    tx: Tx,
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    defaultRateMinor: number,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "rate_plan_room_type" ("propertyId", "ratePlanId", "roomTypeId", "defaultRateMinor", "createdAt", "updatedAt")
      VALUES (${propertyId}::uuid, ${ratePlanId}::uuid, ${roomTypeId}::uuid, ${defaultRateMinor}::integer, NOW(), NOW())
      ON CONFLICT ("ratePlanId", "roomTypeId")
      DO UPDATE SET "defaultRateMinor" = EXCLUDED."defaultRateMinor", "updatedAt" = NOW()`;
  }

  /** Upsert nights from parallel arrays; one statement per call. */
  async upsertDays(
    tx: Tx,
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    days: readonly string[],
    amounts: readonly number[],
    userId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "rate_plan_day" ("id", "propertyId", "ratePlanId", "roomTypeId", "stayDate",
                                   "amountMinor", "updatedByUserId", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${propertyId}::uuid, ${ratePlanId}::uuid, ${roomTypeId}::uuid,
             t.day, t.amount, ${userId}::uuid, NOW(), NOW()
        FROM unnest(${days}::date[], ${amounts}::integer[]) AS t(day, amount)
      ON CONFLICT ("propertyId", "ratePlanId", "roomTypeId", "stayDate")
      DO UPDATE SET "amountMinor" = EXCLUDED."amountMinor",
                    "updatedByUserId" = EXCLUDED."updatedByUserId",
                    "updatedAt" = NOW()`;
  }

  async audit(tx: Tx, rows: Prisma.AuditLogCreateManyInput[]): Promise<void> {
    if (rows.length > 0) await tx.auditLog.createMany({ data: rows });
  }

  /* ------------------------------------------------------------ export -- */

  async auditExport(row: Prisma.AuditLogCreateManyInput): Promise<void> {
    await this.prisma.client.auditLog.create({ data: row });
  }

  rateDays(propertyId: string, fromDate: string, toDate: string) {
    return this.prisma.client.$queryRaw<
      { planCode: string; typeCode: string; day: string; amount: number; currency: string }[]
    >`
      SELECT p."code" AS "planCode", t."code" AS "typeCode", to_char(d."stayDate", 'YYYY-MM-DD') AS day,
             d."amountMinor" AS amount, p."currency" AS currency
        FROM "rate_plan_day" d
        JOIN "rate_plan" p ON p."id" = d."ratePlanId" AND p."propertyId" = ${propertyId}::uuid
        JOIN "room_type" t ON t."id" = d."roomTypeId" AND t."propertyId" = ${propertyId}::uuid
       WHERE d."propertyId" = ${propertyId}::uuid
         AND d."stayDate" BETWEEN ${fromDate}::date AND ${toDate}::date
       ORDER BY p."code", t."code", d."stayDate"`;
  }

  rateDefaults(propertyId: string) {
    return this.prisma.client.$queryRaw<
      { planCode: string; typeCode: string; amount: number; currency: string }[]
    >`
      SELECT p."code" AS "planCode", t."code" AS "typeCode", a."defaultRateMinor" AS amount,
             p."currency" AS currency
        FROM "rate_plan_room_type" a
        JOIN "rate_plan" p ON p."id" = a."ratePlanId" AND p."propertyId" = ${propertyId}::uuid
        JOIN "room_type" t ON t."id" = a."roomTypeId" AND t."propertyId" = ${propertyId}::uuid
       WHERE a."propertyId" = ${propertyId}::uuid AND p."parentRatePlanId" IS NULL
       ORDER BY p."code", t."code"`;
  }

  reservations(propertyId: string, fromDate: string, toDate: string) {
    return this.prisma.client.reservation.findMany({
      where: {
        propertyId,
        arrivalDate: {
          gte: new Date(`${fromDate}T00:00:00Z`),
          lte: new Date(`${toDate}T00:00:00Z`),
        },
      },
      select: {
        confirmationCode: true,
        status: true,
        source: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        guestFirstName: true,
        guestLastName: true,
        guestEmail: true,
        guestPhone: true,
        totalAmountMinor: true,
        taxAmountMinor: true,
        paidAmountMinor: true,
        currency: true,
        createdAt: true,
        cancelledAt: true,
        rooms: {
          select: { room: { select: { number: true } }, roomType: { select: { code: true } } },
        },
      },
      orderBy: [{ arrivalDate: 'asc' }, { confirmationCode: 'asc' }],
    });
  }

  folioLines(propertyId: string, fromDate: string, toDate: string) {
    return this.prisma.client.$queryRaw<
      {
        chargeDate: string;
        confirmationCode: string;
        folioNumber: string | null;
        kind: string;
        description: string;
        amountMinor: number;
        currency: string;
        paymentMethod: string | null;
        reversesLineId: string | null;
        id: string;
        createdAt: Date;
      }[]
    >`
      SELECT to_char(l."chargeDate", 'YYYY-MM-DD') AS "chargeDate", r."confirmationCode",
             f."customFolioId" AS "folioNumber", l."kind"::text AS kind, l."description",
             l."amountMinor", l."currency", l."paymentMethod"::text AS "paymentMethod",
             l."reversesLineId"::text AS "reversesLineId", l."id"::text AS id, l."createdAt"
        FROM "folio_line" l
        JOIN "folio" f ON f."id" = l."folioId" AND f."propertyId" = ${propertyId}::uuid
        JOIN "reservation" r ON r."id" = f."reservationId" AND r."propertyId" = ${propertyId}::uuid
       WHERE l."propertyId" = ${propertyId}::uuid
         AND l."chargeDate" BETWEEN ${fromDate}::date AND ${toDate}::date
       ORDER BY l."chargeDate", r."confirmationCode", l."createdAt"`;
  }

  guests(propertyId: string) {
    return this.prisma.client.guestProfile.findMany({
      where: { propertyId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        countryCode: true,
        createdAt: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }
}
