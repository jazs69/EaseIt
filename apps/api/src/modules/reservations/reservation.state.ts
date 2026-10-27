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
 * This describes what the counter **already holds**, not what one might argue
 * it should. `sold` is incremented once, by `create-reservation.service.ts`,
 * and only two things ever reverse it: a cross-category room move, which
 * transfers rather than releases, and cancellation. **Nothing releases a night
 * at check-out** — there is no check-out path in the codebase at all — so a
 * checked-out stay's nights stay counted, and the authoritative derivation
 * agrees: `deriveSoldFromReservations()` recomputes `sold` from
 * `status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')`
 * [`packages/database/prisma/seed.ts`].
 *
 * `CHECKED_OUT` was wrongly excluded here at first, on the reasoning that a
 * past night is consumed rather than reserved. That is a defensible way to
 * model it and an inaccurate description of this column, which made this the
 * only place in the repository disagreeing with the counter. The read side
 * says the same thing in four modules — `timeline.repository.ts`,
 * `calendar.repository.ts`, `performance.repository.ts` and
 * `reports.repository.ts` all count `CHECKED_OUT` as consuming, the last two
 * saying explicitly that theirs is "the same set `inventory_day.sold` is
 * incremented for".
 *
 * Including it here does **not** mean a checked-out stay can be cancelled and
 * its nights handed back: `cancelRefusal` refuses `CHECKED_OUT` before this
 * predicate is ever consulted, which is deliberate, because releasing a past
 * date would both oversell history and corrupt the occupancy and ADR figures
 * that read `sold`. What including it buys is that the predicate stays true if
 * anyone ever reaches it by another route.
 *
 * `TENTATIVE` and `ON_HOLD` remain excluded: the enum documents both as
 * holding a room **without** consuming inventory, so releasing one would hand
 * out a room the hotel never sold. (`seed-portfolio.ts` counts `ON_HOLD` in
 * its own derivation while `seed.ts` does not — a separate inconsistency,
 * deliberately not addressed here.)
 */
const CONSUMES_INVENTORY: ReadonlySet<ReservationStatus> = new Set([
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
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
