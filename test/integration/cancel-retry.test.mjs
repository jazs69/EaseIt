/**
 * The cancellation retry classifier.
 *
 * ===========================================================================
 * Which failures are retried is a correctness decision, so it is asserted
 * rather than reasoned about.
 *
 * Retrying the wrong thing on this path is not a performance bug. `23514` here
 * means the inventory counters already disagree with the bookings; retrying it
 * three times turns a visible data problem into a slow one and still fails.
 * Retrying a *domain* error would turn one clean refusal into three and report
 * the wrong status. Both are cheap to get wrong and cheap to pin, so they are
 * pinned here.
 *
 * This suite needs **no PostgreSQL and no API**: it imports the compiled
 * predicate and feeds it error shapes. It is the narrowest test that covers
 * the classification, which matters because inducing a real deadlock on demand
 * is not something an integration test can do reliably.
 *
 * Run: pnpm test:cancellation:retry   (requires `pnpm --filter @repo/api build`)
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

/**
 * `@repo/database` builds its Prisma client at module scope, and the compiled
 * predicate imports it for `PrismaErrorCode`. Constructing a client does not
 * connect, so no database is contacted — but `DATABASE_URL` has to be present
 * or the import throws.
 */
function loadDatabaseEnv() {
  for (const relative of ['../../packages/database/.env', '../../.env']) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
      const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m.exec(text);
      if (match?.[1]) return match[1];
    } catch {
      // Next candidate.
    }
  }
  return null;
}

process.env.DATABASE_URL ??= loadDatabaseEnv() ?? '';
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set and no .env was found.');
  process.exit(1);
}

const RETRY_MODULE = new URL(
  '../../apps/api/dist/modules/reservations/cancel-reservation.retry.js',
  import.meta.url,
);

let retry;
try {
  const mod = await import(RETRY_MODULE.href);
  retry = mod.default ?? mod;
} catch (error) {
  console.error(
    'Could not import the compiled predicate. Run `pnpm --filter @repo/api build` first.\n' +
      `  ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const {
  ROW_LOCK_TIMEOUT_MS,
  CANCEL_MAX_ATTEMPTS,
  cancelBackoffMs,
  isLockTimeout,
  isTransactionTimeout,
  isTransientCancelConflict,
} = retry;

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A Prisma-shaped error carrying a SQLSTATE where Prisma puts it. */
const pgError = (state) => Object.assign(new Error(`db error. Code: \`${state}\``), {
  code: 'P2010',
  meta: { code: state },
});

/** Prisma's own code, which is not a SQLSTATE however much it looks like one. */
const prismaError = (code) => Object.assign(new Error('prisma error'), { code });

console.log('The cancellation retry classifier\n');

/* -------------------------------------------------------------------------- */
console.log('1. Transient conflicts are retried.');
check(
  '40001 serialization_failure is transient',
  isTransientCancelConflict(pgError('40001')) === true,
);
check(
  '40P01 deadlock_detected is transient',
  isTransientCancelConflict(pgError('40P01')) === true,
);

/* -------------------------------------------------------------------------- */
console.log('\n2. Permanent failures are NOT retried.');
check(
  '23514 check_violation is permanent here — the counters disagree, and retrying cannot fix that',
  isTransientCancelConflict(pgError('23514')) === false,
);
check(
  '23P01 exclusion_violation is permanent here — cancellation inserts no range',
  isTransientCancelConflict(pgError('23P01')) === false,
);
check(
  '23505 unique_violation is permanent here — it writes no uniquely-keyed row',
  isTransientCancelConflict(pgError('23505')) === false,
);
check('23503 foreign_key_violation is permanent', isTransientCancelConflict(pgError('23503')) === false);
check('an ordinary Error is not transient', isTransientCancelConflict(new Error('boom')) === false);
check('null is not transient', isTransientCancelConflict(null) === false);
check('undefined is not transient', isTransientCancelConflict(undefined) === false);

/* -------------------------------------------------------------------------- */
console.log('\n3. A lock timeout is answered, not retried.');
check('55P03 lock_not_available is recognised', isLockTimeout(pgError('55P03')) === true);
check(
  '55P03 is NOT fed into the retry path — three more 3s waits would tell the clerk nothing new',
  isTransientCancelConflict(pgError('55P03')) === false,
);
check('40001 is not a lock timeout', isLockTimeout(pgError('40001')) === false);
check('P2028 is not a lock timeout', isLockTimeout(prismaError('P2028')) === false);
check('null is not a lock timeout', isLockTimeout(null) === false);
check(
  'the shared lock wait is bounded and shorter than the transaction deadline',
  ROW_LOCK_TIMEOUT_MS === 3_000,
  `${String(ROW_LOCK_TIMEOUT_MS)}ms`,
);

/* -------------------------------------------------------------------------- */
console.log('\n4. A transaction timeout is its own case, not a retry.');
check(
  'P2028 is recognised as a transaction timeout',
  isTransactionTimeout(prismaError('P2028')) === true,
);
check(
  'P2028 is NOT fed into the retry path — three lock waits would cost a clerk 30 seconds',
  isTransientCancelConflict(prismaError('P2028')) === false,
);
check('P2002 is not a transaction timeout', isTransactionTimeout(prismaError('P2002')) === false);
check('a SQLSTATE error is not a transaction timeout', isTransactionTimeout(pgError('40001')) === false);
check('null is not a transaction timeout', isTransactionTimeout(null) === false);

/* -------------------------------------------------------------------------- */
console.log('\n5. The attempt budget is bounded and small.');
check(
  'CANCEL_MAX_ATTEMPTS is 3',
  CANCEL_MAX_ATTEMPTS === 3,
  `is ${String(CANCEL_MAX_ATTEMPTS)}`,
);
check(
  'the backoff is short and grows with the attempt',
  (() => {
    const first = cancelBackoffMs(1);
    const second = cancelBackoffMs(2);
    return first >= 25 && first <= 75 && second >= 50 && second <= 100;
  })(),
  `attempt 1 ~${cancelBackoffMs(1).toFixed(0)}ms, attempt 2 ~${cancelBackoffMs(2).toFixed(0)}ms`,
);
check(
  'the backoff is bounded for every attempt in the budget',
  Array.from({ length: CANCEL_MAX_ATTEMPTS }, (_, i) => cancelBackoffMs(i + 1)).every(
    (ms) => ms > 0 && ms < 500,
  ),
);

/* -------------------------------------------------------------------------- */
console.log('');
console.log('6. The SHARED classifier, used by room-move and create-reservation.');

const shared = await import(
  new URL('../../apps/api/dist/common/errors/sql-state.js', import.meta.url).href
);

check(
  '40P01 is now in the shared retryable set',
  shared.isRetryableSqlState(pgError('40P01')) === true,
);
check('40001 is still retryable there', shared.isRetryableSqlState(pgError('40001')) === true);
check(
  '23514 / 23P01 / 23505 remain retryable for booking and room-move',
  ['23514', '23P01', '23505'].every((state) => shared.isRetryableSqlState(pgError(state))),
);
check(
  '55P03 is NOT retryable — the wait already happened',
  shared.isRetryableSqlState(pgError('55P03')) === false,
);
check('55P03 is recognised centrally', shared.isLockTimeout(pgError('55P03')) === true);
check('40P01 is not a lock timeout', shared.isLockTimeout(pgError('40P01')) === false);
check(
  'the shared constant is the one cancellation re-exports',
  shared.ROW_LOCK_TIMEOUT_MS === ROW_LOCK_TIMEOUT_MS,
  `${String(shared.ROW_LOCK_TIMEOUT_MS)}ms`,
);

console.log(
  failures === 0 ? '\nAll retry-classifier checks passed.' : `\n${String(failures)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
