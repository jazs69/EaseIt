/**
 * Layer B — integration, on a disposable database only.
 *
 * ===========================================================================
 * The preflight is not optional, and it runs first for a reason.
 *
 * The suites below create reservations, cancel them, move rooms and decrement
 * inventory counters. Three of them (`cancel-reservation`, `check-in`,
 * `parallel-booking`) read `DATABASE_URL` and assert nothing about where it
 * points, so with an unset environment they would mutate the shared
 * development database. `scripts/require-services.mjs` refuses unless the
 * environment names a database from an explicit allowlist and the live
 * connection agrees — so a missing or wrong environment is a hard failure
 * here, never a quiet fallback.
 *
 * `parallel-booking` is deliberately NOT in this layer. It mutates shared
 * inventory fixtures rather than suite-owned ones, which is safe on a
 * disposable database but makes it a poor fit for a routine gate; it lives in
 * `gate:resilience`, which is explicitly pre-release.
 * ===========================================================================
 *
 * Required environment:
 *   DATABASE_URL     a disposable database (default allowlist below)
 *   EASEIT_API_URL   an API running against THAT SAME database
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  classifyTarget,
  DEFAULT_ALLOWLIST,
  developmentDatabaseNames,
} from '../test/support/isolation-guard.mjs';

/**
 * One allowlist, shared with the isolation guard.
 *
 * This used to default to `easeit_racetest,easeit_recovery,easeit_ci` --
 * missing `easeit_test`, which the guard allows -- so the gate refused a
 * database the suites accept and the way through was to remember
 * `EASEIT_TEST_DBS`. Two lists disagreeing about which database is safe is a
 * trap. `EASEIT_TEST_DBS` still *adds* names for a disposable database this
 * repository has not heard of; it can never add a shared one, because
 * `classifyTarget` refuses any name it finds in a developer's `.env`.
 */
const ALLOWED_DATABASES = process.env.EASEIT_TEST_DBS ?? DEFAULT_ALLOWLIST.join(',');

/**
 * Both targets are resolved HERE and exported, so the children get exactly
 * what was validated.
 *
 * ===========================================================================
 * The bug this closes would have turned every CI run red.
 *
 * The comment further down says the suites inherit `DATABASE_URL` and
 * `EASEIT_API_URL` from this process. That was never true of either: the API
 * default was applied here and nowhere else, and the database was only ever
 * read by each suite separately, out of `packages/database/.env`. CI writes
 * that file and sets neither variable, so once the payment suite stopped
 * reading `.env` -- which it must, because that file names the **shared
 * development database** -- it would have failed on every pull request while
 * its five neighbours passed.
 *
 * So the resolution happens once, is validated against the allowlist before a
 * single suite runs, and is written back into `process.env` so `spawnSync`
 * hands it down. The suites keep their own post-connection identity check:
 * this decides what to ask for, `assertIsolatedDatabase` decides whether the
 * live connection is really that.
 * ===========================================================================
 */
function fromEnvFile(key) {
  for (const relative of ['../packages/database/.env', '../.env', '../apps/api/.env']) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
      const match = new RegExp(`^${key}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'm').exec(text);
      if (match?.[1]) return match[1];
    } catch {
      // A missing file here is ordinary, not an error.
    }
  }
  return null;
}

const DATABASE_URL = process.env.DATABASE_URL ?? fromEnvFile('DATABASE_URL') ?? '';
const verdict = classifyTarget({
  url: DATABASE_URL,
  allowExtra: process.env.EASEIT_TEST_DBS ?? '',
  /**
   * The same discovery the suites do, so the gate reaches the same verdict.
   *
   * An empty set here skipped the "that is this checkout's working database"
   * tier, which left the gate fractionally looser than every suite it starts
   * -- it would begin a run the first suite then refused. Discovery is safe in
   * CI: the workflow writes `packages/database/.env` pointing at `easeit_ci`,
   * and that tier deliberately ignores built-in test names, which is the
   * precedence rule recorded in `classifyTarget`.
   */
  developmentNames: developmentDatabaseNames(),
});

if (!verdict.ok) {
  console.error('\nGATE FAILED: the database target is not usable.\n');
  for (const reason of verdict.reasons) console.error(`  ${reason}`);
  console.error(
    '\nSet DATABASE_URL to a disposable test database, for example:\n' +
      '  DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/easeit_test?schema=public"\n',
  );
  process.exit(1);
}

process.env.DATABASE_URL = DATABASE_URL;

const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4100/api/v1';
process.env.EASEIT_API_URL = API;

const suites = [
  {
    name: 'outbox (PostgreSQL only)',
    script: 'test/integration/outbox.test.mjs',
    why: 'enqueue, dedupe, claim, lease, retry, dead letter, constraints',
  },
  {
    name: 'outbox claim race',
    script: 'test/concurrency/outbox-claim.test.mjs',
    why: 'N dispatchers racing one batch; concurrent reapers',
  },
  {
    name: 'check-in',
    script: 'test/integration/check-in.test.mjs',
    why: 'check-in state machine and room assignment',
  },
  {
    name: 'folio payment idempotency',
    script: 'test/integration/folio-payment.test.mjs',
    why: 'one payment per key, concurrent same-key POSTs, by-key reconciliation read',
  },
  {
    name: 'cancellation + concurrency',
    script: 'test/integration/cancel-reservation.test.mjs',
    why: 'release-once, lock timeouts, cancel vs check-in, cancel vs move, stale assignment',
  },
  {
    name: 'creation races',
    script: 'test/integration/create-race.test.mjs',
    why: 'create vs cancel, create vs cross-category move, three-way',
  },
];

console.log('════ release gate (integration) ════');
console.log(`  allowlist : ${ALLOWED_DATABASES}`);
console.log(`  api       : ${API}\n`);

/* ------------------------------------------------------------- preflight -- */

const preflight = spawnSync(
  process.execPath,
  ['scripts/require-services.mjs', `--db=${ALLOWED_DATABASES}`, `--api=${API}`],
  { stdio: 'inherit' },
);

if (preflight.error || preflight.status !== 0) {
  console.error('\nGATE FAILED: prerequisites not met. No suite was run and nothing was changed.');
  process.exit(1);
}

/* ---------------------------------------------------------------- suites -- */

const results = [];
let failed = null;

for (const suite of suites) {
  console.log(`\n──── ${suite.name} ────`);
  console.log(`     ${suite.why}`);
  const started = Date.now();

  // The suites inherit DATABASE_URL and EASEIT_API_URL from this process, so
  // they run against exactly what the preflight just verified.
  const run = spawnSync(process.execPath, [suite.script], { stdio: 'inherit' });
  const ms = Date.now() - started;

  if (run.error) {
    results.push({ name: suite.name, status: `could not run (${run.error.code})`, ms });
    failed = { ...suite, detail: String(run.error.message) };
    break;
  }

  const ok = run.status === 0 && run.signal === null;
  results.push({
    name: suite.name,
    status: ok ? 'pass' : `FAIL (exit ${String(run.status ?? run.signal)})`,
    ms,
  });

  if (!ok) {
    failed = { ...suite, detail: `exit ${String(run.status ?? run.signal)}` };
    break;
  }
}

console.log('\n════ integration summary ════');
for (const result of results) {
  console.log(
    `  ${result.status === 'pass' ? 'PASS' : 'FAIL'}  ${result.name} ${String(result.ms)}ms`,
  );
}

if (failed !== null) {
  console.error(`\nGATE FAILED at "${failed.name}" — ${failed.detail}.`);
  console.error("Fixtures are cleaned up by each suite's own teardown, including on failure;");
  console.error('check its output for a CLEANUP line before re-running.');
  process.exit(1);
}

console.log(`\nIntegration gate passed (${String(results.length)} suite(s)).`);
console.log('Not covered here: Redis/BullMQ recovery, backup/restore, shared-fixture stress.');
console.log('  pnpm gate:resilience');
