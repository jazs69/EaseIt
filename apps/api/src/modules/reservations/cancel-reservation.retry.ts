/**
 * Which cancellation failures are worth another attempt.
 *
 * ===========================================================================
 * Deliberately narrower than the shared booking set, and that is the point.
 *
 * `common/errors/sql-state.ts` treats `23514`, `23P01` and `23505` as
 * retryable, which is right for a **booking**: a check, exclusion or unique
 * violation there usually means a concurrent sale took the last room, and a
 * second attempt reads the new truth and either succeeds or refuses cleanly.
 *
 * For a **cancellation** those same states mean something else entirely:
 *
 *   * `23514` on this path can only be `inventory_day_counters_non_negative`,
 *     i.e. the counter holds less than the stay says it does. The service
 *     already verifies that under `FOR UPDATE` and refuses, so reaching the
 *     CHECK means the counters and the bookings genuinely disagree. Retrying
 *     cannot fix that and would turn a visible data problem into a slow one.
 *   * `23P01` cannot occur: cancellation inserts no overlapping range.
 *   * `23505` cannot occur: it writes no uniquely-keyed row (`audit_log` has
 *     no unique constraint).
 *
 * So reusing `isRetryableSqlState` here would retry three things that are
 * permanent in this context. What is left is the genuinely transient pair,
 * where Postgres itself has already rolled the transaction back and the
 * documented remedy is to run it again.
 *
 * A lock timeout (`55P03`) and a transaction timeout (`P2028`) are each
 * handled separately and neither is retried — see `isLockTimeout` and
 * `isTransactionTimeout` below.
 * ===========================================================================
 */

import { PrismaErrorCode } from '@repo/database';

import { sqlState } from '../../common/errors/sql-state.js';

/**
 * The lock-wait budget and its SQLSTATE both now live in
 * `common/errors/sql-state.ts`, shared with room-move and check-in, which
 * take the same reservation row. Re-exported rather than re-implemented so
 * there is one definition and one value.
 */
export { isLockTimeout, ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';

/**
 * Postgres SQLSTATEs a cancellation may re-run from the beginning.
 *
 * `40P01` is absent from the shared set in `sql-state.ts`, which is a gap in
 * that file rather than a decision; it is not widened here because that set is
 * shared with the booking and room-move paths and changing their behaviour is
 * not part of this change.
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  /** serialization_failure */
  '40001',
  /** deadlock_detected — Postgres aborted one side; re-running is the remedy */
  '40P01',
]);

/**
 * How many times the whole transaction may run.
 *
 * Three, matching `RoomMoveService`'s `MAX_ATTEMPTS`. This budget covers only
 * the two `TRANSIENT_SQLSTATES`, and both of those fail fast — Postgres has
 * already aborted the transaction rather than waiting — so three attempts cost
 * milliseconds, not seconds. `55P03` is deliberately outside this budget,
 * because it is reached by *waiting* `ROW_LOCK_TIMEOUT_MS`.
 */
export const CANCEL_MAX_ATTEMPTS = 3;

/** Jittered, short, and bounded. Same shape as `RoomMoveService.withRetry`. */
export function cancelBackoffMs(attempt: number): number {
  return 25 * attempt + Math.random() * 50;
}

/**
 * True only for a conflict Postgres has already rolled back.
 *
 * Note this returns false for `P2028`: `sqlState()` deliberately refuses
 * Prisma's own `P####` codes, so a transaction timeout cannot leak into the
 * retry path through here.
 */
export function isTransientCancelConflict(error: unknown): boolean {
  const state = sqlState(error);
  return state !== null && TRANSIENT_SQLSTATES.has(state);
}

/**
 * A transaction that ran out of time.
 *
 * With `lock_timeout` set, a blocked row lock now surfaces as `55P03` well
 * before this can fire, so `P2028` is left as the backstop for a transaction
 * that ran long for some other reason — a slow statement, a stalled
 * connection. Not retried either: each attempt would cost the full
 * transaction deadline to report what the first one knew.
 */
export function isTransactionTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PrismaErrorCode.TRANSACTION_TIMEOUT
  );
}
