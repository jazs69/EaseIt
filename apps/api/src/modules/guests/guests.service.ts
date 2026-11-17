/**
 * Reusable guest profiles (GP-02).
 *
 * ===========================================================================
 * A profile is created and linked by a person, never by a matcher.
 *
 * - Search, create and edit a profile; its stay history is every
 *   `reservation_guest` row linked to it.
 * - Suggestions: unlinked guest rows, and other profiles, that share the
 *   profile's normalised email or phone. Offered, never applied. A family
 *   shares a phone, and an agent's email is on many bookings.
 * - A guest row links to at most one profile. Linking one that belongs to
 *   another profile is refused rather than silently moved.
 *
 * Reading needs `reservations:read` and writing needs `reservations:edit`:
 * the same people who see and edit the guests on a booking. No grant at the
 * property is not found (section 3.2).
 *
 * The audit row records which fields changed and which stays were linked,
 * never the values: guest PII stays out of `audit_log` (section 5).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  normaliseEmail,
  normalisePhone,
  Permission,
  type BusinessDate,
  type CreateGuestProfileCommand,
  type GuestProfileDetail,
  type GuestProfilePage,
  type GuestStay,
  type LinkGuestStayCommand,
  type ListGuestProfilesQuery,
  type UpdateGuestProfileCommand,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { GuestsRepository, type StayRow } from './guests.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

function toStay(row: StayRow): GuestStay {
  return {
    reservationGuestId: row.id,
    reservationId: row.reservation.id,
    bookingCode: row.reservation.confirmationCode,
    ordinal: row.ordinal,
    guestName: `${row.firstName} ${row.lastName}`.trim(),
    arrivalDate: iso(row.reservation.arrivalDate),
    departureDate: iso(row.reservation.departureDate),
    status: row.reservation.status,
    totalAmountMinor: row.reservation.totalAmountMinor,
    currency: row.reservation.currency,
  };
}

function matchedOn(
  candidate: { email: string | null; phone: string | null },
  email: string | null,
  phone: string | null,
): ('email' | 'phone')[] {
  const matched: ('email' | 'phone')[] = [];
  if (email !== null && candidate.email === email) matched.push('email');
  if (phone !== null && candidate.phone === phone) matched.push('phone');
  return matched;
}

@Injectable()
export class GuestsService {
  constructor(private readonly repository: GuestsRepository) {}

  async list(
    userId: string,
    hotelId: string,
    query: ListGuestProfilesQuery,
  ): Promise<GuestProfilePage> {
    const propertyId = await this.authorise(userId, hotelId, Permission.RESERVATIONS_READ);

    if (
      query.cursor !== undefined &&
      !(await this.repository.profileExists(propertyId, query.cursor))
    ) {
      throw new ValidationFailedError({
        cursor: 'This page link is no longer valid. Search again.',
      });
    }

    const needle = query.q?.trim() ?? '';
    const where: Prisma.GuestProfileWhereInput = {};
    if (needle !== '') {
      const or: Prisma.GuestProfileWhereInput[] = [
        { firstName: { contains: needle, mode: 'insensitive' } },
        { lastName: { contains: needle, mode: 'insensitive' } },
        { emailNormalized: { contains: needle.toLowerCase() } },
      ];
      const digits = needle.replace(/\D/g, '');
      if (digits.length >= 3) or.push({ phoneNormalized: { contains: digits } });
      where.OR = or;
    }

    const rows = await this.repository.search(propertyId, where, query.limit + 1, query.cursor);
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: items.map((row) => {
        const arrivals = row.stays.map((stay) => iso(stay.reservation.arrivalDate)).sort();
        return {
          id: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          phone: row.phone,
          stayCount: row.stays.length,
          lastArrivalDate: arrivals[arrivals.length - 1] ?? null,
        };
      }),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async detail(userId: string, hotelId: string, guestId: string): Promise<GuestProfileDetail> {
    const propertyId = await this.authorise(userId, hotelId, Permission.RESERVATIONS_READ);
    return this.buildDetail(propertyId, guestId);
  }

  async create(
    userId: string,
    hotelId: string,
    command: CreateGuestProfileCommand,
  ): Promise<GuestProfileDetail> {
    const propertyId = await this.authorise(userId, hotelId, Permission.RESERVATIONS_EDIT);

    const id = await this.repository.transaction(async (tx) => {
      const created = await tx.guestProfile.create({
        data: {
          propertyId,
          ...command,
          emailNormalized: normaliseEmail(command.email),
          phoneNormalized: normalisePhone(command.phone),
          createdById: userId,
        },
        select: { id: true },
      });
      await this.audit(tx, propertyId, userId, created.id, 'GUEST_PROFILE_CREATED', {
        fields: Object.keys(command).filter(
          (key) => command[key as keyof CreateGuestProfileCommand] !== null,
        ),
      });
      return created.id;
    });

    return this.buildDetail(propertyId, id);
  }

  async update(
    userId: string,
    hotelId: string,
    guestId: string,
    command: UpdateGuestProfileCommand,
  ): Promise<GuestProfileDetail> {
    const propertyId = await this.authorise(userId, hotelId, Permission.RESERVATIONS_EDIT);
    await this.requireProfile(propertyId, guestId);

    await this.repository.transaction(async (tx) => {
      // Only the keys the caller sent; `undefined` never reaches Prisma.
      const data: Prisma.GuestProfileUpdateManyMutationInput = Object.fromEntries(
        Object.entries(command).filter(([, value]) => value !== undefined),
      );
      if ('email' in command) data.emailNormalized = normaliseEmail(command.email);
      if ('phone' in command) data.phoneNormalized = normalisePhone(command.phone);
      const updated = await tx.guestProfile.updateMany({
        where: { id: guestId, propertyId },
        data,
      });
      if (updated.count === 0) throw new TenantScopeViolationError('Guest profile');
      await this.audit(tx, propertyId, userId, guestId, 'GUEST_PROFILE_UPDATED', {
        changed: Object.keys(command),
      });
    });

    return this.buildDetail(propertyId, guestId);
  }

  /**
   * Links one guest row to this profile. Idempotent when it is already linked
   * here; refused when it belongs to another profile (unlink it there first),
   * so a history is never moved without someone deciding to.
   */
  async link(
    userId: string,
    hotelId: string,
    guestId: string,
    command: LinkGuestStayCommand,
  ): Promise<GuestProfileDetail> {
    const propertyId = await this.authorise(userId, hotelId, Permission.RESERVATIONS_EDIT);
    await this.requireProfile(propertyId, guestId);

    await this.repository.transaction(async (tx) => {
      const updated = await tx.reservationGuest.updateMany({
        where: {
          id: command.reservationGuestId,
          propertyId,
          OR: [{ guestProfileId: null }, { guestProfileId: guestId }],
        },
        data: { guestProfileId: guestId },
      });
      if (updated.count === 0) {
        const row = await tx.reservationGuest.findFirst({
          where: { id: command.reservationGuestId, propertyId },
          select: { id: true },
        });
        if (row === null) throw new TenantScopeViolationError('Reservation guest');
        throw new ValidationFailedError({
          reservationGuestId:
            'This guest is already linked to another profile. Unlink it there first.',
        });
      }
      await this.audit(tx, propertyId, userId, guestId, 'GUEST_PROFILE_STAY_LINKED', {
        reservationGuestId: command.reservationGuestId,
      });
    });

    return this.buildDetail(propertyId, guestId);
  }

  async unlink(
    userId: string,
    hotelId: string,
    guestId: string,
    reservationGuestId: string,
  ): Promise<GuestProfileDetail> {
    const propertyId = await this.authorise(userId, hotelId, Permission.RESERVATIONS_EDIT);
    await this.requireProfile(propertyId, guestId);
    if (!UUID.test(reservationGuestId)) throw new TenantScopeViolationError('Reservation guest');

    await this.repository.transaction(async (tx) => {
      const updated = await tx.reservationGuest.updateMany({
        where: { id: reservationGuestId, propertyId, guestProfileId: guestId },
        data: { guestProfileId: null },
      });
      if (updated.count === 0) throw new TenantScopeViolationError('Reservation guest');
      await this.audit(tx, propertyId, userId, guestId, 'GUEST_PROFILE_STAY_UNLINKED', {
        reservationGuestId,
      });
    });

    return this.buildDetail(propertyId, guestId);
  }

  /* -------------------------------------------------------------------- */

  private async buildDetail(propertyId: string, guestId: string): Promise<GuestProfileDetail> {
    const profile = UUID.test(guestId) ? await this.repository.profile(propertyId, guestId) : null;
    if (profile === null) throw new TenantScopeViolationError('Guest profile');

    const email = profile.emailNormalized;
    const phone = profile.phoneNormalized;
    const [linked, suggestionIds, duplicates] = await Promise.all([
      this.repository.linkedStays(propertyId, profile.id),
      this.repository.matchingUnlinkedGuestIds(propertyId, email, phone),
      this.repository.duplicates(propertyId, profile.id, email, phone),
    ]);
    const suggested = await this.repository.staysByIds(propertyId, suggestionIds);

    return {
      id: profile.id,
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      phone: profile.phone,
      countryCode: profile.countryCode,
      preferences: profile.preferences,
      notes: profile.notes,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      stays: linked.map(toStay),
      suggestedStays: suggested.map((row) => ({
        ...toStay(row),
        matchedOn: matchedOn(
          { email: normaliseEmail(row.email), phone: normalisePhone(row.phone) },
          email,
          phone,
        ),
      })),
      possibleDuplicates: duplicates.map((row) => ({
        id: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        matchedOn: matchedOn(
          { email: row.emailNormalized, phone: row.phoneNormalized },
          email,
          phone,
        ),
      })),
    };
  }

  private async requireProfile(propertyId: string, guestId: string): Promise<void> {
    if (!UUID.test(guestId) || !(await this.repository.profileExists(propertyId, guestId))) {
      throw new TenantScopeViolationError('Guest profile');
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    propertyId: string,
    userId: string,
    guestId: string,
    event: string,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId,
        actorUserId: userId,
        event,
        entityType: 'guest_profile',
        entityId: guestId,
        before: Prisma.JsonNull,
        after,
        reason: null,
      },
    });
  }

  private async authorise(userId: string, hotelId: string, required: Permission): Promise<string> {
    const grants = await this.repository.grantsAt(
      grantedPropertyWhere({ userId, codeOrId: hotelId, operableOnly: false }),
    );
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    requirePermissionFromGrants(grants, required);
    return first.property.id;
  }
}
