/**
 * Cancelling a reservation.
 *
 * ===========================================================================
 * This records a cancellation and gives the nights back. It moves no money.
 *
 * A cancellation fee is a commercial rule this product has not decided:
 * `PropertyPolicy.freeCancellationHours` and `retentionChargePercent` exist
 * and are configurable, but nothing reads them, and what they mean at their
 * boundaries is still open (see `research/channel-manager/17-…` section 13).
 * Computing a retention charge here would mean inventing that rule.
 *
 * So the deliberate scope is: status, timestamp, inventory, audit. A retention
 * charge, where one is due, is posted by the front desk through the existing
 * folio charge endpoint, which already exists and already audits. The absence
 * of an automatic fee is a stated boundary, not an oversight — and the UI says
 * so, because a clerk who assumes a refund was calculated is worse off than
 * one who knows it was not.
 * ===========================================================================
 */

import { z } from 'zod';

export const cancelReservationSchema = z.object({
  /**
   * Why, in the operator's words. Recorded on the audit row.
   *
   * Optional because a front desk under pressure should not be blocked from
   * releasing a room by a required text field, and a forced reason produces
   * "x" rather than information.
   */
  reason: z.string().trim().max(200).nullable().default(null),
});

export type CancelReservationCommand = z.infer<typeof cancelReservationSchema>;

export const cancelReservationResultSchema = z.object({
  reservationId: z.uuid(),
  confirmationCode: z.string(),
  status: z.literal('CANCELLED'),

  /**
   * When it was cancelled, or `null` when that is genuinely not recorded.
   *
   * Nullable because `reservation_cancelled_at_matches_status` permits a
   * CANCELLED row with no timestamp: the CHECK is
   * `cancelledAt IS NULL OR status IN ('CANCELLED','NO_SHOW')`, which
   * constrains the timestamp's presence on a *live* booking and not its
   * absence on a cancelled one. A reply from this endpoint's own write always
   * carries an instant; an idempotent replay of a booking cancelled by other
   * means reports what is stored, rather than inventing `now()`.
   */
  cancelledAt: z.string().nullable(),

  /**
   * How many nights were returned to inventory by **this** request.
   *
   * `0` with `alreadyCancelled: true` is the idempotent replay: the booking
   * was cancelled before this call, and its nights were released then. `0`
   * with `alreadyCancelled: false` means the booking never consumed inventory
   * — a tentative or on-hold booking, which per `ReservationStatus` holds a
   * room without selling it.
   */
  nightsReleased: z.number().int().nonnegative(),

  /** True when the booking was already cancelled and this call changed nothing. */
  alreadyCancelled: z.boolean(),

  /**
   * Always true, and always surfaced.
   *
   * Says that no fee, refund or folio line was produced. It is a field rather
   * than prose so a caller cannot miss it, and so the day this workflow does
   * compute a fee, every consumer has to confront the change.
   */
  financialsUnchanged: z.literal(true),
});

export type CancelReservationResult = z.infer<typeof cancelReservationResultSchema>;

/**
 * RS-13: marking a guest who never arrived as a no-show.
 *
 * Same shape and the same boundary as a cancellation: status, timestamp, every
 * held night released, audit. No money moves; a no-show fee, where one is due,
 * is posted through the folio charge endpoint. Only on or after the arrival
 * business date, because before it the guest has not yet failed to arrive.
 */
export const markNoShowSchema = cancelReservationSchema;

export type MarkNoShowCommand = z.infer<typeof markNoShowSchema>;

export const markNoShowResultSchema = z.object({
  reservationId: z.uuid(),
  confirmationCode: z.string(),
  status: z.literal('NO_SHOW'),
  /** When it was marked; stored in `cancelledAt`, which the schema permits for NO_SHOW. */
  markedAt: z.string().nullable(),
  nightsReleased: z.number().int().nonnegative(),
  /** True when it was already a no-show and this call changed nothing. */
  alreadyNoShow: z.boolean(),
  financialsUnchanged: z.literal(true),
});

export type MarkNoShowResult = z.infer<typeof markNoShowResultSchema>;
