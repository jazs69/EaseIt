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
import { readFileSync } from 'node:fs';

import { resolveSuiteSelection } from './lib/suite-selection.mjs';
import {
  classifyDisposableTarget,
  developmentDatabaseNames,
  redisRefusal,
  WHOLLY_DISPOSABLE,
} from '../test/support/isolation-guard.mjs';

/**
 * The narrower policy, imported rather than hand-copied.
 *
 * ===========================================================================
 * This list used to be a string literal here, and it was right -- but only by
 * coincidence, and only on this path.
 *
 * Both suites below damage more than their own fixtures: `parallel-booking`
 * rewrites `inventory_day` counters and tells you to run `pnpm db:seed`
 * afterwards, and the Redis suite calls `obliterate({ force: true })`. So
 * `easeit_test` is excluded deliberately -- it is the long-lived seeded
 * database every Layer B suite reads, and a reseed is the only way back.
 *
 * The literal is gone for two reasons. It would have drifted from
 * `DEFAULT_ALLOWLIST` with nothing to notice, and -- the real hole -- it only
 * ever guarded *this* entry point. Running either suite by its own command
 * went through `assertIsolatedDatabase`, which accepts `easeit_test`. Both
 * suites now pass `disposableOnly: true`, so the refusal holds whichever way
 * they are started, and this list and theirs are the same list.
 * ===========================================================================
 */
const ALLOWED_DATABASES = process.env.EASEIT_TEST_DBS ?? WHOLLY_DISPOSABLE.join(',');
const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4100/api/v1';
const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

const includeStress = !process.argv.includes('--no-stress');

const suites = [
  {
    id: 'outbox-redis',
    name: 'outbox end-to-end (BullMQ)',
    script: 'test/integration/outbox-redis.test.mjs',
    why: 'queue loss, worker death, lease recovery, bounded retries, DEAD, shutdown mid-flight',
    needsRedis: true,
  },
  {
    id: 'parallel-booking',
    name: 'parallel booking stress',
    script: 'test/concurrency/parallel-booking.test.mjs',
    why: 'N parallel requests for the last room; exactly one succeeds',
    // Mutates SHARED inventory fixtures, not suite-owned rows. Safe only
    // because the preflight has pinned us to a disposable database.
    mutatesSharedFixtures: true,
    needsApi: true,
    optional: !includeStress,
  },
];

/**
 * `--only=<id>`, so the documented per-suite commands go THROUGH this gate.
 *
 * ===========================================================================
 * `pnpm test:concurrency` and `pnpm test:outbox:redis` used to be
 * `node <suite>` and nothing else: no preflight, no allowlist, no exported
 * target. The destructive suite that rewrites shared inventory counters and
 * the one that calls `obliterate` were the two easiest things in this
 * repository to point at a developer's own database. They select a suite here
 * instead.
 *
 * An explicit selection also overrides `optional`: `--no-stress` means "I did
 * not ask for the slow one", not "refuse to run the one I just named".
 *
 * An unrecognised id exits 2 rather than silently running nothing, because a
 * gate that runs no suites and reports success is the failure mode this whole
 * layer exists to prevent.
 *
 * The parsing itself lives in `scripts/lib/suite-selection.mjs`, which the
 * unit suite imports and runs. It was inline here, and inline it could only
 * be checked by searching this file for substrings -- and a substring search
 * cannot tell a working parser from a comment quoting one.
 *
 * What matters at THIS call site is the position: it runs before
 * `fromEnvFile`, before development-name discovery reads anything, before the
 * database is classified, and before any spawn, so a malformed invocation
 * touches no file and starts no process.
 * ===========================================================================
 */
const selection = resolveSuiteSelection({
  argv: process.argv.slice(2),
  ids: suites.map((suite) => suite.id),
});

if (!selection.ok) {
  console.error('');
  for (const reason of selection.reasons) console.error(reason);
  process.exit(selection.exitCode);
}

const only = selection.only;

const selected =
  only === null
    ? suites
    : suites.filter((suite) => suite.id === only).map((suite) => ({ ...suite, optional: false }));

/** What will actually run, which is what decides the prerequisites. */
const running = selected.filter((suite) => suite.optional !== true);
const needsRedis = running.some((suite) => suite.needsRedis === true);
const needsApi = running.some((suite) => suite.needsApi === true);

/**
 * The database target is resolved, validated and exported HERE.
 *
 * ===========================================================================
 * H-1: this gate used to hand its children `REDIS_URL` and nothing else.
 *
 * It validated an allowlist of *names*, passed that to the preflight, and then
 * spawned each suite with `env: { ...process.env, REDIS_URL }`. So the
 * database this gate approved was not the database the suite used: each suite
 * re-derived its own target from `packages/database/.env`, which on a
 * developer's machine names the shared development database. The release path
 * worked only because those two suites still carried that fallback -- neither
 * `release.yml` nor this file supplied `DATABASE_URL` -- and that fallback is
 * exactly what makes a direct run dangerous.
 *
 * So resolution happens once, here, in the same deterministic env-file order
 * `gate-integration.mjs` uses; it is validated before the preflight spawns,
 * let alone a suite; and it is written into `process.env` and passed
 * explicitly to every child, so what was validated is what runs. The suites
 * themselves now fail closed with no fallback at all.
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

/**
 * One call: the ordinary tiers, then narrowed to `WHOLLY_DISPOSABLE`.
 *
 * The narrowing used to be an `if` here. It is a pure, imported function now
 * so the composed decision has a real test instead of a source-substring
 * assertion -- see `classifyDisposableTarget` in the isolation guard. The
 * strict list is still that module's single exported array, and
 * `EASEIT_TEST_DBS` cannot reach it: `allowExtra` is spent inside the
 * ordinary tier.
 */
const verdict = classifyDisposableTarget({
  url: DATABASE_URL,
  // Matches `gate-integration.mjs`: an extra name may be added for a
  // disposable database this repository has not heard of, never a shared one.
  allowExtra: process.env.EASEIT_TEST_DBS ?? '',
  developmentNames: developmentDatabaseNames(),
});

if (!verdict.ok) {
  console.error('\nGATE FAILED: the database target is not usable. No suite was run.\n');
  for (const reason of verdict.reasons) console.error(`  ✖  ${reason}`);
  console.error(
    '\nSet DATABASE_URL to a wholly disposable test database, for example:\n' +
      '  DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/easeit_ci?schema=public"\n',
  );
  process.exit(1);
}

/** Redis endpoint policy before anything connects, and only when it matters. */
if (needsRedis) {
  const redisProblem = redisRefusal({ url: REDIS });
  if (redisProblem !== null) {
    console.error('\nGATE FAILED: the Redis target is not usable. No suite was run.\n');
    console.error(`  ✖  ${redisProblem}\n`);
    process.exit(1);
  }
}

if (running.length === 0) {
  console.error('\nNothing to run: every selected suite was skipped. Refusing to report success.');
  process.exit(2);
}

/**
 * Exported: what was validated, to whoever needs it, and nothing else.
 *
 * ===========================================================================
 * `EASEIT_API_URL` and `REDIS_URL` are only checked when a suite that will
 * actually run needs that service, so when it does not, there is nothing
 * validated to pass on. Previously both were written into the environment
 * regardless, which meant `--only=parallel-booking` handed its child an
 * unvetted `REDIS_URL` -- harmless today, because that suite opens no Redis
 * connection, but it made "everything the children receive was validated"
 * false as a sentence.
 *
 * So an unneeded value is REMOVED from the child environment rather than
 * passed through. A suite that does not need a service must not be able to
 * find one in its environment by accident.
 * ===========================================================================
 */
process.env.DATABASE_URL = DATABASE_URL;

const childEnv = { ...process.env, DATABASE_URL };
if (needsApi) childEnv.EASEIT_API_URL = API;
else delete childEnv.EASEIT_API_URL;
if (needsRedis) childEnv.REDIS_URL = REDIS;
else delete childEnv.REDIS_URL;

console.log('════ release gate (resilience) ════');
// The name only. A connection string carries a password.
console.log(`  database  : ${verdict.target.name}`);
// The list this gate actually applied -- not `ALLOWED_DATABASES`, which folds
// in EASEIT_TEST_DBS and is only the preflight's (looser) allowlist.
console.log(`  permitted : ${[...WHOLLY_DISPOSABLE].sort().join(', ')}`);
if (needsApi) console.log(`  api       : ${API}`);
if (needsRedis) console.log(`  redis     : ${REDIS.replace(/\/\/[^@]*@/, '//')}`);
console.log(`  suites    : ${running.map((suite) => suite.id).join(', ')}\n`);

const preflight = spawnSync(
  process.execPath,
  [
    'scripts/require-services.mjs',
    `--db=${ALLOWED_DATABASES}`,
    ...(needsApi ? [`--api=${API}`] : []),
    ...(needsRedis ? [`--redis=${REDIS}`] : []),
  ],
  { stdio: 'inherit' },
);

if (preflight.error || preflight.status !== 0) {
  console.error('\nGATE FAILED: prerequisites not met. No suite was run and nothing was changed.');
  process.exit(1);
}

const results = [];
let failed = null;

for (const suite of selected) {
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
    // Explicit, not merely inherited: built above from the validated values,
    // with anything unvalidated removed. The suites refuse to start without
    // what they need.
    env: childEnv,
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
