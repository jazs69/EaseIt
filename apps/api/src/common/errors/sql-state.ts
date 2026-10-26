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
]);

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
