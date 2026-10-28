/**
 * The Postgres SQLSTATE behind a Prisma error.
 *
 * ===========================================================================
 * Shared, because copying it has now reintroduced the same bug twice.
 *
 * Every write path that relies on a database constraint needs this: without
 * the SQLSTATE a retryable collision escapes as a raw 500 instead of a clean
 * `RoomUnavailableError`, which is both a worse answer for a clerk and a leak
 * of internals (CLAUDE.md section 5).
 *
 * **The trap, written down so the next copy does not fall into it.** Prisma's
 * own error codes look exactly like SQLSTATEs: `P2010` is five characters of
 * `[0-9A-Z]`, so a naive `/^[0-9A-Z]{5}$/` on `error.code` returns `P2010`,
 * decides it is not retryable, and never reads the message where the real
 * `23P01` is sitting. That is precisely how an exclusion-constraint violation
 * on a room move surfaced as a 500 while the constraint itself worked
 * perfectly.
 *
 * Prisma surfaces the state in three places depending on how the query was
 * issued, so all three are checked, in order of reliability.
 * ===========================================================================
 */

/** Postgres SQLSTATEs that mean "try again", not "give up". */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  /** serialization_failure */
  '40001',
  /** check_violation — the oversell CHECK (section 3.1) */
  '23514',
  /** exclusion_violation — the room overlap constraint (section 3.1) */
  '23P01',
  /** unique_violation — a booking code or a double post */
  '23505',
  /**
   * deadlock_detected.
   *
   * Postgres picked one transaction as the victim and rolled it back whole, so
   * a retry starts from a clean slate and the documented remedy is to run it
   * again. It was missing here while `40001` was present, which is a gap
   * rather than a decision: the two arrive by different routes and are equally
   * transient.
   */
  '40P01',
]);

/**
 * lock_not_available.
 *
 * Only ever raised because a transaction set `lock_timeout` on itself, so it
 * is kept OUT of `RETRYABLE_SQLSTATES`: the wait already happened, and three
 * more of them would cost the caller the same answer three times over. Each
 * path maps it to a typed conflict instead — see `isLockTimeout`.
 */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * How long a transaction waits for a contended row before giving up.
 *
 * Shared by cancellation, room-move and check-in, because they take the same
 * reservation row and a caller should not get a different answer depending on
 * which of them they happened to call.
 *
 * Postgres' own `lock_timeout` is unset on this cluster and Prisma's
 * `$transaction({ timeout })` cannot help: it is a deadline Prisma enforces
 * when it next gets control, and it cannot interrupt a `SELECT … FOR UPDATE`
 * already blocked inside Postgres. A measured contended cancellation waited
 * **39,969 ms** against a 10,000 ms transaction timeout for exactly that
 * reason.
 *
 * Three seconds: long enough that an ordinary overlapping cancel, move or
 * check-in (all of which commit in milliseconds) still wins the row rather
 * than being refused, and short enough that a clerk gets a definite answer
 * and can press the button again instead of watching a spinner. It is set
 * transaction-locally, so nothing outside the transaction changes behaviour.
 */
export const ROW_LOCK_TIMEOUT_MS = 3_000;

export function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
  };

  if (typeof candidate.code === 'string') {
    // A real SQLSTATE, and not one of Prisma's `P####` codes wearing the same
    // shape. See the note above — this guard is the whole point of the file.
    if (/^[0-9A-Z]{5}$/.test(candidate.code) && !/^P\d{4}$/.test(candidate.code)) {
      return candidate.code;
    }
    // Prisma reports a unique violation as its own code and drops the state.
    if (candidate.code === 'P2002') return '23505';
  }

  if (typeof candidate.meta?.code === 'string') return candidate.meta.code;

  if (typeof candidate.message === 'string') {
    return /Code:\s*`?([0-9A-Z]{5})`?/.exec(candidate.message)?.[1] ?? null;
  }

  return null;
}

/** Whether this error is worth another attempt. */
export function isRetryableSqlState(error: unknown): boolean {
  const state = sqlState(error);
  return state !== null && RETRYABLE_SQLSTATES.has(state);
}

/**
 * Whether the transaction gave up waiting for a row lock.
 *
 * Central, so the three paths that set `ROW_LOCK_TIMEOUT_MS` translate the
 * resulting SQLSTATE identically rather than each carrying its own copy of
 * the string.
 */
export function isLockTimeout(error: unknown): boolean {
  return sqlState(error) === LOCK_NOT_AVAILABLE;
}
