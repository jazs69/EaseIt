/**
 * Which files a change touched — decided explicitly, and fail-closed in CI.
 *
 * ===========================================================================
 * The defect this exists to fix.
 *
 * The first version read one variable:
 *
 *     GATE_BASE_REF: ${{ github.event.pull_request.base.sha }}
 *
 * On a `pull_request` event that is correct. On a `push` event the expression
 * is **empty**, so the script fell back to comparing the working tree — and in
 * a fresh CI checkout nothing is uncommitted, so it found zero files and
 * exited 0 having checked nothing. The format gate silently covered nothing on
 * every push to master. A check that can pass vacuously is worse than no
 * check, because it reports success.
 *
 * So resolution is now explicit about which of four modes it is in, and the
 * zero-candidate case is adjudicated rather than assumed benign:
 *
 *   base    a pull request, against the merge base (three-dot)
 *   before  a push, against `github.event.before` (two-dot)
 *   all     a push with no usable predecessor — initial commit, new branch,
 *           or force-push. Every tracked file is treated as changed, which is
 *           the honest reading of "we cannot tell what came before".
 *   tree    local development: uncommitted + staged + untracked
 *
 * In CI, `tree` is never legitimate, and a mode that finds *no files at all*
 * means detection broke rather than that nothing changed.
 * ===========================================================================
 *
 * Everything here is pure except `git`, which is injected, so the decision
 * table is unit-testable without a repository. See
 * `test/unit/gate-guards.test.mjs`.
 */

/** `github.event.before` is this when there is no predecessor commit. */
const ZERO_SHA = /^0{7,40}$/;

/**
 * Decide what to compare against, from the environment alone.
 *
 * `resolve` is asked whether a ref actually exists in this clone; a base SHA
 * that is absent (shallow clone, force-pushed away) must not be used, because
 * `git diff` would fail and the caller would see an empty list — the same
 * silent pass in a different costume.
 */
export function resolveComparison({ env = {}, resolveRef = () => true } = {}) {
  const isCI = env.CI === 'true' || env.CI === '1';
  const baseRef = (env.GATE_BASE_REF ?? '').trim();
  const beforeRef = (env.GATE_BEFORE_REF ?? '').trim();

  if (baseRef.length > 0 && !ZERO_SHA.test(baseRef)) {
    if (resolveRef(baseRef)) {
      return {
        mode: 'base',
        ref: baseRef,
        isCI,
        reason: 'pull request base',
      };
    }
    // Named but unusable. In CI that is a broken checkout, not a licence to
    // check nothing; locally it is a stale variable worth ignoring.
    if (isCI) {
      return {
        mode: 'unresolvable',
        ref: baseRef,
        isCI,
        reason: `GATE_BASE_REF "${baseRef}" is not present in this clone (shallow checkout?)`,
      };
    }
  }

  if (beforeRef.length > 0 && !ZERO_SHA.test(beforeRef)) {
    if (resolveRef(beforeRef)) {
      return {
        mode: 'before',
        ref: beforeRef,
        isCI,
        reason: 'push predecessor',
      };
    }
    if (isCI) {
      // A force-push leaves `before` pointing at a commit no longer reachable.
      // Checking everything is the safe reading.
      return {
        mode: 'all',
        ref: null,
        isCI,
        reason: `push predecessor "${beforeRef}" is unreachable (force-push?); checking all tracked files`,
      };
    }
  }

  if (isCI) {
    // A push whose predecessor is the zero SHA: the initial commit, or the
    // first push of a new branch. Every file is new, so check every file.
    if (ZERO_SHA.test(beforeRef) && beforeRef.length > 0) {
      return {
        mode: 'all',
        ref: null,
        isCI,
        reason: 'no predecessor commit (initial commit or new branch)',
      };
    }
    // Nothing usable at all. Refuse rather than fall back to the working tree,
    // which is always empty in CI.
    return {
      mode: 'undetermined',
      ref: null,
      isCI,
      reason:
        'neither GATE_BASE_REF nor GATE_BEFORE_REF is usable, and a working-tree ' +
        'comparison is always empty in CI',
    };
  }

  return { mode: 'tree', ref: 'HEAD', isCI, reason: 'local working tree' };
}

/**
 * Collect the changed paths for a resolved comparison.
 *
 * `--diff-filter=d` drops deletions: Prettier cannot check a file that is no
 * longer there, and without it a commit that removes a file fails the gate.
 *
 * Returns every changed path, unfiltered by extension, because the caller
 * needs to distinguish "the change touched nothing we format" (legitimate)
 * from "we detected no change at all" (broken).
 */
export function collectChanged(comparison, { git, lsFiles }) {
  switch (comparison.mode) {
    case 'base':
      // Three-dot: against the merge base, so commits that landed on the base
      // after this branch started are not attributed to it.
      return {
        changed: git(['diff', '--name-only', '--diff-filter=d', `${comparison.ref}...HEAD`]),
        untracked: [],
      };
    case 'before':
      // Two-dot: exactly what this push added.
      return {
        changed: git(['diff', '--name-only', '--diff-filter=d', `${comparison.ref}..HEAD`]),
        untracked: [],
      };
    case 'all':
      return { changed: lsFiles(['ls-files']), untracked: [] };
    case 'tree':
      return {
        changed: [
          ...git(['diff', '--name-only', '--diff-filter=d', 'HEAD']),
          ...git(['diff', '--name-only', '--diff-filter=d', '--cached']),
        ],
        untracked: lsFiles(['ls-files', '--others', '--exclude-standard']),
      };
    default:
      return { changed: [], untracked: [] };
  }
}

/**
 * What to do when nothing is left to check.
 *
 * The distinction that matters, and the whole point of this module:
 *
 *   * `rawCount > 0, candidateCount === 0` — the change was real but touched
 *     nothing Prettier handles (a `.gitignore`, a PNG, a lockfile). Legitimate
 *     everywhere; pass and say so.
 *   * `rawCount === 0` in CI — detection produced an empty change set for a
 *     commit that by definition changed something. Broken; fail.
 *   * `rawCount === 0` locally — genuinely nothing modified. Fine.
 */
export function adjudicateZero({ mode, isCI, rawCount, candidateCount }) {
  if (candidateCount > 0) return { verdict: 'check', message: null };

  if (mode === 'undetermined' || mode === 'unresolvable') {
    return {
      verdict: 'fail',
      message: 'changed-file detection could not determine a comparison point',
    };
  }

  if (rawCount > 0) {
    return {
      verdict: 'pass',
      message: `${String(rawCount)} file(s) changed, none of them formats with Prettier`,
    };
  }

  if (isCI) {
    return {
      verdict: 'fail',
      message:
        `detected zero changed files in mode "${mode}" — a CI run implies a change, ` +
        'so this is a detection failure, not a clean result',
    };
  }

  return { verdict: 'pass', message: 'nothing modified in the working tree' };
}
