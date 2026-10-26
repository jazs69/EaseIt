/**
 * Moving a stay between rooms.
 *
 * ===========================================================================
 * The exclusion constraint is the guarantee; this is the readable part.
 *
 * `reservation_room_no_overlap` makes it physically impossible for two stays
 * to hold the same room over overlapping nights (CLAUDE.md section 3.1). A
 * move is therefore safe by construction — the database refuses a collision
 * whatever this code believes — and what this adds is a clear answer before
 * the clerk commits, plus the bookkeeping the constraint does not do:
 *
 *   * An in-house move has to vacate the room behind the guest, or
 *     housekeeping never learns that 103 needs cleaning.
 *   * A move across categories is a re-sale, not a reassignment: the old
 *     category's counter must come down and the new one's go up, under the
 *     oversell CHECK. Skipping that is how a category quietly oversells.
 *
 * Both happen in the same transaction as the move, because a guest in a room
 * the inventory says is empty is worse than a failed move.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Permission,
  permissionsForRoles,
  ReservationStatus,
  type MoveCandidate,
  type MoveRoomCommand,
  type MoveRoomOptions,
  type MoveRoomResult,
  type PropertyId,
  type Role,
  type RoomId,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  ForbiddenError,
  RoomUnavailableError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { isRetryableSqlState, sqlState } from '../../common/errors/sql-state.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 3;

/** Room states that mean somebody is in there. */
const OCCUPIED = ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'];
/** Room states ready to receive a guest. */
const CLEAN = ['VACANT_CLEAN', 'INSPECTED'];

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function stayDates(arrival: Date, departure: Date): Date[] {
  const dates: Date[] = [];
  for (let at = arrival.getTime(); at < departure.getTime(); at += DAY_MS) {
    dates.push(new Date(at));
  }
  return dates;
}

@Injectable()
export class RoomMoveService {
  private readonly logger = new Logger(RoomMoveService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* -------------------------------------------------------------------- */
  /*  Options                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * Where this stay could go, committing to nothing.
   *
   * Lists dirty rooms as well as clean ones, flagged: at 11am most of the
   * house is dirty, and hiding them would leave the clerk with an empty list
   * on the shift when a move is most likely to be needed.
   */
  async options(
    userId: string,
    hotelId: string,
    reservationId: string,
  ): Promise<MoveRoomOptions> {
    const property = await this.authorise(userId, hotelId);
    const stay = await this.load(property.id, reservationId);

    const assignment = stay.rooms[0];
    if (assignment === undefined) {
      throw new ValidationFailedError({
        reservationId: 'This reservation has no room row and cannot be moved.',
      });
    }

    const rooms = await this.prisma.client.room.findMany({
      where: { propertyId: property.id, status: { not: 'OUT_OF_ORDER' } },
      select: {
        id: true,
        number: true,
        status: true,
        roomTypeId: true,
        roomType: { select: { name: true } },
        // A clash on any night of this stay, ignoring the stay's own row.
        reservationRooms: {
          where: {
            status: { notIn: [ReservationStatus.CANCELLED, ReservationStatus.NO_SHOW] },
            arrivalDate: { lt: stay.departureDate },
            departureDate: { gt: stay.arrivalDate },
            NOT: { id: assignment.id },
          },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { number: 'asc' },
    });

    const candidates: MoveCandidate[] = rooms.map((room) => ({
      id: room.id as RoomId,
      number: room.number,
      roomTypeId: room.roomTypeId,
      roomTypeName: room.roomType.name,
      housekeepingStatus: room.status,
      isClean: CLEAN.includes(room.status),
      isCategoryChange: room.roomTypeId !== assignment.roomTypeId,
      isFree: room.reservationRooms.length === 0 && !OCCUPIED.includes(room.status),
    }));

    // Same category first, then free before occupied, then by number — the
    // order a clerk actually scans in.
    candidates.sort((a, b) => {
      if (a.isCategoryChange !== b.isCategoryChange) return a.isCategoryChange ? 1 : -1;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return a.number.localeCompare(b.number, undefined, { numeric: true });
    });

    return {
      reservationId: stay.id,
      propertyId: property.id as PropertyId,
      bookingCode: stay.confirmationCode,
      guestName: `${stay.guestFirstName} ${stay.guestLastName}`.trim(),
      status: stay.status,
      arrivalDate: toBusinessDate(stay.arrivalDate) as MoveRoomOptions['arrivalDate'],
      departureDate: toBusinessDate(stay.departureDate) as MoveRoomOptions['departureDate'],
      nights: Math.max(
        1,
        Math.round((stay.departureDate.getTime() - stay.arrivalDate.getTime()) / DAY_MS),
      ),
      bookedRoomTypeId: assignment.roomTypeId,
      bookedRoomTypeName: assignment.roomType.name,
      currentRoomId: (assignment.roomId ?? null) as RoomId | null,
      currentRoomNumber: assignment.room?.number ?? null,
      candidates,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  The move                                                             */
  /* -------------------------------------------------------------------- */

  async move(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: MoveRoomCommand,
  ): Promise<MoveRoomResult> {
    const property = await this.authorise(userId, hotelId);
    const stay = await this.load(property.id, reservationId);

    const assignment = stay.rooms[0];
    if (assignment === undefined) {
      throw new ValidationFailedError({
        reservationId: 'This reservation has no room row and cannot be moved.',
      });
    }

    if (
      stay.status === ReservationStatus.CANCELLED ||
      stay.status === ReservationStatus.NO_SHOW ||
      stay.status === ReservationStatus.CHECKED_OUT
    ) {
      throw new ValidationFailedError({
        status: `A ${stay.status.toLowerCase().replace(/_/g, ' ')} reservation cannot be moved.`,
      });
    }

    const target =
      command.roomId === null
        ? null
        : await this.prisma.client.room.findFirst({
            where: { id: command.roomId, propertyId: property.id },
            select: { id: true, number: true, status: true, roomTypeId: true },
          });

    // 404, not 403: confirming a room exists at another property is the leak
    // (section 3.2).
    if (command.roomId !== null && target === null) {
      throw new TenantScopeViolationError('Room');
    }
    if (target !== null && target.status === 'OUT_OF_ORDER') {
      throw new ValidationFailedError({ roomId: 'That room is out of order.' });
    }
    if (target !== null && target.id === assignment.roomId) {
      throw new ValidationFailedError({ roomId: 'The stay is already in that room.' });
    }

    const categoryChanged = target !== null && target.roomTypeId !== assignment.roomTypeId;
    if (categoryChanged && !command.acknowledgeCategoryChange) {
      // Not a hard refusal — upgrades are routine — but it moves inventory
      // between categories, so it is confirmed rather than inferred.
      throw new ValidationFailedError({
        acknowledgeCategoryChange:
          'That room is a different category. Confirm the change to move inventory with it.',
      });
    }

    const movedAt = await this.withRetry(() =>
      this.commit(userId, property.id, stay, assignment, target, categoryChanged, command.reason),
    );

    return {
      reservationId: stay.id,
      fromRoomNumber: assignment.room?.number ?? null,
      toRoomNumber: target?.number ?? null,
      categoryChanged,
      movedAt: movedAt.toISOString(),
    };
  }

  private async commit(
    userId: string,
    propertyId: string,
    stay: { id: string; status: string; arrivalDate: Date; departureDate: Date },
    assignment: { id: string; roomId: string | null; roomTypeId: string },
    target: { id: string; number: string; status: string; roomTypeId: string } | null,
    categoryChanged: boolean,
    reason: string | null,
  ): Promise<Date> {
    const dates = stayDates(stay.arrivalDate, stay.departureDate);

    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;

        /**
         * A category change is a re-sale, so the counters move with it.
         *
         * Locked in stay-date order, matching every other inventory write, so
         * two concurrent moves acquire the shared dates in the same sequence
         * and one waits rather than both holding half of what the other needs
         * (section 3.1).
         */
        if (categoryChanged && target !== null) {
          await tx.$queryRaw`
            SELECT "stayDate"
            FROM inventory_day
            WHERE "propertyId" = ${propertyId}::uuid
              AND "roomTypeId" IN (${assignment.roomTypeId}::uuid, ${target.roomTypeId}::uuid)
              AND "stayDate" IN (${Prisma.join(dates)})
            ORDER BY "stayDate" ASC, "roomTypeId" ASC
            FOR UPDATE`;

          await tx.inventoryDay.updateMany({
            where: {
              propertyId,
              roomTypeId: assignment.roomTypeId,
              stayDate: { in: dates },
              sold: { gt: 0 },
            },
            data: { sold: { decrement: 1 } },
          });

          // The CHECK is what enforces the limit: a full category makes this
          // raise 23514 and the whole move rolls back.
          await tx.inventoryDay.updateMany({
            where: { propertyId, roomTypeId: target.roomTypeId, stayDate: { in: dates } },
            data: { sold: { increment: 1 } },
          });
        }

        await tx.reservationRoom.update({
          where: { id: assignment.id },
          data: {
            roomId: target?.id ?? null,
            ...(categoryChanged && target !== null ? { roomTypeId: target.roomTypeId } : {}),
          },
        });

        /**
         * Room statuses, where a guest is actually in the room.
         *
         * The room being left becomes dirty rather than clean — somebody slept
         * in it — and housekeeping finds out because this row changed, not
         * because a clerk remembered to tell them.
         */
        if (stay.status === ReservationStatus.CHECKED_IN) {
          if (assignment.roomId !== null) {
            await tx.room.update({
              where: { id: assignment.roomId },
              data: { status: 'VACANT_DIRTY' },
            });
          }
          if (target !== null) {
            await tx.room.update({
              where: { id: target.id },
              data: {
                status: CLEAN.includes(target.status) ? 'OCCUPIED_CLEAN' : 'OCCUPIED_DIRTY',
              },
            });
          }
        }

        const movedAt = new Date();

        // In the same transaction as the move it records (section 3.4).
        await tx.auditLog.create({
          data: {
            propertyId,
            actorUserId: userId,
            event: target === null ? 'RESERVATION_ROOM_UNASSIGNED' : 'RESERVATION_ROOM_MOVED',
            entityType: 'reservation',
            entityId: stay.id,
            before: { roomId: assignment.roomId, roomTypeId: assignment.roomTypeId },
            after: {
              roomId: target?.id ?? null,
              roomTypeId: target?.roomTypeId ?? assignment.roomTypeId,
              categoryChanged,
            },
            reason,
          },
        });

        return movedAt;
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Retries the genuinely retryable, then gives a clean answer.
   *
   * A caller never sees a SQLSTATE: they see `RoomUnavailableError`, because a
   * raw constraint name is meaningless to a clerk and a leak of internals
   * (section 5).
   */
  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    let last: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!isRetryableSqlState(error)) throw error;

        last = error;
        this.logger.warn(
          `Room move attempt ${String(attempt)} hit SQLSTATE ${String(sqlState(error))}; retrying.`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 50));
        }
      }
    }

    this.logger.warn(`Room move gave up after ${String(MAX_ATTEMPTS)} attempts.`);
    throw new RoomUnavailableError({
      reason:
        last !== null && sqlState(last) === '23514'
          ? 'That category is fully sold for these nights.'
          : 'That room was taken for these nights while the move was being made.',
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  private async authorise(
    userId: string,
    codeOrId: string,
  ): Promise<{ id: string; code: string }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, code: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants
      .map((grant) => grant.role.key)
      .filter((key): key is Role => key !== null);

    if (!permissionsForRoles(roles).includes(Permission.ROOMS_ASSIGN)) {
      throw new ForbiddenError(Permission.ROOMS_ASSIGN);
    }

    return first.property;
  }

  private async load(propertyId: string, reservationId: string) {
    const stay = await this.prisma.client.reservation.findFirst({
      where: { id: reservationId, propertyId },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        guestFirstName: true,
        guestLastName: true,
        arrivalDate: true,
        departureDate: true,
        rooms: {
          select: {
            id: true,
            roomId: true,
            roomTypeId: true,
            roomType: { select: { name: true } },
            room: { select: { number: true } },
          },
          take: 1,
        },
      },
    });

    if (stay === null) throw new TenantScopeViolationError('Reservation');
    return stay;
  }
}
