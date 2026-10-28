/**
 * Cancelling a reservation.
 *
 * ===========================================================================
 * Giving nights back is the dangerous half, not the status change.
 *
 * Selling a room is protected by `inventory_day_not_oversold`: a transaction
 * that oversells cannot commit. Releasing one has the opposite failure mode —
 * a decrement that runs twice makes the hotel believe it has a room it does
 * not, and **no constraint catches that**, because `sold = 2` is perfectly
 * legal when the truth is 3. The oversell CHECK only looks upward.
 *
 * So the correctness of this file rests on the decrement running exactly once
 * per night per cancellation, and that is bought with two locks:
 *
 *   1. `SELECT … FOR UPDATE` on the reservation row. Two concurrent cancels
 *      serialise here; the loser wakes to find the status already `CANCELLED`
 *      and returns that as an idempotent success without touching inventory.
 *   2. `SELECT … FOR UPDATE … ORDER BY "stayDate" ASC` on the inventory rows,
 *      the same order `create-reservation.service.ts` and `room-move.service.ts`
 *      use, so a cancel and a booking contend for shared dates in one sequence
 *      instead of each holding half of what the other needs (section 3.1).
 *
 * The row lock is what makes this idempotent; the status check alone would be
 * a read-then-write race. A repeated HTTP call and two simultaneous ones take
 * the same path and reach the same end state.
 *
 * What it deliberately does NOT do: compute a fee, write a folio line, touch a
 * payment, or publish to a channel. See `cancel-reservation.dto.ts` for why the
 * fee is absent, and the service comment below for the ARI follow-up.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Permission,
  permissionsForRoles,
  ReservationStatus,
  type CancelReservationCommand,
  type CancelReservationResult,
  type Role,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  DomainError,
  ForbiddenError,
  InvalidStateTransitionError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { sqlState } from '../../common/errors/sql-state.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CANCEL_MAX_ATTEMPTS,
  cancelBackoffMs,
  isLockTimeout,
  isTransactionTimeout,
  isTransientCancelConflict,
  ROW_LOCK_TIMEOUT_MS,
} from './cancel-reservation.retry.js';
import { cancelRefusal, consumesInventory } from './reservation.state.js';

const DAY_MS = 86_400_000;

/** Every night of the stay. Departure day is exclusive — it is not sold. */
function stayDates(arrival: Date, departure: Date): Date[] {
  const dates: Date[] = [];
  for (let at = arrival.getTime(); at < departure.getTime(); at += DAY_MS) {
    dates.push(new Date(at));
  }
  return dates;
}

interface LockedStay {
  id: string;
  status: ReservationStatus;
  confirmation_code: string;
  arrival_date: Date;
  departure_date: Date;
  cancelled_at: Date | null;
}

@Injectable()
export class CancelReservationService {
  private readonly logger = new Logger(CancelReservationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authorise once, then run the transaction until it commits or gives up.
   *
   * The retry wraps the **whole** transaction, so an attempt that failed
   * re-reads the reservation under a fresh lock rather than resuming from a
   * half-finished state. That is what makes retrying safe here: a rolled-back
   * attempt released nothing and wrote nothing, and an attempt that committed
   * never reaches this loop. In the one pathological case — a connection lost
   * *after* COMMIT — the next attempt finds the booking already `CANCELLED`
   * and returns the idempotent reply with `nightsReleased: 0`, so the nights
   * are released exactly once either way.
   *
   * `authorise` stays outside the loop: a permission answer does not change
   * between attempts, and re-running it would triple the query cost of a
   * contended cancellation for nothing.
   */
  async cancel(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: CancelReservationCommand,
  ): Promise<CancelReservationResult> {
    const property = await this.authorise(userId, hotelId);

    let lastState: string | null = null;

    for (let attempt = 1; attempt <= CANCEL_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.commit(userId, property.id, reservationId, command);
      } catch (error) {
        /**
         * A typed failure is the answer, not a fault.
         *
         * Checked first and on purpose: `sqlState()` falls back to reading the
         * error *message*, so a domain error whose text happened to contain
         * something like "Code: 40001" could otherwise be misread as a
         * transient conflict and retried — turning a clean refusal into three
         * refusals and a wrong status code.
         */
        if (error instanceof DomainError) throw error;

        if (isLockTimeout(error)) {
          /**
           * Another transaction held the reservation or an inventory row for
           * longer than `ROW_LOCK_TIMEOUT_MS`, so Postgres cancelled this
           * statement and rolled the transaction back whole: no night
           * released, no status changed, no audit row. Not retried — see
           * `isLockTimeout`. The clerk gets a typed 409 promptly instead of a
           * spinner bounded by whoever holds the lock.
           */
          this.logger.warn(
            `Cancellation of reservation ${reservationId} gave up after waiting ` +
              `${String(ROW_LOCK_TIMEOUT_MS)}ms for a lock.`,
          );
          throw new TransactionConflictError('reservation cancellation');
        }

        if (isTransactionTimeout(error)) {
          // The transaction deadline, not the lock wait — `lock_timeout`
          // fires first for a blocked lock. Same answer: a typed 409 rather
          // than the unhandled 500 this used to produce.
          this.logger.warn(
            `Cancellation of reservation ${reservationId} exceeded the transaction deadline.`,
          );
          throw new TransactionConflictError('reservation cancellation');
        }

        if (!isTransientCancelConflict(error)) throw error;

        lastState = sqlState(error);
        this.logger.warn(
          `Cancellation attempt ${String(attempt)} of ${String(CANCEL_MAX_ATTEMPTS)} for ` +
            `reservation ${reservationId} hit SQLSTATE ${lastState ?? 'unknown'}; retrying.`,
        );

        if (attempt < CANCEL_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, cancelBackoffMs(attempt)));
        }
      }
    }

    this.logger.warn(
      `Cancellation of reservation ${reservationId} gave up after ` +
        `${String(CANCEL_MAX_ATTEMPTS)} attempts (last SQLSTATE ${lastState ?? 'unknown'}).`,
    );
    throw new TransactionConflictError('reservation cancellation');
  }

  /** One attempt: the whole cancellation, atomically. */
  private commit(
    userId: string,
    propertyId: string,
    reservationId: string,
    command: CancelReservationCommand,
  ): Promise<CancelReservationResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;

        /**
         * Bound the lock wait, before the first statement that can block.
         *
         * `true` is `set_config`'s is_local flag — the same mechanism as
         * `SET LOCAL`, scoped to this transaction and reverted at COMMIT or
         * ROLLBACK, so the global configuration and every other connection are
         * untouched. It is issued here because the next statement is the one
         * that blocks: a `FOR UPDATE` that arrives before the setting would
         * wait with no limit at all.
         *
         * Exceeding it raises `55P03`, which rolls the whole transaction back
         * and is mapped to a typed 409 by `cancel()`.
         */
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(
          ROW_LOCK_TIMEOUT_MS,
        )}, true)`;

        /**
         * The reservation row, locked.
         *
         * Scoped by `propertyId` in the same predicate as the id, so another
         * property's reservation is simply not found — a 404, never a 403,
         * because a 403 would confirm the booking exists (section 3.2).
         */
        const rows = await tx.$queryRaw<LockedStay[]>`
          SELECT "id",
                 "status"::text AS status,
                 "confirmationCode" AS confirmation_code,
                 "arrivalDate" AS arrival_date,
                 "departureDate" AS departure_date,
                 "cancelledAt" AS cancelled_at
          FROM reservation
          WHERE "id" = ${reservationId}::uuid
            AND "propertyId" = ${propertyId}::uuid
          FOR UPDATE
        `;

        const stay = rows[0];
        if (stay === undefined) throw new TenantScopeViolationError('Reservation');

        const refusal = cancelRefusal(stay.status);

        /**
         * Already cancelled: an idempotent success, not an error.
         *
         * A clerk double-clicking, a retried request and a second browser tab
         * all land here. Raising would teach the front desk that the button is
         * unreliable; releasing again would corrupt availability. Reporting the
         * existing cancellation does neither.
         */
        if (refusal === 'ALREADY_CANCELLED') {
          return {
            reservationId: stay.id,
            confirmationCode: stay.confirmation_code,
            status: 'CANCELLED' as const,
            /**
             * Null when the stored value is null, never `now()`.
             *
             * `reservation_cancelled_at_matches_status` permits a CANCELLED
             * row with no timestamp, so a booking cancelled by some other
             * means can genuinely have none. Substituting the current instant
             * would report a cancellation time that never happened, in a field
             * the master report reads.
             */
            cancelledAt: stay.cancelled_at?.toISOString() ?? null,
            nightsReleased: 0,
            alreadyCancelled: true,
            financialsUnchanged: true as const,
          };
        }

        if (refusal !== null) {
          throw new InvalidStateTransitionError(
            'reservation',
            stay.status,
            ReservationStatus.CANCELLED,
          );
        }

        const releasesInventory = consumesInventory(stay.status);
        const dates = stayDates(stay.arrival_date, stay.departure_date);
        let nightsReleased = 0;

        /**
         * What this stay holds, per room type.
         *
         * A reservation normally has one room row, but the schema permits
         * several, and a group of three deluxe rooms holds three nights of
         * deluxe inventory per date. Releasing one would leave the counter
         * two short for ever, so the release is driven by what the rows say
         * rather than by an assumed single room.
         */
        const roomRows = await tx.$queryRaw<{ room_type_id: string }[]>`
          SELECT "roomTypeId" AS room_type_id
          FROM reservation_room
          WHERE "reservationId" = ${stay.id}::uuid
            AND "propertyId" = ${propertyId}::uuid
        `;

        const heldPerType = new Map<string, number>();
        for (const row of roomRows) {
          heldPerType.set(row.room_type_id, (heldPerType.get(row.room_type_id) ?? 0) + 1);
        }

        /**
         * A stay that holds stock but has no room rows is refused, not
         * released.
         *
         * Without rows there is no category to give the nights back to, so
         * carrying on would answer 200 with `nightsReleased: 0` and leave the
         * counter permanently high — a room the hotel can never sell again,
         * reported as a success. `room-move.service.ts` refuses the same state
         * rather than guessing, and this matches it.
         *
         * Thrown before any write: the only statement so far is the
         * transaction-local `set_config`, so there is nothing to undo.
         */
        if (releasesInventory && heldPerType.size === 0) {
          throw new ValidationFailedError({
            reservationId:
              'This reservation holds inventory but has no room rows, so the nights ' +
              'it consumed cannot be identified or released. It needs an operator to ' +
              'reconcile it before it can be cancelled.',
          });
        }

        if (releasesInventory && dates.length > 0) {
          const roomTypeIds = [...heldPerType.keys()];

          /**
           * The nights, locked in ascending stay-date order, then room type —
           * exactly the order `room-move.service.ts` uses when it holds two
           * categories at once. `sold` is read under the lock, so the
           * verification below cannot be stale.
           */
          const locked = await tx.$queryRaw<
            { stay_date: Date; room_type_id: string; sold: number }[]
          >`
            SELECT "stayDate" AS stay_date, "roomTypeId" AS room_type_id, "sold"
            FROM inventory_day
            WHERE "propertyId" = ${propertyId}::uuid
              AND "roomTypeId" = ANY(${roomTypeIds}::uuid[])
              AND "stayDate" IN (${Prisma.join(dates)})
            ORDER BY "stayDate" ASC, "roomTypeId" ASC
            FOR UPDATE
          `;

          const expectedRows = dates.length * roomTypeIds.length;

          /**
           * Every night of every held category must have a row, and each must
           * have enough on it to give back. Either failure means the counters
           * already disagree with the bookings, and a partial release would
           * deepen that — some nights freed, some not, nothing recording
           * which. So it refuses the whole cancellation and says what it saw.
           * Unhelpful but honest, rather than helpful and wrong.
           */
          if (locked.length !== expectedRows) {
            throw new ValidationFailedError({
              inventory:
                'Inventory is not configured for every night of this stay, so it ' +
                'cannot be released. An operator needs to look at the calendar: ' +
                `expected ${String(expectedRows)} row(s), found ${String(locked.length)}.`,
            });
          }

          const short = locked.find(
            (row) => Number(row.sold) < (heldPerType.get(row.room_type_id) ?? 0),
          );
          if (short !== undefined) {
            throw new ValidationFailedError({
              inventory:
                `The sold counter for ${short.stay_date.toISOString().slice(0, 10)} is ` +
                `${String(short.sold)}, which is less than the ` +
                `${String(heldPerType.get(short.room_type_id) ?? 0)} room(s) this stay ` +
                'holds. The counters and the bookings disagree and need reconciling ' +
                'before this booking can be cancelled.',
            });
          }

          /**
           * The nights go back, one per room held of that category per date.
           *
           * `sold: { gte: held }` is redundant under the lock and kept anyway:
           * `inventory_day_counters_non_negative` would catch an underflow,
           * and this makes sure the database is never asked to.
           */
          for (const [roomTypeId, held] of heldPerType) {
            const released = await tx.inventoryDay.updateMany({
              where: {
                propertyId,
                roomTypeId,
                stayDate: { in: dates },
                sold: { gte: held },
              },
              data: { sold: { decrement: held } },
            });

            if (released.count !== dates.length) {
              // Unreachable while the lock above holds. If it ever fires, the
              // transaction must not commit a half-released stay.
              throw new ValidationFailedError({
                inventory:
                  `Expected to release ${String(dates.length)} night(s) of one category ` +
                  `but released ${String(released.count)}. Nothing was changed.`,
              });
            }

            nightsReleased += released.count * held;
          }
        }

        const cancelledAt = new Date();

        /**
         * Status and timestamp together, because
         * `reservation_cancelled_at_matches_status` requires it: a
         * `cancelledAt` on a non-cancelled booking is refused by the database,
         * which is what stops the master report showing a live stay as
         * cancelled.
         */
        await tx.reservation.update({
          where: { id: stay.id },
          data: { status: ReservationStatus.CANCELLED, cancelledAt },
        });

        /**
         * The room rows, which are what actually frees the room number.
         *
         * `reservation_room_no_overlap` is a **partial** exclusion constraint,
         * `WHERE ("status" NOT IN ('CANCELLED','NO_SHOW'))`. Leaving these rows
         * `CONFIRMED` would keep the room blocked for those nights however
         * cancelled the reservation looked, and the room-type counter would say
         * free while the room number said taken.
         */
        await tx.reservationRoom.updateMany({
          where: { reservationId: stay.id, propertyId },
          data: { status: ReservationStatus.CANCELLED },
        });

        // In the same transaction as the change it records (section 3.4).
        await tx.auditLog.create({
          data: {
            propertyId,
            actorUserId: userId,
            event: 'RESERVATION_CANCELLED',
            entityType: 'reservation',
            entityId: stay.id,
            before: { status: stay.status, cancelledAt: null },
            after: {
              status: ReservationStatus.CANCELLED,
              cancelledAt: cancelledAt.toISOString(),
              nightsReleased,
              inventoryReleased: releasesInventory,
            },
            reason: command.reason,
          },
        });

        this.logger.log(
          `Reservation ${stay.confirmation_code} cancelled; ${String(nightsReleased)} night(s) released.`,
        );

        return {
          reservationId: stay.id,
          confirmationCode: stay.confirmation_code,
          status: 'CANCELLED' as const,
          cancelledAt: cancelledAt.toISOString(),
          nightsReleased,
          alreadyCancelled: false,
          financialsUnchanged: true as const,
        };
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * The grant and the permission, resolved from the addressed property.
   *
   * Copied from `RoomMoveService.authorise` rather than abstracted: the route
   * carries an explicit hotelId that may differ from the session's active
   * property, so the check has to happen against the one named in the URL.
   * `reservations:edit` is the existing permission for changing a booking —
   * this slice adds no new permission.
   */
  private async authorise(userId: string, codeOrId: string): Promise<{ id: string; code: string }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codeOrId);

    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, code: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);

    if (!permissionsForRoles(roles).includes(Permission.RESERVATIONS_EDIT)) {
      throw new ForbiddenError(Permission.RESERVATIONS_EDIT);
    }

    return first.property;
  }
}
