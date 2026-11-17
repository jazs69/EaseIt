/**
 * Persistence for reusable guest profiles (GP-02).
 *
 * Every query names `propertyId` itself, on top of the tenancy extension and
 * row-level security (CLAUDE.md section 3.2). The service owns every rule.
 */

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';

const PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  countryCode: true,
  emailNormalized: true,
  phoneNormalized: true,
  preferences: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ProfileRow = Prisma.GuestProfileGetPayload<{ select: typeof PROFILE_SELECT }>;

const SUMMARY_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  stays: { select: { reservation: { select: { arrivalDate: true } } } },
} as const;

export type SummaryRow = Prisma.GuestProfileGetPayload<{ select: typeof SUMMARY_SELECT }>;

const STAY_SELECT = {
  id: true,
  ordinal: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  reservation: {
    select: {
      id: true,
      confirmationCode: true,
      arrivalDate: true,
      departureDate: true,
      status: true,
      totalAmountMinor: true,
      currency: true,
    },
  },
} as const;

export type StayRow = Prisma.ReservationGuestGetPayload<{ select: typeof STAY_SELECT }>;

export interface GrantRow {
  role: { key: string | null };
  property: { id: string };
}

@Injectable()
export class GuestsRepository {
  constructor(private readonly prisma: PrismaService) {}

  grantsAt(where: Prisma.UserPropertyRoleWhereInput): Promise<GrantRow[]> {
    return this.prisma.client.userPropertyRole.findMany({
      where,
      select: { role: { select: { key: true } }, property: { select: { id: true } } },
    });
  }

  search(
    propertyId: string,
    where: Prisma.GuestProfileWhereInput,
    take: number,
    cursor: string | undefined,
  ): Promise<SummaryRow[]> {
    return this.prisma.client.guestProfile.findMany({
      where: { ...where, propertyId },
      select: SUMMARY_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      take,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
  }

  async profileExists(propertyId: string, id: string): Promise<boolean> {
    const found = await this.prisma.client.guestProfile.findFirst({
      where: { id, propertyId },
      select: { id: true },
    });
    return found !== null;
  }

  profile(propertyId: string, id: string): Promise<ProfileRow | null> {
    return this.prisma.client.guestProfile.findFirst({
      where: { id, propertyId },
      select: PROFILE_SELECT,
    });
  }

  linkedStays(propertyId: string, profileId: string): Promise<StayRow[]> {
    return this.prisma.client.reservationGuest.findMany({
      where: { propertyId, guestProfileId: profileId },
      select: STAY_SELECT,
      orderBy: [{ reservation: { arrivalDate: 'desc' } }, { id: 'asc' }],
    });
  }

  /**
   * Unlinked guest rows whose email or phone matches, by the same keys the
   * profile stores (`normaliseEmail`, `normalisePhone`), computed in SQL.
   */
  async matchingUnlinkedGuestIds(
    propertyId: string,
    email: string | null,
    phone: string | null,
  ): Promise<string[]> {
    if (email === null && phone === null) return [];
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT g."id"::text AS id
        FROM "reservation_guest" g
       WHERE g."propertyId" = ${propertyId}::uuid
         AND g."guestProfileId" IS NULL
         AND (
              (${email}::text IS NOT NULL AND lower(btrim(g."email")) = ${email}::text)
           OR (${phone}::text IS NOT NULL
               AND length(regexp_replace(coalesce(g."phone", ''), '\\D', '', 'g')) >= 7
               AND right(regexp_replace(g."phone", '\\D', '', 'g'), 10) = ${phone}::text)
         )
       LIMIT 50`;
    return rows.map((row) => row.id);
  }

  staysByIds(propertyId: string, ids: readonly string[]): Promise<StayRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.client.reservationGuest.findMany({
      where: { propertyId, id: { in: [...ids] } },
      select: STAY_SELECT,
      orderBy: [{ reservation: { arrivalDate: 'desc' } }, { id: 'asc' }],
    });
  }

  duplicates(propertyId: string, id: string, email: string | null, phone: string | null) {
    const or: Prisma.GuestProfileWhereInput[] = [];
    if (email !== null) or.push({ emailNormalized: email });
    if (phone !== null) or.push({ phoneNormalized: phone });
    if (or.length === 0) return Promise.resolve([]);
    return this.prisma.client.guestProfile.findMany({
      where: { propertyId, id: { not: id }, OR: or },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailNormalized: true,
        phoneNormalized: true,
      },
      take: 20,
    });
  }

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(work);
  }
}
