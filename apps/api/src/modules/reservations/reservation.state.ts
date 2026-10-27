/**
 * Reservation state rules, for the cancellation path.
 *
 * ===========================================================================
 * CLAUDE.md section 3.4 asks for legal transitions in one place per aggregate.
 * This is the beginning of that place, and it is deliberately small: it holds
 * only what cancellation needs.
 *
 * `check-in.service.ts` keeps its own blocker switch and is **not** retrofitted
 * here. Moving it would be a refactor of a tested path for no behavioural gain,
 * and the two answer different questions anyway — check-in reports a *list* of
 * blockers to a modal before it commits, while cancellation needs a single
 * yes/no inside a transaction. When a third caller needs transitions, that is
 * the moment to unify them, with the tests to prove nothing moved.
 * ===========================================================================
 */

import { ReservationStatus } from '@repo/types';

/**
 * Statuses whose reservations hold a sold night in `inventory_day`.
 *
 * Verified against the only writer: `create-reservation.service.ts` increments
 * `sold` and sets the status to `CHECKED_IN` or `CONFIRMED`, nothing else. The
 * enum documents `TENTATIVE` and `ON_HOLD` as holding a room **without**
 * consuming inventory, so cancelling one of those must not decrement — a
 * decrement there would hand out a room the hotel never sold.
 *
 * `CHECKED_OUT` is excluded: the night has been consumed, not reserved, and
 * giving it back would oversell a date in the past.
 */
const CONSUMES_INVENTORY: ReadonlySet<ReservationStatus> = new Set([
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
]);

export function consumesInventory(status: ReservationStatus): boolean {
  return CONSUMES_INVENTORY.has(status);
}

/** Why a status cannot be cancelled, or `null` when it can. */
export type CancelRefusal =
  | 'ALREADY_CANCELLED'
  | 'CHECKED_IN'
  | 'CHECKED_OUT'
  | 'NO_SHOW';

/**
 * Whether this status may be cancelled, and if not, why.
 *
 * `CHECKED_IN` is refused rather than handled: a guest in the room is an
 * early departure, which is a different operation with different money
 * attached, and quietly treating it as a cancellation would release a room
 * somebody is sleeping in. `NO_SHOW` is refused because it is a terminal
 * status this slice does not implement, not because it is nonsensical.
 *
 * `ALREADY_CANCELLED` is a refusal here and an idempotent success at the
 * service boundary: the distinction is the caller's to make, and the service
 * makes it by returning the existing cancellation instead of raising.
 */
export function cancelRefusal(status: ReservationStatus): CancelRefusal | null {
  switch (status) {
    case ReservationStatus.CONFIRMED:
    case ReservationStatus.TENTATIVE:
    case ReservationStatus.ON_HOLD:
      return null;
    case ReservationStatus.CANCELLED:
      return 'ALREADY_CANCELLED';
    case ReservationStatus.CHECKED_IN:
      return 'CHECKED_IN';
    case ReservationStatus.CHECKED_OUT:
      return 'CHECKED_OUT';
    case ReservationStatus.NO_SHOW:
      return 'NO_SHOW';
  }
}
