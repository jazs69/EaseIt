/**
 * Persistence for the date-wise rate calendar. No business rules here (§5).
 *
 * ===========================================================================
 * Every statement carries `propertyId` explicitly. There is no Prisma tenancy
 * extension and no row-level security in this repository -- section 3.2
 * describes both and neither is implemented -- so the predicate IS the tenancy
 * control, not a convenience on top of one.
 *
 * WHY THE WRITES ARE RAW SQL. A bulk date write is an upsert over up to 180
 * rows and must be ONE statement: `ON CONFLICT ... DO UPDATE` against
 * `rate_plan_day_unique_per_date`. Prisma has no bulk upsert, so the
 * alternative is 180 round trips inside one transaction -- a transaction held
 * open for the duration, which section 3.1 explicitly tells us not to do.
 * CLAUDE.md section 2 permits `$queryRaw`/`$executeRaw` with parameterised
 * tagged templates for exactly the cases Prisma cannot express.
 *
 * Every value in those templates is interpolated by Prisma as a bound
 * parameter, never concatenated. The one place a list has to become SQL text
 * is the VALUES tuple list, and it is built from `Prisma.join`/`Prisma.sql`
 * fragments whose leaves are still parameters -- not from string formatting.
 *
 * NOTHING HERE TOUCHES `inventory_day`, `reservation` or `folio_line`. So no
 * path in this file enters the lock protocol of section 3.1.1, and no existing
 * inventory writer gains a reason to contend with it.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';

/** The assignment a calendar read or write is about, as stored. */
export interface AssignmentRow {
  ratePlanId: string;
  ratePlanCode: string;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  currency: string;
  defaultRateMinor: number;
  baseOccupancy: number;
  isActive: boolean;
  archivedAt: Date | null;
}

export interface WriteOutcome {
  created: number;
  updated: number;
}

@Injectable()
export class RateCalendarRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The assignment, or null.
   *
   * One query answers three questions the service would otherwise ask
   * separately: does this plan belong to this property, is this room type
   * assigned to it, and is the plan editable. Doing it in one read is not
   * merely fewer round trips -- it means the three facts cannot disagree
   * because they were read at different moments.
   *
   * Scoped by `propertyId` in the same predicate as both ids, so another
   * property's plan is *not found* rather than forbidden (3.2).
   */
  async findAssignment(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
  ): Promise<AssignmentRow | null> {
    const row = await this.prisma.client.ratePlanRoomType.findFirst({
      where: { propertyId, ratePlanId, roomTypeId },
      select: {
        ratePlanId: true,
        roomTypeId: true,
        defaultRateMinor: true,
        baseOccupancy: true,
        ratePlan: { select: { code: true, currency: true, isActive: true, archivedAt: true } },
        roomType: { select: { code: true, name: true } },
      },
    });

    if (row === null) return null;

    return {
      ratePlanId: row.ratePlanId,
      ratePlanCode: row.ratePlan.code,
      roomTypeId: row.roomTypeId,
      roomTypeCode: row.roomType.code,
      roomTypeName: row.roomType.name,
      currency: row.ratePlan.currency,
      defaultRateMinor: row.defaultRateMinor,
      baseOccupancy: row.baseOccupancy,
      isActive: row.ratePlan.isActive,
      archivedAt: row.ratePlan.archivedAt,
    };
  }

  /**
   * The overrides inside a window, keyed by `YYYY-MM-DD`.
   *
   * Only the rows that exist come back -- the service fills the window, because
   * absence is the fact that means "use the default" and the window's shape is
   * the caller's request, not the table's contents.
   *
   * `stayDate` is cast to text in SQL rather than read as a `Date` and
   * formatted in JS. A `@db.Date` column arrives as a JS `Date` at UTC
   * midnight, and formatting that through anything local-timezone-aware shifts
   * it a day. `::text` on a DATE is exactly `YYYY-MM-DD` and cannot drift
   * (section 3.3).
   */
  async findOverrides(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    fromDate: string,
    toDate: string,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.client.$queryRaw<{ stay_date: string; amount: number }[]>`
      SELECT "stayDate"::text AS stay_date, "amountMinor" AS amount
        FROM "rate_plan_day"
       WHERE "propertyId" = ${propertyId}::uuid
         AND "ratePlanId" = ${ratePlanId}::uuid
         AND "roomTypeId" = ${roomTypeId}::uuid
         AND "stayDate" >= ${fromDate}::date
         AND "stayDate" <= ${toDate}::date
       ORDER BY "stayDate" ASC
    `;

    return new Map(rows.map((row) => [row.stay_date, Number(row.amount)]));
  }

  /**
   * Upsert the given dates in one statement, returning what changed.
   *
   * `xmax = 0` is the standard Postgres idiom for "this row was inserted by
   * this statement rather than updated": on an insert the row has no previous
   * version, so its `xmax` is zero. It is the only way to tell created from
   * updated in a single `ON CONFLICT` statement, and the distinction is what
   * lets the response tell an operator whether they changed nights they did
   * not expect to.
   *
   * `DO UPDATE` sets `updatedAt` and `updatedByUserId` explicitly, because
   * Prisma's `@updatedAt` is applied by the client and a raw statement
   * bypasses it -- without this, an overwritten night would keep the timestamp
   * and the author of whoever priced it first.
   *
   * The whole statement is one transaction by virtue of being one statement,
   * which is what "write all requested dates atomically" requires: Postgres
   * either applies every tuple or none.
   */
  async upsertDays(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    entries: readonly { stayDate: string; amountMinor: number }[],
    userId: string,
  ): Promise<WriteOutcome> {
    // Each leaf is still a bound parameter; only the comma structure is SQL.
    const values = Prisma.join(
      entries.map(
        (entry) => Prisma.sql`(
          gen_random_uuid(),
          ${propertyId}::uuid,
          ${ratePlanId}::uuid,
          ${roomTypeId}::uuid,
          ${entry.stayDate}::date,
          ${entry.amountMinor}::integer,
          ${userId}::uuid,
          NOW(),
          NOW()
        )`,
      ),
    );

    const rows = await this.prisma.client.$queryRaw<{ inserted: boolean }[]>`
      INSERT INTO "rate_plan_day" (
        "id", "propertyId", "ratePlanId", "roomTypeId",
        "stayDate", "amountMinor", "updatedByUserId", "createdAt", "updatedAt"
      )
      VALUES ${values}
      ON CONFLICT ("propertyId", "ratePlanId", "roomTypeId", "stayDate")
      DO UPDATE SET
        "amountMinor"     = EXCLUDED."amountMinor",
        "updatedByUserId" = EXCLUDED."updatedByUserId",
        "updatedAt"       = NOW()
      RETURNING (xmax = 0) AS inserted
    `;

    const created = rows.filter((row) => row.inserted).length;
    return { created, updated: rows.length - created };
  }

  /**
   * Delete the overrides for the given dates, returning how many went.
   *
   * A DELETE, not a write of the default. Absence is what "no override" means,
   * so storing the default value instead would pin those nights to today's
   * default and make a later change to it silently fail to reach them.
   *
   * Clearing a date that has no override is not an error here or in the
   * service: the requested end state is reached either way. The count tells
   * the caller how many actually existed.
   */
  async clearDays(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    stayDates: readonly string[],
  ): Promise<number> {
    const result = await this.prisma.client.$executeRaw`
      DELETE FROM "rate_plan_day"
       WHERE "propertyId" = ${propertyId}::uuid
         AND "ratePlanId" = ${ratePlanId}::uuid
         AND "roomTypeId" = ${roomTypeId}::uuid
         AND "stayDate" = ANY(${stayDates as string[]}::date[])
    `;

    return result;
  }
}
