/**
 * Checking a guest out.
 *
 * ===========================================================================
 * Three things happen together, or none of them do.
 *
 * The reservation moves to CHECKED_OUT, the folio closes, and the physical
 * room is handed back. Splitting those across transactions would let a stay
 * end with its folio still open, or a room stay occupied after the guest has
 * gone, and the front desk would have no way to tell which half failed. They
 * are one transaction with one audit row.
 *
 * WHAT CHECKOUT DELIBERATELY DOES NOT DO
 *
 *   * **It does not touch `inventory_day`.** `reservation.state.ts` lists
 *     CHECKED_OUT in `CONSUMES_INVENTORY`, so a departed stay still holds the
 *     nights it slept in. Releasing them would both oversell history and
 *     corrupt the occupancy and ADR figures that read `sold` -- which is
 *     exactly why `cancelRefusal` refuses to cancel a CHECKED_OUT stay. The
 *     room becomes sellable again through the date range, not through a
 *     counter: `reservation_room_no_overlap` uses
 *     `daterange(arrival, departure, '[)')`, so the departure night was never
 *     blocked in the first place.
 *
 *   * **It moves no money.** The balance is verified to be zero and the folio
 *     is closed. No payment, refund or adjustment line is written to force
 *     that zero -- a folio that does not balance is a refusal, not a thing to
 *     paper over, and folio lines are immutable anyway (section 3.4).
 *
 * WHY THE RESERVATION ROW IS THE SERIALISATION POINT
 * The same reason check-in, cancellation and room-move use it. Every blocker
 * below is read before the transaction can write, and by the time the write
 * runs that answer can be false: a cancellation, a room move or a second
 * checkout may have committed in between. Taking the row `FOR UPDATE` first
 * and re-reading status, assignment and folio under that lock is what makes
 * the decision trustworthy rather than merely recent. Lock order is the
 * repository's: reservation row first, and nothing else here needs a second
 * lock because checkout writes no `inventory_day` row at all.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Permission,
  permissionsForRoles,
  ReservationStatus,
  type CheckOutCommand,
  type CheckOutResult,
  type Role,
} from '@repo/types';

import {
  DomainError,
  ForbiddenError,
  InvalidStateTransitionError,
  OutstandingBalanceError,
  TenantScopeViolationError,
  TransactionConflictError,
} from '../../common/errors/domain-error.js';
import { isLockTimeout, ROW_LOCK_TIMEOUT_MS, sqlState } from '../../common/errors/sql-state.js';
import { ClockService } from '../platform/clock.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { checkOutRefusal } from './reservation.state.js';

/** Room states a departing guest can leave behind, by cleanliness. */
const ROOM_AFTER_DEPARTURE = 'VACANT_DIRTY';

@Injectable()
export class CheckOutService {
  private readonly logger = new Logger(CheckOutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async checkOut(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: CheckOutCommand,
  ): Promise<CheckOutResult> {
    const property = await this.authorise(userId, hotelId);
    return await this.commit(userId, property.id, reservationId, command);
  }

  private async commit(
    userId: string,
    propertyId: string,
    reservationId: string,
    command: CheckOutCommand,
  ): Promise<CheckOutResult> {
    try {
      return await this.prisma.client.$transaction(
        async (tx) => {
          // Row-level security backstop (section 3.2): the ORM extension is the
          // primary control, and this is what saves us if a raw query below
          // ever forgets.
          await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;

          /**
           * Bound the lock wait, before the first statement that can block.
           *
           * `true` is `set_config`'s is_local flag — `SET LOCAL` semantics,
           * reverted at COMMIT or ROLLBACK, so the global configuration and
           * every other connection are untouched. Without it a checkout queued
           * behind a cancellation would wait for the holder rather than for a
           * budget: Prisma's `$transaction({ timeout })` cannot interrupt a
           * `SELECT … FOR UPDATE` already blocked inside Postgres.
           *
           * Exceeding it raises `55P03`, mapped to a typed 409 below and never
           * retried.
           */
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(
            ROW_LOCK_TIMEOUT_MS,
          )}, true)`;

          /**
           * The reservation row, locked before anything status-dependent is
           * read or written, and scoped by `propertyId` in the same predicate
           * as the id so another property's stay is simply not found rather
           * than forbidden (section 3.2).
           */
          const locked = await tx.$queryRaw<
            { id: string; confirmation_code: string; status: string; currency: string }[]
          >`
            SELECT "id"::text AS id,
                   "confirmationCode" AS confirmation_code,
                   "status"::text AS status,
                   "currency" AS currency
            FROM reservation
            WHERE "id" = ${reservationId}::uuid
              AND "propertyId" = ${propertyId}::uuid
            FOR UPDATE
          `;

          const stay = locked[0];
          if (stay === undefined) throw new TenantScopeViolationError('Reservation');

          const refusal = checkOutRefusal(stay.status as ReservationStatus);

          /**
           * Already checked out: an idempotent success, not an error.
           *
           * A clerk double-clicking, a retried request and a second browser tab
           * all land here. Raising would teach the desk that the button is
           * unreliable; closing the folio again or marking the room dirty a
           * second time would be a duplicate effect. Reporting the existing
           * checkout does neither, and writes nothing — the same shape
           * cancellation uses for `ALREADY_CANCELLED`.
           */
          if (refusal === 'ALREADY_CHECKED_OUT') {
            const existing = await this.readState(tx, reservationId, propertyId);
            return {
              reservationId: stay.id,
              confirmationCode: stay.confirmation_code,
              status: 'CHECKED_OUT' as const,
              checkedOutAt: existing.checkedOutAt,
              folioId: existing.folioId,
              folioStatus: existing.folioStatus,
              balanceMinor: existing.balanceMinor,
              currency: existing.currency ?? stay.currency,
              roomId: existing.roomId,
              roomNumber: existing.roomNumber,
              roomStatus: existing.roomStatus,
              alreadyCheckedOut: true,
              financialsUnchanged: true as const,
            } satisfies CheckOutResult;
          }

          if (refusal !== null) {
            // Every other state: nobody is in the room to check out. One typed
            // 409, the same error a pre-flight state blocker would have raised.
            throw new InvalidStateTransitionError(
              'reservation',
              stay.status,
              ReservationStatus.CHECKED_OUT,
            );
          }

          /**
           * The balance, summed from the lines under the lock.
           *
           * Never `reservation.paidAmountMinor`: that is a materialised
           * convenience maintained by the folio path, and section 3.4 forbids
           * trusting a cached balance. The authoritative answer is the sum of
           * the folio's immutable lines, where charges are positive and
           * payments negative, so a settled folio sums to exactly zero.
           *
           * Summed inside the transaction, after the row lock, so a payment
           * committing between the pre-flight read and here cannot be missed
           * -- and neither can one that was rolled back.
           */
          /**
           * `findFirst` with `propertyId`, not `findUnique` on
           * `reservationId`.
           *
           * The unique selector would have found the right row -- the
           * reservation's property was already proven under the lock above, and
           * `folio.reservationId` is unique -- but section 3.2 asks every query
           * on a tenant-scoped table to carry `propertyId` rather than to
           * inherit it by argument. A folio whose `propertyId` ever disagreed
           * with its reservation's is then simply not found, which is the
           * behaviour the rest of the repository has (`folios.service.ts:1375`).
           */
          const folio = await tx.folio.findFirst({
            where: { reservationId, propertyId },
            select: { id: true, status: true, currency: true },
          });

          const balanceMinor =
            folio === null
              ? 0
              : ((
                  await tx.folioLine.aggregate({
                    where: { folioId: folio.id, propertyId },
                    _sum: { amountMinor: true },
                  })
                )._sum.amountMinor ?? 0);

          const currency = folio?.currency ?? stay.currency;

          /**
           * A non-zero balance refuses the checkout, in either direction.
           *
           * Positive is money owed. Negative is a credit, and checking out over
           * one would strand the guest's money in a closed folio -- returning
           * it is a refund, a separate operation with its own permission, not
           * something checkout should do silently. Thrown before any write, so
           * there is nothing to undo: the only statements so far are the two
           * transaction-local `set_config` calls and reads.
           */
          if (balanceMinor !== 0) {
            throw new OutstandingBalanceError(balanceMinor, currency);
          }

          /**
           * The assignment, re-read under the same lock.
           *
           * A room move committing between the pre-flight read and here would
           * leave this releasing a room the guest is no longer in. Reading it
           * under the lock means the room handed back is the room they left.
           */
          const assignment = await tx.reservationRoom.findFirst({
            where: { reservationId, propertyId },
            select: {
              id: true,
              roomId: true,
              status: true,
              room: { select: { id: true, number: true, status: true } },
            },
          });

          const checkedOutAt = this.clock.now();

          await tx.reservation.update({
            where: { id: reservationId },
            data: { status: ReservationStatus.CHECKED_OUT, checkedOutAt },
          });

          /**
           * The assignment row carries the same status, in the same
           * transaction.
           *
           * `reservation_room.status` is its own `ReservationStatus` column, and
           * every other writer mirrors the stay onto it: check-in writes
           * CHECKED_IN (`check-in.service.ts:453`) precisely because a stale
           * label there misrepresents an in-house stay, cancellation writes
           * CANCELLED (`cancel-reservation.service.ts:427`), and a room move
           * rewrites the row. Leaving CHECKED_IN on a departed stay would make
           * the assignment disagree with the reservation, and anything reading
           * this column as "the guest is in the room" -- the timeline, an
           * arrivals/departures board, housekeeping -- would believe it.
           *
           * It changes no behaviour that exists today, and that is the point of
           * writing it now rather than when something depends on it: CHECKED_OUT
           * is outside `('CANCELLED', 'NO_SHOW')`, so the row stays inside
           * `reservation_room_no_overlap` and the room is not freed for an
           * overlapping stay; and it is in the timeline's `OCCUPYING_STATUSES`
           * and `CONSUMING_STATUSES`, so the block keeps being drawn and the
           * night keeps being counted, which is what `CONSUMES_INVENTORY`
           * requires of a departed stay.
           *
           * `updateMany` scoped by `reservationId` **and** `propertyId`, the
           * shape cancellation uses: it cannot reach another stay or another
           * property's data, it covers a multi-room stay, and it is a no-op
           * rather than an error when there is no assignment yet. Setting a
           * constant makes a replay idempotent by construction.
           */
          await tx.reservationRoom.updateMany({
            where: { reservationId, propertyId },
            data: { status: ReservationStatus.CHECKED_OUT },
          });

          /**
           * The room goes back dirty, not clean.
           *
           * Somebody slept in it. This is the transition `room-move.service.ts`
           * already applies to a room a checked-in guest leaves, reused rather
           * than reinvented, so the housekeeping board and the calendar agree
           * about where the work is. No new status and no housekeeping module:
           * occupancy lives in the existing `RoomStatus` enum.
           *
           * `status: { in: [...] }` narrows the update to the occupied states,
           * so a room somebody has already taken out of order is not quietly
           * marked dirty, and a replay cannot re-dirty a room that has since
           * been cleaned.
           */
          let roomStatus: string | null = assignment?.room?.status ?? null;
          if (assignment?.roomId != null) {
            const released = await tx.room.updateMany({
              where: {
                id: assignment.roomId,
                propertyId,
                status: { in: ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'] },
              },
              data: { status: ROOM_AFTER_DEPARTURE },
            });
            if (released.count > 0) roomStatus = ROOM_AFTER_DEPARTURE;
          }

          /**
           * The folio closes in the same transaction.
           *
           * `status: 'OPEN'` in the predicate rather than a blind update: a
           * folio somebody already closed or transferred is left exactly as it
           * is, so a replay cannot move `closedAt` or reopen a decision
           * somebody else made.
           */
          let folioStatus: CheckOutResult['folioStatus'] = folio?.status ?? null;
          if (folio !== null && folio.status === 'OPEN') {
            const closed = await tx.folio.updateMany({
              where: { id: folio.id, propertyId, status: 'OPEN' },
              data: { status: 'CLOSED', closedAt: checkedOutAt },
            });
            if (closed.count > 0) folioStatus = 'CLOSED';
          }

          // The audit row, in the same transaction as the change (section 3.4).
          // A rollback takes it with everything else.
          await tx.auditLog.create({
            data: {
              propertyId,
              actorUserId: userId,
              event: 'RESERVATION_CHECKED_OUT',
              entityType: 'reservation',
              entityId: reservationId,
              before: {
                status: stay.status,
                assignmentStatus: assignment?.status ?? null,
                folioStatus: folio?.status ?? null,
                roomId: assignment?.roomId ?? null,
                roomStatus: assignment?.room?.status ?? null,
              },
              after: {
                status: ReservationStatus.CHECKED_OUT,
                assignmentStatus: assignment === null ? null : ReservationStatus.CHECKED_OUT,
                folioStatus,
                roomId: assignment?.roomId ?? null,
                roomStatus,
                balanceMinor,
              },
              reason: command.reason,
            },
          });

          return {
            reservationId,
            confirmationCode: stay.confirmation_code,
            status: 'CHECKED_OUT' as const,
            checkedOutAt: checkedOutAt.toISOString(),
            folioId: folio?.id ?? null,
            folioStatus,
            balanceMinor,
            currency,
            roomId: assignment?.roomId ?? null,
            roomNumber: assignment?.room?.number ?? null,
            roomStatus,
            alreadyCheckedOut: false,
            financialsUnchanged: true as const,
          } satisfies CheckOutResult;
        },
        { timeout: 10_000, isolationLevel: 'ReadCommitted' },
      );
    } catch (error) {
      /**
       * A typed refusal is the answer, not a fault — and it is checked first
       * on purpose: `sqlState()` falls back to reading the error *message*, so
       * a domain error whose text happened to contain something like
       * "Code: 23514" would otherwise be reclassified and returned with the
       * wrong status.
       */
      if (error instanceof DomainError) throw error;

      /**
       * The lock wait hit `ROW_LOCK_TIMEOUT_MS`, or Postgres rolled one side
       * of a deadlock back. Neither is retried here: checkout is not
       * idempotent in the sense a retry needs — it closes a folio and writes
       * an audit row — and the clerk pressing the button again is safe,
       * because every guard above re-runs under the lock. A typed 409 says
       * "try that again" without this service guessing on their behalf.
       */
      if (isLockTimeout(error) || sqlState(error) === '40P01' || sqlState(error) === '40001') {
        this.logger.warn(
          `Check-out for ${reservationId} gave up on a contended row ` +
            `(SQLSTATE ${sqlState(error) ?? 'unknown'}).`,
        );
        throw new TransactionConflictError('check-out');
      }

      throw error;
    }
  }

  /** The persisted state of an already-departed stay, for the idempotent reply. */
  private async readState(
    tx: Parameters<Parameters<PrismaService['client']['$transaction']>[0]>[0],
    reservationId: string,
    propertyId: string,
  ): Promise<{
    checkedOutAt: string | null;
    folioId: string | null;
    folioStatus: CheckOutResult['folioStatus'];
    balanceMinor: number;
    currency: string | null;
    roomId: string | null;
    roomNumber: string | null;
    roomStatus: string | null;
  }> {
    const stay = await tx.reservation.findFirst({
      where: { id: reservationId, propertyId },
      select: { checkedOutAt: true, currency: true },
    });

    // Property-scoped for the same reason as the lookup in `commit`.
    const folio = await tx.folio.findFirst({
      where: { reservationId, propertyId },
      select: { id: true, status: true, currency: true },
    });

    const balanceMinor =
      folio === null
        ? 0
        : ((
            await tx.folioLine.aggregate({
              where: { folioId: folio.id, propertyId },
              _sum: { amountMinor: true },
            })
          )._sum.amountMinor ?? 0);

    const assignment = await tx.reservationRoom.findFirst({
      where: { reservationId, propertyId },
      select: { roomId: true, room: { select: { number: true, status: true } } },
    });

    return {
      checkedOutAt: stay?.checkedOutAt?.toISOString() ?? null,
      folioId: folio?.id ?? null,
      folioStatus: folio?.status ?? null,
      balanceMinor,
      currency: folio?.currency ?? stay?.currency ?? null,
      roomId: assignment?.roomId ?? null,
      roomNumber: assignment?.room?.number ?? null,
      roomStatus: assignment?.room?.status ?? null,
    };
  }

  /**
   * The grant alone is not enough.
   *
   * Housekeeping holds a grant at the property and must not be able to check a
   * guest out. The permission is checked here rather than in a guard because
   * the route is addressed by an explicit `hotelId` that may differ from the
   * session's active property (section 3.2) — the same reason check-in does it
   * here.
   */
  private async authorise(userId: string, codeOrId: string): Promise<{ id: string }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codeOrId);

    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: {
        role: { select: { key: true } },
        property: { select: { id: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);

    if (!permissionsForRoles(roles).includes(Permission.RESERVATIONS_CHECKOUT)) {
      throw new ForbiddenError(Permission.RESERVATIONS_CHECKOUT);
    }

    return first.property;
  }
}
