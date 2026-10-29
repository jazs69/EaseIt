/**
 * The fast local release gate.
 *
 * ===========================================================================
 * The problem this replaces.
 *
 * `pnpm test` exits **0 having run nothing**. Turbo plans eight `test` tasks,
 * one per workspace package, and every one resolves to `<NONEXISTENT>` because
 * no package defines a `test` script — there is no vitest in this repository
 * and no `*.test.ts` anywhere, despite CLAUDE.md section 4 advertising both.
 * Turbo treats a missing script as nothing to do, not as an error, so the
 * command is a green light wired to no sensor. Verified:
 *
 *   pnpm exec turbo run test --dry=json   →  8 test tasks, all <NONEXISTENT>
 *   pnpm test                             →  "3 successful" (builds), exit 0
 *
 * This runner is the honest version: a fixed list of checks that each really
 * execute, run in order, stopping at the first failure, with a summary and a
 * non-zero exit. Nothing here needs PostgreSQL, Redis, SMTP or a running API,
 * so it is safe to run anywhere, any time.
 * ===========================================================================
 *
 * Usage:  node scripts/gate.mjs [--no-format]
 */

import { spawnSync } from 'node:child_process';

const skipFormat = process.argv.includes('--no-format');

/**
 * Checks, in the order a developer wants them to fail.
 *
 * Cheapest and most mechanical first: whitespace, then types, then lint, then
 * the only test suite that needs no services. A typecheck failure is more
 * informative than a lint failure on the same broken code, so types come
 * first.
 */
const checks = [
  {
    name: 'whitespace',
    // Catches trailing whitespace and conflict markers in what is staged or
    // changed. Repo-wide Prettier is deliberately NOT here — see `format`.
    command: 'git',
    args: ['diff', '--check', 'HEAD'],
    why: 'trailing whitespace or a conflict marker in the working tree',
  },
  {
    name: 'format',
    // Scoped to CHANGED files on purpose. `pnpm format:check` across the repo
    // reports style issues in 153 files that predate this gate; making that
    // blocking would either fail every run or require reformatting the whole
    // repository, which is a separate decision and a huge diff. Checking what
    // you touched keeps new code clean without rewriting history.
    command: process.execPath,
    args: ['scripts/format-changed.mjs'],
    why: 'a file you changed is not Prettier-clean (run `pnpm format` on it)',
    optional: skipFormat,
  },
  {
    name: 'typecheck',
    shellCommand: 'pnpm typecheck',
    why: 'TypeScript errors',
  },
  {
    name: 'lint',
    shellCommand: 'pnpm lint',
    why: 'ESLint errors',
  },
  {
    name: 'unit tests (guards, no services)',
    // The safety logic itself: changed-file detection and the database
    // isolation guard. Pure functions with injected git/file access, so this
    // needs no PostgreSQL, Redis, Docker or API.
    command: process.execPath,
    args: ['test/unit/gate-guards.test.mjs'],
    why: 'the gate/guard unit suite failed',
  },
  {
    name: 'unit tests (retry classifier)',
    // The one suite that contacts nothing: it imports the compiled retry
    // classifier and the shared SQLSTATE policy and asserts on them. It needs
    // DATABASE_URL to be *present* (the import chain builds a Prisma client,
    // which does not connect) but never opens a connection.
    command: process.execPath,
    args: ['test/integration/cancel-retry.test.mjs'],
    why: 'the service-free unit suite failed',
  },
];

const results = [];
let failed = null;

for (const check of checks) {
  if (check.optional) {
    results.push({ name: check.name, status: 'skipped (--no-format)' });
    continue;
  }

  process.stdout.write(`\n──── ${check.name} ────\n`);
  const started = Date.now();
  /**
   * Two spawn shapes, because `pnpm` has to go through a shell on Windows.
   *
   * Node 24 refuses to spawn a `.cmd` directly (EINVAL) and on Windows `pnpm`
   * *is* `pnpm.cmd`. A shell is therefore unavoidable for those two checks —
   * but the command is passed as ONE string rather than a command plus an args
   * array, because the array form under `shell: true` is deprecated (DEP0190)
   * precisely for the injection risk it invites. Both strings are fixed
   * literals defined above; nothing from the environment reaches a shell.
   *
   * Everything else runs under this same Node with `shell: false`, so there is
   * nothing to quote and nothing to escape.
   */
  const run =
    check.shellCommand === undefined
      ? spawnSync(check.command, check.args, {
          stdio: 'inherit',
          shell: false,
          cwd: process.cwd(),
        })
      : spawnSync(check.shellCommand, {
          stdio: 'inherit',
          shell: true,
          cwd: process.cwd(),
        });
  const ms = Date.now() - started;

  // A spawn that could not start at all is a gate failure, not a pass. Without
  // this an absent `pnpm` on PATH would read as success.
  if (run.error) {
    results.push({ name: check.name, status: `could not run (${run.error.code})`, ms });
    failed = { ...check, detail: String(run.error.message) };
    break;
  }

  // Signals do not set a numeric status; treat anything non-zero-or-signalled
  // as failure rather than assuming 0.
  const ok = run.status === 0 && run.signal === null;
  results.push({
    name: check.name,
    status: ok ? 'pass' : `FAIL (exit ${String(run.status ?? run.signal)})`,
    ms,
  });

  if (!ok) {
    failed = { ...check, detail: `exit ${String(run.status ?? run.signal)}` };
    break;
  }
}

/* -------------------------------------------------------------------------- */

console.log('\n════ release gate (fast) ════');
for (const result of results) {
  const time = result.ms === undefined ? '' : ` ${String(result.ms)}ms`;
  console.log(
    `  ${result.status === 'pass' ? 'PASS' : result.status.startsWith('skipped') ? 'SKIP' : 'FAIL'}  ${result.name}${time}`,
  );
}

if (failed !== null) {
  console.error(`\nGATE FAILED at "${failed.name}": ${failed.why}.`);
  console.error(`  ${failed.detail}`);
  console.error('\nThis gate covers no integration behaviour. Even when it passes, run');
  console.error('`pnpm gate:integration` against an isolated database before a release.');
  process.exit(1);
}

const remaining = checks.length - results.filter((r) => r.status === 'pass').length;
console.log(
  `\nFast gate passed${remaining > 0 ? ` (${String(remaining)} check(s) skipped)` : ''}.`,
);
console.log('It proves nothing about concurrency, inventory or recovery:');
console.log('  pnpm gate:integration   — needs an isolated database + API');
console.log('  pnpm gate:resilience    — needs an isolated database + API + Redis');
