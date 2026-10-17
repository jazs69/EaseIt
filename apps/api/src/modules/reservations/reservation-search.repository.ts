/**
 * Persistence for omnibar reservation search.
 *
 * ===========================================================================
 * One query, seven match paths, every one of them tenant-scoped.
 *
 * `propertyId` is the first condition in the `where`, outside the `OR`, so it
 * cannot be short-circuited by any branch inside it. That matters more here
 * than on most queries: an `OR` of seven `contains` clauses is exactly the
 * shape where a misplaced tenant filter leaks another hotel's guest list, and
 * every index on this table leads with propertyId so the planner narrows by it
 * first (CLAUDE.md section 3.2).
 *
 * Room number is matched through the relation rather than a denormalised
 * column: `rooms.some.room.number`. A cached `assignedRoomNumber` on the
 * reservation would be a second copy of the truth, and a room move — which the
 * front desk does daily — would desynchronise it silently (section 3.4).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { OPERABLE_PROPERTY_STATUSES } from '@repo/types';
import type { BookingSource, MealPlan, ReservationStatus } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

export interface SearchPropertyRow {
  id: string;
  code: string;
  name: string;
  currency: string;
}

export interface ReservationSearchRow {
  id: string;
  confirmationCode: string;
  otaBookingId: string | null;
  guestFirstName: string;
  guestLastName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  govtIdNumber: string | null;
  status: ReservationStatus;
  source: BookingSource;
  mealPlan: MealPlan;
  arrivalDate: Date;
  departureDate: Date;
  totalAmountMinor: number;
  paidAmountMinor: number;
  currency: string;
  rooms: {
    room: { number: string } | null;
    roomType: { name: string };
  }[];
}

@Injectable()
export class ReservationSearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a property code or uuid through the caller's own grants.
   *
   * A property the caller holds no role at returns null, which the service
   * turns into not-found — never a 403, because confirming existence is itself
   * a leak (CLAUDE.md section 3.2).
   */
  async findGrantedProperty(
    userId: string,
    codeOrId: string,
  ): Promise<SearchPropertyRow | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grant = await this.prisma.client.userPropertyRole.findFirst({
      where: {
        userId,
        property: {
          status: { in: [...OPERABLE_PROPERTY_STATUSES] },
          ...(isUuid ? { id: codeOrId } : { code: codeOrId }),
        },
      },
      select: {
        property: { select: { id: true, code: true, name: true, currency: true } },
      },
    });

    return grant?.property ?? null;
  }

  /**
   * Matching reservations, newest booking first.
   *
   * `take` is `limit + 1` so the service can tell "exactly ten results" from
   * "more than ten" without a second counting query, and say "refine your
   * search" only when it is true.
   */
  async search(
    propertyId: string,
    query: string,
    limit: number,
  ): Promise<ReservationSearchRow[]> {
    // A full name spans two columns, so the query is tokenised: every token
    // must match one of the two. That makes "Vikram", "Malhotra",
    // "Vikram Malhotra" and "Malhotra Vikram" all find the same guest, which a
    // single `contains` over either column cannot do.
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    const nameConditions = tokens.map((token) => ({
      OR: [
        { guestFirstName: { contains: token, mode: 'insensitive' as const } },
        { guestLastName: { contains: token, mode: 'insensitive' as const } },
      ],
    }));

    return this.prisma.client.reservation.findMany({
      where: {
        // Outside the OR, and first. Never inside a branch.
        propertyId,
        OR: [
          { confirmationCode: { contains: query, mode: 'insensitive' } },
          { otaBookingId: { contains: query, mode: 'insensitive' } },
          { guestPhone: { contains: query } },
          { guestEmail: { contains: query, mode: 'insensitive' } },
          { govtIdNumber: { contains: query, mode: 'insensitive' } },
          // Room is an exact match, not a prefix: "11" should not return every
          // room on floors 11 and 1 plus rooms 110-119. A clerk reading a room
          // number off a key card has all of it.
          {
            rooms: {
              some: {
                propertyId,
                // The Prisma column is `number`; the DTO publishes it as
                // `roomNumber`, which is what the rest of the app calls it.
                room: { number: { equals: query, mode: 'insensitive' } },
              },
            },
          },
          ...(nameConditions.length > 0 ? [{ AND: nameConditions }] : []),
        ],
      },
      take: limit + 1,
      // Most recently booked first. A guest at the desk is far more likely to
      // be asking about a booking made this week than one from last year.
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        confirmationCode: true,
        otaBookingId: true,
        guestFirstName: true,
        guestLastName: true,
        guestPhone: true,
        guestEmail: true,
        govtIdNumber: true,
        status: true,
        source: true,
        mealPlan: true,
        arrivalDate: true,
        departureDate: true,
        totalAmountMinor: true,
        paidAmountMinor: true,
        currency: true,
        rooms: {
          select: {
            room: { select: { number: true } },
            roomType: { select: { name: true } },
          },
          take: 1,
        },
      },
    });
  }
}
