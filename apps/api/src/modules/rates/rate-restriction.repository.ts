/**
 * Persistence for stay restrictions (AV-07). No business rules.
 *
 * Touches only `rate_restriction_day`: no reservation, inventory or folio row,
 * so nothing here enters the lock protocol of CLAUDE.md section 3.1.1.
 * `propertyId` is in every predicate (MT-02..04 are not implemented).
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface RestrictionRow {
  stayDate: string;
  minLos: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
}

function utcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

@Injectable()
export class RateRestrictionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Restricted nights in an inclusive window, ascending. */
  async findRange(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    fromDate: string,
    toDate: string,
  ): Promise<RestrictionRow[]> {
    const rows = await this.prisma.client.rateRestrictionDay.findMany({
      where: {
        propertyId,
        ratePlanId,
        roomTypeId,
        stayDate: { gte: utcMidnight(fromDate), lte: utcMidnight(toDate) },
      },
      orderBy: { stayDate: 'asc' },
      select: { stayDate: true, minLos: true, closedToArrival: true, closedToDeparture: true },
    });
    return rows.map((row) => ({ ...row, stayDate: row.stayDate.toISOString().slice(0, 10) }));
  }

  /** Exactly the listed dates, for the booking check. */
  async findDates(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    dates: readonly string[],
  ): Promise<Map<string, RestrictionRow>> {
    const rows = await this.prisma.client.rateRestrictionDay.findMany({
      where: { propertyId, ratePlanId, roomTypeId, stayDate: { in: dates.map(utcMidnight) } },
      select: { stayDate: true, minLos: true, closedToArrival: true, closedToDeparture: true },
    });
    return new Map(
      rows.map((row) => {
        const stayDate = row.stayDate.toISOString().slice(0, 10);
        return [stayDate, { ...row, stayDate }];
      }),
    );
  }

  /**
   * Set every listed night to the same restriction, or clear them.
   *
   * One statement either way, so the range is all-or-nothing.
   */
  async setDates(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    dates: readonly string[],
    value: { minLos: number | null; closedToArrival: boolean; closedToDeparture: boolean },
    userId: string,
  ): Promise<number> {
    const restricts = value.minLos !== null || value.closedToArrival || value.closedToDeparture;
    if (!restricts) {
      const removed = await this.prisma.client.rateRestrictionDay.deleteMany({
        where: { propertyId, ratePlanId, roomTypeId, stayDate: { in: dates.map(utcMidnight) } },
      });
      return removed.count;
    }

    return this.prisma.client.$executeRaw`
      INSERT INTO "rate_restriction_day"
        ("id", "propertyId", "ratePlanId", "roomTypeId", "stayDate",
         "minLos", "closedToArrival", "closedToDeparture", "updatedByUserId", "updatedAt")
      SELECT gen_random_uuid(), ${propertyId}::uuid, ${ratePlanId}::uuid, ${roomTypeId}::uuid,
             d::date, ${value.minLos}::int, ${value.closedToArrival}, ${value.closedToDeparture},
             ${userId}::uuid, now()
        -- One bound array parameter, cast to date[]: no SQL text is built from input.
        FROM unnest(${[...dates]}::date[]) AS d
      ON CONFLICT ("propertyId", "ratePlanId", "roomTypeId", "stayDate") DO UPDATE
        SET "minLos" = EXCLUDED."minLos",
            "closedToArrival" = EXCLUDED."closedToArrival",
            "closedToDeparture" = EXCLUDED."closedToDeparture",
            "updatedByUserId" = EXCLUDED."updatedByUserId",
            "updatedAt" = now()
    `;
  }
}
