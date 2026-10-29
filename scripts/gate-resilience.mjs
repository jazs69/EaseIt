/**
 * Layer C — resilience. Pre-release and scheduled, not per-PR.
 *
 * ===========================================================================
 * What is here, and what is honestly still missing.
 *
 * Present: the Redis/BullMQ end-to-end suite — drain, retry-to-success, a
 * worker killed mid-handler, a budget exhausted into DEAD, **total queue loss
 * via `obliterate` with the work rediscovered from PostgreSQL**, a job
 * replayed against a finished row, real concurrency, and shutdown mid-flight.
 * Plus `parallel-booking`, which belongs in this layer rather than Layer B
 * because it mutates shared inventory fixtures instead of suite-owned ones.
 *
 * Missing, and not pretended otherwise:
 *
 *   * **Backup/restore has no suite.** `pg_dump`/`pg_restore` are available
 *     and the procedure is documented in TESTING.md, but it is a manual
 *     checklist, not an automated check. This is the largest remaining gap.
 *   * **The SIGTERM path is not exercised on Windows**, which has no
 *     deliverable SIGTERM — `Stop-Process` and `process.kill` are hard kills.
 *     The outbox suite drives what the handler *calls* (`onModuleDestroy` in
 *     Nest's order) and proves no row is left stuck, but graceful-versus-forced
 *     is only fully separable on Linux or in a container.
 *   * **No business handler exists.** `OutboxEventType` has exactly one value,
 *     `OUTBOX_SELF_TEST`, whose handler touches nothing outside the outbox
 *     tables, so "no duplicated business side effect" is unobservable today;
 *     only row-level idempotency is.
 *
 * Why the Redis instance must not be 6379: `OutboxQueue` sets no BullMQ
 * `prefix`, so every process on one Redis shares `bull:outbox:*`, and the
 * suite calls `obliterate({ force: true })`. On the shared instance that
 * destroys real queue state. The preflight refuses port 6379 for that reason.
 * ===========================================================================
 */

import { spawnSync } from 'node:child_process';

const ALLOWED_DATABASES =
  process.env.EASEIT_TEST_DBS ?? 'easeit_racetest,easeit_recovery,easeit_ci';
const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4100/api/v1';
const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

const includeStress = !process.argv.includes('--no-stress');

const suites = [
  {
    name: 'outbox end-to-end (BullMQ)',
    script: 'test/integration/outbox-redis.test.mjs',
    why: 'queue loss, worker death, lease recovery, bounded retries, DEAD, shutdown mid-flight',
    needsRedis: true,
  },
  {
    name: 'parallel booking stress',
    script: 'test/concurrency/parallel-booking.test.mjs',
    why: 'N parallel requests for the last room; exactly one succeeds',
    // Mutates SHARED inventory fixtures, not suite-owned rows. Safe only
    // because the preflight has pinned us to a disposable database.
    mutatesSharedFixtures: true,
    optional: !includeStress,
  },
];

console.log('════ release gate (resilience) ════');
console.log(`  allowlist : ${ALLOWED_DATABASES}`);
console.log(`  api       : ${API}`);
console.log(`  redis     : ${REDIS.replace(/\/\/[^@]*@/, '//')}\n`);

const preflight = spawnSync(
  process.execPath,
  ['scripts/require-services.mjs', `--db=${ALLOWED_DATABASES}`, `--api=${API}`, `--redis=${REDIS}`],
  { stdio: 'inherit' },
);

if (preflight.error || preflight.status !== 0) {
  console.error('\nGATE FAILED: prerequisites not met. No suite was run and nothing was changed.');
  process.exit(1);
}

const results = [];
let failed = null;

for (const suite of suites) {
  if (suite.optional) {
    results.push({ name: suite.name, status: 'skipped (--no-stress)' });
    continue;
  }

  console.log(`\n──── ${suite.name} ────`);
  console.log(`     ${suite.why}`);
  if (suite.mutatesSharedFixtures) {
    console.log('     NOTE: mutates shared inventory fixtures — disposable database only.');
  }

  const started = Date.now();
  const run = spawnSync(process.execPath, [suite.script], {
    stdio: 'inherit',
    env: { ...process.env, REDIS_URL: REDIS },
  });
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

console.log('\n════ resilience summary ════');
for (const result of results) {
  const time = result.ms === undefined ? '' : ` ${String(result.ms)}ms`;
  const tag =
    result.status === 'pass' ? 'PASS' : result.status.startsWith('skipped') ? 'SKIP' : 'FAIL';
  console.log(`  ${tag}  ${result.name}${time}`);
}

if (failed !== null) {
  console.error(`\nGATE FAILED at "${failed.name}" — ${failed.detail}.`);
  process.exit(1);
}

console.log('\nResilience gate passed.');
console.log('Still manual (see TESTING.md): PostgreSQL backup/restore verification.');
console.log('Still untestable on Windows: the real SIGTERM graceful-shutdown path.');
