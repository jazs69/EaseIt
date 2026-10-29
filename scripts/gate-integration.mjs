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

const ALLOWED_DATABASES =
  process.env.EASEIT_TEST_DBS ?? 'easeit_racetest,easeit_recovery,easeit_ci';
const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4100/api/v1';

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
