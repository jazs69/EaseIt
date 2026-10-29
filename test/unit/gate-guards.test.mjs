/**
 * Unit tests for the two safety mechanisms, with no services at all.
 *
 * ===========================================================================
 * Both things under test here are safety logic, and both had a real defect.
 *
 * 1. CHANGED-FILE DETECTION (`scripts/lib/changed-files.mjs`). The CI format
 *    check read only `github.event.pull_request.base.sha`, which is **empty on
 *    a push**. The script then compared the working tree, which in a fresh
 *    checkout is empty, and exited 0 having checked nothing. Every push to
 *    master was silently unchecked.
 *
 * 2. DATABASE ISOLATION (`test/support/isolation-guard.mjs`). Six of the seven
 *    destructive suites had no guard of their own; protection existed only when
 *    they were invoked through the release gate, and seven npm scripts invoke
 *    them directly.
 *
 * Neither can be left to integration testing: the first one's failure mode is
 * *passing*, and the second's is destroying a developer's database. Both are
 * therefore written as pure functions with injected git/file access, and
 * exercised here without PostgreSQL, Redis, Docker or an API.
 * ===========================================================================
 *
 *   node test/unit/gate-guards.test.mjs
 */

import {
  resolveComparison,
  collectChanged,
  adjudicateZero,
} from '../../scripts/lib/changed-files.mjs';
import {
  classifyTarget,
  describeTarget,
  developmentDatabaseNames,
} from '../support/isolation-guard.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const ZERO = '0000000000000000000000000000000000000000';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/* ========================================================================== */
console.log('Changed-file detection\n');

console.log('1. A pull request compares against its base.');
{
  const r = resolveComparison({
    env: { CI: 'true', GATE_BASE_REF: SHA_A },
    resolveRef: () => true,
  });
  check('mode is "base"', r.mode === 'base', r.mode);
  check('against the PR base sha', r.ref === SHA_A);

  const collected = collectChanged(r, {
    git: (args) => (args.includes(`${SHA_A}...HEAD`) ? ['a.ts'] : []),
    lsFiles: () => [],
  });
  check(
    'uses the three-dot form, so base-side commits are not attributed here',
    collected.changed.length === 1,
    collected.changed.join(','),
  );
}

console.log('\n2. A push compares against github.event.before — the defect.');
{
  // Exactly the old failing shape: PR base empty because this is not a PR.
  const r = resolveComparison({
    env: { CI: 'true', GATE_BASE_REF: '', GATE_BEFORE_REF: SHA_B },
    resolveRef: () => true,
  });
  check('mode is "before", not a working-tree fallback', r.mode === 'before', r.mode);
  check('against the push predecessor', r.ref === SHA_B);

  const collected = collectChanged(r, {
    git: (args) => (args.includes(`${SHA_B}..HEAD`) ? ['b.ts', 'c.md'] : []),
    lsFiles: () => [],
  });
  check(
    'two-dot form: exactly what this push added',
    collected.changed.length === 2,
    collected.changed.join(','),
  );
}

console.log('\n3. No usable predecessor is handled explicitly, never silently.');
{
  const initial = resolveComparison({
    env: { CI: 'true', GATE_BEFORE_REF: ZERO },
    resolveRef: () => true,
  });
  check(
    'an initial commit / new branch checks ALL tracked files',
    initial.mode === 'all',
    initial.reason,
  );
  const everything = collectChanged(initial, {
    git: () => [],
    lsFiles: (args) => (args.length === 1 && args[0] === 'ls-files' ? ['x.ts', 'y.ts'] : []),
  });
  check('and really collects them', everything.changed.length === 2);

  const forced = resolveComparison({
    env: { CI: 'true', GATE_BEFORE_REF: SHA_B },
    resolveRef: () => false, // force-pushed away: unreachable
  });
  check(
    'an unreachable predecessor (force-push) falls back to all, not nothing',
    forced.mode === 'all',
    forced.reason,
  );

  const shallow = resolveComparison({
    env: { CI: 'true', GATE_BASE_REF: SHA_A },
    resolveRef: () => false, // shallow clone: base absent
  });
  check(
    'a PR base missing from the clone is "unresolvable", not a pass',
    shallow.mode === 'unresolvable',
    shallow.reason,
  );

  const nothing = resolveComparison({ env: { CI: 'true' }, resolveRef: () => true });
  check(
    'CI with no refs at all is "undetermined" — the old silent-pass case',
    nothing.mode === 'undetermined',
    nothing.reason,
  );
}

console.log('\n4. Locally it still uses the working tree.');
{
  const r = resolveComparison({ env: {}, resolveRef: () => true });
  check('mode is "tree"', r.mode === 'tree', r.mode);
  const collected = collectChanged(r, {
    git: (args) => (args.includes('--cached') ? ['staged.ts'] : ['dirty.ts']),
    lsFiles: () => ['brand-new.ts'],
  });
  check(
    'uncommitted, staged and untracked are all included',
    collected.changed.length === 2 && collected.untracked.length === 1,
  );
}

console.log('\n5. Zero candidates: legitimate versus broken.');
{
  const legit = adjudicateZero({ mode: 'before', isCI: true, rawCount: 3, candidateCount: 0 });
  check(
    'a real change touching no formattable file PASSES',
    legit.verdict === 'pass',
    legit.message,
  );

  const broken = adjudicateZero({ mode: 'before', isCI: true, rawCount: 0, candidateCount: 0 });
  check(
    'detecting zero changed files in CI FAILS rather than passing',
    broken.verdict === 'fail',
    broken.message,
  );

  const localQuiet = adjudicateZero({ mode: 'tree', isCI: false, rawCount: 0, candidateCount: 0 });
  check('locally, nothing modified is fine', localQuiet.verdict === 'pass', localQuiet.message);

  for (const mode of ['undetermined', 'unresolvable']) {
    const v = adjudicateZero({ mode, isCI: true, rawCount: 0, candidateCount: 0 });
    check(`mode "${mode}" always fails`, v.verdict === 'fail', v.message);
  }

  const work = adjudicateZero({ mode: 'base', isCI: true, rawCount: 2, candidateCount: 2 });
  check('with candidates present it proceeds to check', work.verdict === 'check');
}

/* ========================================================================== */
console.log('\n\nDatabase isolation guard\n');

console.log('6. Target parsing never exposes credentials.');
{
  const t = describeTarget('postgresql://user:sup3rsecret@127.0.0.1:5432/easeit_ci?schema=public');
  check('host, port and name are extracted', t.host === '127.0.0.1' && t.port === '5432');
  check('database name excludes query parameters', t.name === 'easeit_ci', t.name);
  check(
    'the parsed shape carries no password field at all',
    !Object.values(t).some((v) => String(v).includes('sup3rsecret')),
    Object.keys(t).join(','),
  );
  check('a malformed url is rejected, not guessed', describeTarget('not-a-url') === null);
  check('an empty url is rejected', describeTarget('') === null);
}

console.log('\n7. The development database is refused, and env cannot authorise it.');
{
  const dev = new Set(['easeit']);

  const plain = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/easeit',
    developmentNames: dev,
  });
  check('the shared development database is refused', !plain.ok, plain.reasons[0]);

  // The attack this rule exists for.
  const viaEnv = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/easeit',
    allowExtra: 'easeit',
    developmentNames: dev,
  });
  check(
    'EASEIT_TEST_DBS=easeit does NOT authorise it',
    !viaEnv.ok,
    viaEnv.reasons[0]?.slice(0, 72),
  );

  const viaEnvList = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/easeit',
    allowExtra: 'easeit_ci,easeit,easeit_test',
    developmentNames: dev,
  });
  check('nor does hiding it in a longer allowlist', !viaEnvList.ok);

  const unknown = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/some_other_db',
    developmentNames: dev,
  });
  check(
    'a database not on the allowlist is refused',
    !unknown.ok,
    unknown.reasons[0]?.slice(0, 60),
  );
}

console.log('\n8. Permitted isolated targets are accepted.');
{
  const dev = new Set(['easeit']);
  for (const name of ['easeit_racetest', 'easeit_ci', 'easeit_recovery', 'easeit_test']) {
    const v = classifyTarget({
      url: `postgresql://u:p@127.0.0.1:5432/${name}`,
      developmentNames: dev,
    });
    check(`${name} is permitted by default`, v.ok, v.reasons.join('; '));
  }

  const extended = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/easeit_scratch',
    allowExtra: 'easeit_scratch',
    developmentNames: dev,
  });
  check('EASEIT_TEST_DBS can add a NON-development database', extended.ok);
}

console.log('\n9. Remote hosts are refused even with a permitted name.');
{
  const remote = classifyTarget({
    url: 'postgresql://u:p@db.production.example.com:5432/easeit_ci',
    developmentNames: new Set(['easeit']),
  });
  check('a non-local host is refused', !remote.ok, remote.reasons.join('; ').slice(0, 70));
  check(
    'and the refusal names the host, not the credentials',
    !remote.reasons.join(' ').includes(':p@'),
  );

  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    // IPv6 literals are bracketed in a URL; the parser must strip them.
    const url =
      host === '::1'
        ? 'postgresql://u:p@[::1]:5432/easeit_ci'
        : `postgresql://u:p@${host}:5432/easeit_ci`;
    const v = classifyTarget({ url, developmentNames: new Set(['easeit']) });
    check(`${host} is accepted as local`, v.ok, v.reasons.join('; '));
  }
}

console.log('\n10. Development names are discovered from the repo, not hard-coded.');
{
  const names = developmentDatabaseNames({
    files: ['fake/database.env'],
    readFile: () =>
      'DATABASE_URL="postgresql://u:p@127.0.0.1:5432/easeit?schema=public"\n' +
      'DIRECT_URL="postgresql://u:p@127.0.0.1:5432/easeit_direct"\n',
  });
  check(
    'both DATABASE_URL and DIRECT_URL names are collected',
    names.size === 2,
    [...names].join(','),
  );
  check('the primary development name is present', names.has('easeit'));

  const missing = developmentDatabaseNames({
    files: ['does/not/exist.env'],
    readFile: () => {
      throw new Error('ENOENT');
    },
  });
  check('a missing env file is tolerated, not fatal', missing.size === 0);

  // The real repository: whatever it names must be refused.
  const real = developmentDatabaseNames();
  check(
    'this repository yields at least one development name to refuse',
    real.size >= 1,
    `${String(real.size)} name(s)`,
  );
  const guarded = classifyTarget({
    url: `postgresql://u:p@127.0.0.1:5432/${[...real][0]}`,
    allowExtra: [...real].join(','),
    developmentNames: real,
  });
  check(
    "this repository's own development database cannot be targeted",
    !guarded.ok,
    guarded.reasons[0]?.slice(0, 64),
  );
}

/* ========================================================================== */
console.log(
  failures === 0 ? '\nAll gate-guard checks passed.' : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
