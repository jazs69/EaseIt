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
  type MarkNoShowCommand,
  type MarkNoShowResult,
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
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import {
  CANCEL_MAX_ATTEMPTS,
  cancelBackoffMs,
  isLockTimeout,
  isTransactionTimeout,
  isTransientCancelConflict,
  ROW_LOCK_TIMEOUT_MS,
} from './cancel-reservation.retry.js';
import { cancelRefusal, consumesInventory, noShowRefusal } from './reservation.state.js';

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
    return this.withRetry('reservation cancellation', reservationId, () =>
      this.commit(userId, property.id, reservationId, command),
    );
  }

  /**
   * RS-13: mark a guest who never arrived as a no-show.
   *
   * ===========================================================================
   * The same transaction shape as a cancellation, and the same release code:
   * the reservation row FOR UPDATE first, then every held night given back
   * from the actual `reservation_room` rows, refusing rather than guessing
   * when counters and bookings disagree (section 3.1.1). `NO_SHOW` does not
   * consume inventory (`reservation.state.ts`), so keeping the nights sold
   * would leave `inventory_day.sold` disagreeing with the stays for good.
   *
   * Legal from CONFIRMED, TENTATIVE and ON_HOLD, and only once the property's
   * business date has reached the arrival date: before that the guest has not
   * failed to arrive. Already NO_SHOW is an idempotent success. No money moves.
   * Night audit's no-show roll (step 2) will call this same path when it exists.
   * ===========================================================================
   */
  async markNoShow(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: MarkNoShowCommand,
  ): Promise<MarkNoShowResult> {
    const property = await this.authorise(userId, hotelId);
    return this.withRetry('no-show', reservationId, () =>
      this.commitNoShow(userId, property.id, reservationId, command),
    );
  }

  /**
   * Night audit step 2 (section 3.3): the same no-show, by the system.
   *
   * No grant check, because no person is acting: the audit is a scheduled
   * job for one property, and the property is passed in rather than resolved
   * from a session. The audit row's actor is null, which the schema documents
   * as "a system actor like the night audit". Everything else -- the lock, the
   * arrival-date rule, the release, idempotency -- is the path a clerk uses.
   */
  async markNoShowAsSystem(
    propertyId: string,
    reservationId: string,
    reason: string,
  ): Promise<MarkNoShowResult> {
    return this.withRetry('no-show', reservationId, () =>
      this.commitNoShow(null, propertyId, reservationId, { reason }),
    );
  }

  /**
   * CM-04: a cancellation the channel sent, by the system.
   *
   * No grant check, because no person is acting: the property is the inbound
   * message's own, passed in rather than resolved from a session, exactly as
   * `markNoShowAsSystem` does for the night audit. Everything else -- the
   * reservation lock first, the release from the actual room rows, the
   * refusals, the idempotent replay -- is the clerk's path unchanged.
   */
  async cancelAsSystem(
    propertyId: string,
    reservationId: string,
    reason: string,
  ): Promise<CancelReservationResult> {
    return this.withRetry('reservation cancellation', reservationId, () =>
      this.commit(null, propertyId, reservationId, { reason }),
    );
  }

  /**
   * Run one attempt until it commits or gives up: typed errors pass straight
   * through, a lock timeout or deadline is a 409, and only 40001/40P01 retry.
   */
  private async withRetry<T>(
    operation: string,
    reservationId: string,
    attemptOnce: () => Promise<T>,
  ): Promise<T> {
    let lastState: string | null = null;

    for (let attempt = 1; attempt <= CANCEL_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await attemptOnce();
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
            `${operation} of reservation ${reservationId} gave up after waiting ` +
              `${String(ROW_LOCK_TIMEOUT_MS)}ms for a lock.`,
          );
          throw new TransactionConflictError(operation);
        }

        if (isTransactionTimeout(error)) {
          // The transaction deadline, not the lock wait — `lock_timeout`
          // fires first for a blocked lock. Same answer: a typed 409 rather
          // than the unhandled 500 this used to produce.
          this.logger.warn(
            `${operation} of reservation ${reservationId} exceeded the transaction deadline.`,
          );
          throw new TransactionConflictError(operation);
        }

        if (!isTransientCancelConflict(error)) throw error;

        lastState = sqlState(error);
        this.logger.warn(
          `${operation} attempt ${String(attempt)} of ${String(CANCEL_MAX_ATTEMPTS)} for ` +
            `reservation ${reservationId} hit SQLSTATE ${lastState ?? 'unknown'}; ` +
            (attempt < CANCEL_MAX_ATTEMPTS ? 'retrying.' : 'no attempts left.'),
        );

        if (attempt < CANCEL_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, cancelBackoffMs(attempt)));
        }
      }
    }

    this.logger.warn(
      `${operation} of reservation ${reservationId} gave up after ` +
        `${String(CANCEL_MAX_ATTEMPTS)} attempts (last SQLSTATE ${lastState ?? 'unknown'}).`,
    );
    throw new TransactionConflictError(operation);
  }

  /** One attempt: the whole cancellation, atomically. A null user is the system. */
  private commit(
    userId: string | null,
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

        const { nightsReleased, releasesInventory } = await this.releaseHeldNights(
          tx,
          propertyId,
          stay,
          'cancelled',
        );

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

  /** One attempt: the whole no-show, atomically (RS-13). */
  private commitNoShow(
    userId: string | null,
    propertyId: string,
    reservationId: string,
    command: MarkNoShowCommand,
  ): Promise<MarkNoShowResult> {
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
        // Bounded wait before the first blocking statement; 55P03 -> 409.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(
          ROW_LOCK_TIMEOUT_MS,
        )}, true)`;

        // The reservation row first, scoped by property in the same predicate.
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

        const refusal = noShowRefusal(stay.status);
        if (refusal === 'ALREADY_NO_SHOW') {
          return {
            reservationId: stay.id,
            confirmationCode: stay.confirmation_code,
            status: 'NO_SHOW' as const,
            markedAt: stay.cancelled_at?.toISOString() ?? null,
            nightsReleased: 0,
            alreadyNoShow: true,
            financialsUnchanged: true as const,
          };
        }
        if (refusal !== null) {
          throw new InvalidStateTransitionError(
            'reservation',
            stay.status,
            ReservationStatus.NO_SHOW,
          );
        }

        /**
         * Not before the arrival business date. Read inside the transaction,
         * and from the property's business date, never the wall clock
         * (section 3.3): a guest due today becomes a no-show when the desk or
         * the audit says so, not at midnight UTC.
         */
        const property = await tx.property.findFirst({
          where: { id: propertyId },
          select: { businessDate: true },
        });
        if (property === null) throw new TenantScopeViolationError('Property');
        if (stay.arrival_date.getTime() > property.businessDate.getTime()) {
          throw new ValidationFailedError({
            reservationId:
              `The guest is due on ${stay.arrival_date.toISOString().slice(0, 10)}; ` +
              `today's business date is ${property.businessDate.toISOString().slice(0, 10)}. ` +
              'A stay can only be marked a no-show on or after its arrival date.',
          });
        }

        const { nightsReleased, releasesInventory } = await this.releaseHeldNights(
          tx,
          propertyId,
          stay,
          'marked a no-show',
        );

        const markedAt = new Date();

        // `reservation_cancelled_at_matches_status` permits cancelledAt on a
        // NO_SHOW: it is when the stay was closed out, which the master
        // report's cancellation-date column reads.
        await tx.reservation.update({
          where: { id: stay.id },
          data: { status: ReservationStatus.NO_SHOW, cancelledAt: markedAt },
        });

        // NO_SHOW is outside `reservation_room_no_overlap`, so this frees the
        // room number for those nights, matching the released counters.
        await tx.reservationRoom.updateMany({
          where: { reservationId: stay.id, propertyId },
          data: { status: ReservationStatus.NO_SHOW },
        });

        await tx.auditLog.create({
          data: {
            propertyId,
            actorUserId: userId,
            event: 'RESERVATION_NO_SHOW',
            entityType: 'reservation',
            entityId: stay.id,
            before: { status: stay.status, cancelledAt: null },
            after: {
              status: ReservationStatus.NO_SHOW,
              markedAt: markedAt.toISOString(),
              nightsReleased,
              inventoryReleased: releasesInventory,
            },
            reason: command.reason,
          },
        });

        this.logger.log(
          `Reservation ${stay.confirmation_code} marked no-show; ${String(nightsReleased)} night(s) released.`,
        );

        return {
          reservationId: stay.id,
          confirmationCode: stay.confirmation_code,
          status: 'NO_SHOW' as const,
          markedAt: markedAt.toISOString(),
          nightsReleased,
          alreadyNoShow: false,
          financialsUnchanged: true as const,
        };
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Give back every night a stay holds, exactly once, under the locks.
   *
   * Shared by cancellation and no-show (RS-13) so there is one release
   * implementation, not two that can drift. Must run after the reservation
   * row is locked FOR UPDATE in the same transaction. Driven by the live
   * `reservation_room` rows; refuses (writing nothing) when the stay holds
   * inventory without room rows, when a night has no inventory row, or when
   * a counter is lower than what the stay holds.
   */
  private async releaseHeldNights(
    tx: Prisma.TransactionClient,
    propertyId: string,
    stay: LockedStay,
    outcome: 'cancelled' | 'marked a no-show',
  ): Promise<{ nightsReleased: number; releasesInventory: boolean }> {
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
          `reconcile it before it can be ${outcome}.`,
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
      const locked = await tx.$queryRaw<{ stay_date: Date; room_type_id: string; sold: number }[]>`
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
            `before this booking can be ${outcome}.`,
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

    return { nightsReleased, releasesInventory };
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
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
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
