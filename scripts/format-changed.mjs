/**
 * Prettier, scoped to what changed — and only where that is fair.
 *
 * ===========================================================================
 * Two problems, not one.
 *
 * FIRST: run across the repository, `pnpm format:check` reports style issues in
 * **153 files**, all predating this gate. Making that blocking would fail every
 * run until someone reformats the repository — a large diff, and a decision for
 * the repository owner rather than a side effect of adding CI. So this checks
 * only the files the current change touches.
 *
 * SECOND, and less obvious: "files you touched" is still too wide. Editing two
 * lines of a 2,300-line file that was *already* unformatted would oblige you to
 * reformat the whole thing, burying your change in unrelated churn. That is how
 * formatting gates get disabled. It is not hypothetical: it happened while
 * building this gate, to `cancel-reservation.test.mjs`.
 *
 * So a changed file is held to the standard only when it is **new**, or when it
 * was **already clean** at the comparison point. A file that was dirty before
 * you touched it stays grandfathered, and is reported as such rather than
 * silently ignored — the backlog stays visible without blocking anyone.
 *
 * Net effect: new code must be clean, clean code must stay clean, and the
 * backlog shrinks only when someone chooses to attack it. `pnpm format:check`
 * is left exactly as it was for whoever does.
 * ===========================================================================
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveComparison, collectChanged, adjudicateZero } from './lib/changed-files.mjs';

const PRETTIER_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|css)$/;

/**
 * Prettier's own entry under this Node, never `pnpm exec prettier`.
 *
 * On Windows that resolves to `pnpm.cmd`, and Node refuses to spawn a `.cmd`
 * without a shell (EINVAL) — which is how the first version of this script
 * failed. Calling the `.cjs` bin directly needs no shell on any platform, so
 * there is nothing to quote and nothing to escape.
 */
const prettierBin = fileURLToPath(
  new URL('../node_modules/prettier/bin/prettier.cjs', import.meta.url),
);

function git(args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  if (run.status !== 0) return [];
  return run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The set of paths Prettier considers unclean, parsed from its `[warn]` lines. */
function uncleanAmong(files) {
  const run = spawnSync(
    process.execPath,
    [prettierBin, '--check', '--ignore-path', '.gitignore', ...files],
    { encoding: 'utf8' },
  );
  if (run.error) {
    console.error(`  could not run Prettier: ${String(run.error.message)}`);
    process.exit(1);
  }
  return new Set(
    `${run.stdout}\n${run.stderr}`
      .split('\n')
      .map((line) => line.replace(/\u001b\[\d+m/g, ''))
      .map((line) => /^\[warn\]\s+(.*\S)\s*$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => match[1].replace(/\\/g, '/'))
      // Prettier's trailing summary line also carries the [warn] tag.
      .filter((path) => !path.startsWith('Code style issues')),
  );
}

/* ------------------------------------------------------------- what changed */

/**
 * Resolution and the zero-candidate policy both live in
 * `lib/changed-files.mjs`, so the decision table can be unit-tested without a
 * repository — see `test/unit/gate-guards.test.mjs`. This file only supplies
 * the git access and acts on the verdict.
 */
const comparison = resolveComparison({
  env: process.env,
  resolveRef: (ref) => spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`]).status === 0,
});

if (comparison.mode === 'undetermined' || comparison.mode === 'unresolvable') {
  console.error('  FORMAT CHECK CANNOT RUN');
  console.error(`  ${comparison.reason}`);
  console.error('');
  console.error('  Refusing to report success without checking anything. In CI set');
  console.error('  GATE_BASE_REF (pull request base sha) or GATE_BEFORE_REF');
  console.error('  (github.event.before).');
  process.exit(1);
}

const { changed, untracked } = collectChanged(comparison, { git, lsFiles: git });

const rawPaths = new Set([...changed, ...untracked]);
const untrackedSet = new Set(untracked);
const candidates = [...rawPaths].filter((file) => PRETTIER_EXTENSIONS.test(file));

console.log(
  `  mode "${comparison.mode}" (${comparison.reason}): ` +
    `${String(rawPaths.size)} changed, ${String(candidates.length)} formattable`,
);

const zero = adjudicateZero({
  mode: comparison.mode,
  isCI: comparison.isCI,
  rawCount: rawPaths.size,
  candidateCount: candidates.length,
});

if (zero.verdict === 'fail') {
  console.error(`  FORMAT CHECK FAILED: ${zero.message}`);
  process.exit(1);
}
if (zero.verdict === 'pass') {
  console.log(`  ${zero.message}`);
  process.exit(0);
}

const uncleanNow = uncleanAmong(candidates);

if (uncleanNow.size === 0) {
  console.log(`  all ${String(candidates.length)} clean`);
  process.exit(0);
}

/* ---------------------------------------------------- new, or newly dirtied? */

/**
 * For each file dirty now, ask whether it was already dirty at the comparison
 * point. Its old content goes to a temp file keeping the same basename, because
 * Prettier picks its parser from the extension.
 *
 * In `all` mode there is no predecessor to compare against (initial commit or
 * force-push), so the committed state is the only reference available; a file
 * that is dirty at HEAD and dirty now is still pre-existing.
 */
const grandfatherRef =
  comparison.mode === 'base' || comparison.mode === 'before' ? comparison.ref : 'HEAD';
const temp = mkdtempSync(join(tmpdir(), 'easeit-fmt-'));
const grandfathered = [];
const mustFix = [];

try {
  for (const file of uncleanNow) {
    if (untrackedSet.has(file)) {
      mustFix.push(file); // Brand new: no excuse.
      continue;
    }

    const show = spawnSync('git', ['show', `${grandfatherRef}:${file}`], { encoding: 'utf8' });
    if (show.status !== 0) {
      mustFix.push(file); // Absent at the base, so effectively new.
      continue;
    }

    const probe = join(temp, basename(file));
    writeFileSync(probe, show.stdout, 'utf8');
    (uncleanAmong([probe]).size > 0 ? grandfathered : mustFix).push(file);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

for (const file of grandfathered) {
  console.log(`  skip  ${file} — was already unformatted before this change`);
}

if (mustFix.length === 0) {
  console.log(
    `  newly-touched files clean; ${String(grandfathered.length)} pre-existing left alone`,
  );
  process.exit(0);
}

console.error('');
console.error('  New, or Prettier-clean before you changed them:');
for (const file of mustFix) console.error(`    x  ${file}`);
console.error('');
console.error(`  Fix with:  pnpm exec prettier --write ${mustFix.join(' ')}`);
process.exit(1);
