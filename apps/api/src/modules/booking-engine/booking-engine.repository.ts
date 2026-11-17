/**
 * Reads for the public booking engine. No business rules (section 5).
 *
 * Every statement names `propertyId` itself (RLS is the backstop; PF-03: its
 * predicate never serves an index). Nothing here writes: the booking is
 * written by `CreateReservationService`, inside its own transaction.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';

/** Plan kinds sold to the public. CORPORATE and COMPLIMENTARY never are. */
export const PUBLIC_PLAN_KINDS = ['STANDARD', 'PACKAGE', 'PROMOTIONAL'] as const;

export type PublicPlan = {
  id: string;
  name: string;
  description: string | null;
  roomTypeIds: string[];
};

@Injectable()
export class BookingEngineRepository {
  constructor(private readonly prisma: PrismaService) {}

  roomTypes(propertyId: string) {
    return this.prisma.client.roomType.findMany({
      where: { propertyId, retiredAt: null },
      select: { id: true, name: true, description: true, maxGuests: true, maxAdults: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Per category: how many of the nights have an inventory row, and the rooms
   * left on the scarcest night. Physical stock only: the overbooking allowance
   * is not sold to the public (the booking transaction applies the same rule).
   */
  async sellable(
    propertyId: string,
    arrivalDate: string,
    departureDate: string,
  ): Promise<Map<string, { nights: number; left: number }>> {
    const rows = await this.prisma.client.$queryRaw<
      { roomTypeId: string; nights: number; left: number }[]
    >`
      SELECT "roomTypeId"::text AS "roomTypeId", count(*)::int AS nights,
             min("physical" - "sold" - "blocked")::int AS "left"
        FROM "inventory_day"
       WHERE "propertyId" = ${propertyId}::uuid
         AND "stayDate" >= ${arrivalDate}::date AND "stayDate" < ${departureDate}::date
       GROUP BY "roomTypeId"`;
    return new Map(rows.map((r) => [r.roomTypeId, { nights: r.nights, left: r.left }]));
  }

  async publicPlans(propertyId: string): Promise<PublicPlan[]> {
    const plans = await this.prisma.client.ratePlan.findMany({
      where: {
        propertyId,
        isActive: true,
        archivedAt: null,
        kind: { in: [...PUBLIC_PLAN_KINDS] },
      },
      select: {
        id: true,
        name: true,
        description: true,
        roomTypes: { where: { propertyId }, select: { roomTypeId: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      roomTypeIds: p.roomTypes.map((r) => r.roomTypeId),
    }));
  }

  /** Categories priced by ANY plan, public or not: those are never sold at rack. */
  async pricedRoomTypes(propertyId: string): Promise<Set<string>> {
    const rows = await this.prisma.client.ratePlanRoomType.findMany({
      where: { propertyId },
      select: { roomTypeId: true },
      distinct: ['roomTypeId'],
    });
    return new Set(rows.map((r) => r.roomTypeId));
  }

  /** The earlier booking of this quote, if any; read under the per-quote lock. */
  existingForQuote(tx: Prisma.TransactionClient, propertyId: string, quoteId: string) {
    return tx.onlineBooking.findFirst({
      where: { propertyId, quoteId },
      select: { reservationId: true },
    });
  }

  async lockQuote(
    tx: Prisma.TransactionClient,
    propertyId: string,
    quoteId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`online-quote:${propertyId}:${quoteId}`}))`;
  }

  async recordOnline(
    tx: Prisma.TransactionClient,
    row: { propertyId: string; reservationId: string; quoteId: string; paymentChoice: string },
    audit: Prisma.InputJsonObject,
    openFolioCurrency: string | null,
  ): Promise<void> {
    await tx.onlineBooking.create({ data: row, select: { id: true } });
    await tx.auditLog.create({
      data: {
        propertyId: row.propertyId,
        // A guest, not a staff member: no actor (as for system actors).
        actorUserId: null,
        event: 'RESERVATION_BOOKED_ONLINE',
        entityType: 'reservation',
        entityId: row.reservationId,
        before: Prisma.DbNull,
        after: audit,
      },
    });
    // A guest paying now pays into a folio; staff open theirs at check-in.
    if (openFolioCurrency !== null) {
      await tx.folio.create({
        data: {
          propertyId: row.propertyId,
          reservationId: row.reservationId,
          currency: openFolioCurrency,
          status: 'OPEN',
        },
        select: { id: true },
      });
    }
  }

  /** What a guest may see of their own booking. */
  booking(propertyId: string, bookingCode: string) {
    return this.prisma.client.reservation.findFirst({
      where: { propertyId, confirmationCode: bookingCode, source: 'DIRECT_WEB' },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        guestFirstName: true,
        guestLastName: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        currency: true,
        totalAmountMinor: true,
        rooms: { select: { roomType: { select: { name: true } } }, take: 1 },
        onlineBooking: { where: { propertyId }, select: { paymentChoice: true }, take: 1 },
        folio: {
          select: {
            lines: { where: { propertyId }, select: { amountMinor: true, kind: true } },
            paymentLinks: {
              where: { propertyId },
              select: { status: true, shortUrl: true, amountMinor: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });
  }

  bookingById(propertyId: string, reservationId: string) {
    return this.prisma.client.reservation.findFirst({
      where: { propertyId, id: reservationId },
      select: { confirmationCode: true },
    });
  }
}
