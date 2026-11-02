/**
 * Runs the folio payment suite against an explicitly configured test database.
 *
 * ===========================================================================
 * Why this wrapper exists: the npm script was a trap.
 *
 * `pnpm test:payment` used to be `node test/integration/folio-payment.test.mjs`
 * with no environment at all, and the suite filled the gap itself by reading
 * `packages/database/.env` -- which names the **shared development database**
 * -- and defaulting its API to `:4000`, the shared stack. A destructive suite
 * whose documented command points at live data is a trap even when something
 * downstream refuses it, because the refusal is the only thing standing
 * between a developer and real hotel records, and refusals get relaxed.
 *
 * So the resolution is explicit here and announced, and the suite itself now
 * fails closed rather than guessing (see its header). The isolation guard is
 * untouched and still runs: this decides *what to ask for*, the guard decides
 * whether the answer is allowed, and it re-checks `current_database()` after
 * connecting so a proxy cannot move the target afterwards.
 *
 * Nothing here is a credential. The URL comes from the environment, never from
 * a tracked file.
 * ===========================================================================
 */

import { spawnSync } from 'node:child_process';

import { DEFAULT_ALLOWLIST } from '../test/support/isolation-guard.mjs';

/**
 * Databases a destructive suite may be pointed at.
 *
 * Imported, not copied. A second hand-maintained list is how the gate ended
 * up refusing `easeit_test` while the guard allowed it.
 */
const ALLOWED = new Set(DEFAULT_ALLOWLIST);

/** The isolated API a developer usually wants, quoted in the refusal only. */
const EXAMPLE_API = 'http://127.0.0.1:4100/api/v1';

/** The database name a Postgres URL names, or null if it is not one. */
function databaseName(url) {
  try {
    const parsed = new URL(url);
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;
    const name = parsed.pathname.replace(/^\//, '');
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** The URL with any credentials removed, for printing. */
function redact(url) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '(unparseable)';
  }
}

function refuse(lines) {
  console.error('\nREFUSING to run the payment suite.\n');
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    '\nSet an explicit target, for example:\n' +
      '  EASEIT_TEST_DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/easeit_test?schema=public" \\\n' +
      `  EASEIT_API_URL="${EXAMPLE_API}" pnpm test:payment\n\n` +
      'The API at that URL must already be running against the SAME database.\n',
  );
  process.exit(1);
}

/**
 * `EASEIT_TEST_DATABASE_URL` first, because it says what it is.
 *
 * `DATABASE_URL` is accepted too, but only when it already names an allowed
 * test database -- that is how `gate:integration` drives this suite, and
 * rejecting it there would mean two ways to configure one thing. What is NOT
 * accepted is an unset variable quietly becoming the development database.
 */
const candidate = process.env.EASEIT_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

if (candidate.length === 0) {
  refuse([
    'Neither EASEIT_TEST_DATABASE_URL nor DATABASE_URL is set.',
    'This suite writes payments, folio lines and audit rows, so it will not',
    'guess a target and it will not read one out of a .env file.',
  ]);
}

const name = databaseName(candidate);
if (name === null) {
  refuse([`The configured URL is not a PostgreSQL URL: ${redact(candidate)}`]);
}
if (!ALLOWED.has(name)) {
  refuse([
    `"${name}" is not a disposable test database.`,
    `Allowed: ${[...ALLOWED].join(', ')}.`,
    'The shared development database can never be a target for this suite.',
  ]);
}

/**
 * The API is **required**, not defaulted.
 *
 * ===========================================================================
 * A default here was a quiet assumption that `:4100` is the isolated API. It
 * usually is, by convention -- and a convention is not a guarantee. Somebody
 * running the shared stack on that port would have had this suite post real
 * payments at it, and the only thing in the way would have been
 * `assertApiSharesDatabase` noticing afterwards.
 *
 * Making it explicit costs one environment variable and removes the
 * assumption entirely. The database/API identity check still runs inside the
 * suite, so a mismatched pair is caught even when both are stated.
 * ===========================================================================
 */
const api = process.env.EASEIT_API_URL ?? '';
if (api.length === 0) {
  refuse([
    'EASEIT_API_URL is not set.',
    'There is no default: this suite posts payments, and assuming a port is',
    'assuming which stack receives them.',
  ]);
}

console.log('════ folio payment suite ════');
console.log(`  database : ${redact(candidate)}`);
console.log(`  api      : ${api}`);
console.log('  (the isolation guard re-checks the live database after connecting)\n');

const run = spawnSync(process.execPath, ['test/integration/folio-payment.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: candidate, EASEIT_API_URL: api },
});

if (run.error) {
  console.error(`\nCould not start the suite: ${String(run.error.message)}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
