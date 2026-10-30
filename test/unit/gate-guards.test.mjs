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
  apiMismatchMessage,
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

console.log('\n10. Discovery versus the built-in floor.');
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

  /**
   * Regression for GitHub Actions run 40820963243 (the `fast` job).
   *
   * `.env` files are gitignored, so CI discovers nothing. If the forbidden
   * floor lived only in the discovered set, `EASEIT_TEST_DBS=easeit` would
   * have authorised the shared development database on any machine without a
   * `.env`. The floor must therefore be independent of discovery.
   */
  const noDiscovery = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/easeit',
    allowExtra: 'easeit',
    developmentNames: new Set(),
  });
  check(
    'with NO discovered names, easeit is STILL refused by the built-in floor',
    !noDiscovery.ok,
    noDiscovery.reasons[0]?.slice(0, 60),
  );

  /**
   * Regression for the follow-up failure in `gate:integration`.
   *
   * The integration workflow writes `packages/database/.env` pointing at
   * `easeit_ci`, so discovery reports the suite's own disposable database as
   * though it were development. Conflating that with the floor made the gate
   * refuse the one database it was supposed to use:
   *
   *     x  "easeit_ci" is a shared development database.
   */
  for (const name of ['easeit_ci', 'easeit_racetest', 'easeit_recovery', 'easeit_test']) {
    const ciShaped = classifyTarget({
      url: `postgresql://u:p@127.0.0.1:5432/${name}`,
      allowExtra: name,
      developmentNames: new Set([name]),
    });
    check(
      `${name} is allowed even when the .env files name it (the CI shape)`,
      ciShaped.ok,
      ciShaped.reasons.join('; ').slice(0, 80),
    );
  }

  // Discovery still does its local job: a personal database name that is not
  // a built-in disposable one is refused, and EASEIT_TEST_DBS cannot override.
  const personal = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/easeit_myfork',
    allowExtra: 'easeit_myfork',
    developmentNames: new Set(['easeit_myfork']),
  });
  check(
    'a personal database named by .env is refused despite EASEIT_TEST_DBS',
    !personal.ok,
    personal.reasons[0]?.slice(0, 68),
  );

  /**
   * The real repository, whatever it currently holds. No assertion on the
   * SIZE of the discovered set: it is legitimately empty in a fresh checkout
   * and in CI, which is exactly what the floor is for.
   */
  const real = developmentDatabaseNames();
  console.log(`  note  discovered ${String(real.size)} development name(s) in this checkout`);
  const guarded = classifyTarget({
    url: 'postgresql://u:p@127.0.0.1:5432/easeit',
    allowExtra: 'easeit',
    developmentNames: real,
  });
  check(
    "this repository's own development database cannot be targeted",
    !guarded.ok,
    guarded.reasons[0]?.slice(0, 60),
  );
}

/* ========================================================================== */
console.log('\n\nGuard diagnostics\n');

console.log('\n11. The API/database mismatch refusal (shared helper).');
{
  /**
   * The real composer, not a copy of it.
   *
   * `apiMismatchMessage` is the function `create-race.test.mjs` actually calls
   * (see `assertApiSharesDatabase` there). The first version of this section
   * kept its own copy of the template and asserted against that, which passed
   * by construction and would have kept passing if the real message
   * regressed. Importing the shared helper is what makes these assertions
   * mean something.
   */
  const recorded =
    "REFUSING TO RUN. The API at http://127.0.0.1:4100/api/v1 cannot see this suite's " +
    'property 60f0436f-2cf4-482c-bca2-256caf1333af (HTTP 401). It is pointed at a ' +
    'different database. Start an API whose DATABASE_URL names "easeit_ci".';

  const reproduced = apiMismatchMessage({
    api: 'http://127.0.0.1:4100/api/v1',
    propertyId: '60f0436f-2cf4-482c-bca2-256caf1333af',
    status: 401,
    isolatedDb: 'easeit_ci',
  });

  /**
   * A golden string taken from a real failing run: the API was started against
   * `easeit_racetest` while the suite ran against `easeit_ci`, and this is
   * byte-for-byte what the guard printed. If the helper drifts, this fails.
   */
  check(
    'the helper reproduces the message observed in a real mismatch run',
    reproduced === recorded,
    reproduced === recorded ? 'byte-identical' : `got: ${reproduced}`,
  );

  check(
    'it names the database the API should point at',
    reproduced.includes('names "easeit_ci"'),
    reproduced.slice(-40),
  );
  check('it names the API that was probed', reproduced.includes('http://127.0.0.1:4100/api/v1'));
  check('it reports the HTTP status that triggered it', reproduced.includes('(HTTP 401)'));
  check('it names the property that could not be seen', reproduced.includes('60f0436f'));

  /**
   * The bug this replaced produced a ReferenceError instead of a message, so
   * the helper is checked for actually returning a usable string under every
   * argument it is given -- including the shapes that would have thrown.
   */
  check('it returns a string, not a thrown error', typeof reproduced === 'string');
  check('no ReferenceError text leaks into the message', !/ReferenceError/.test(reproduced));

  let undefinedArgs = null;
  try {
    undefinedArgs = apiMismatchMessage({});
  } catch (error) {
    undefinedArgs = `THREW ${error.constructor.name}`;
  }
  check(
    'it still composes a message when every field is missing, rather than throwing',
    typeof undefinedArgs === 'string' && !undefinedArgs.startsWith('THREW'),
    typeof undefinedArgs === 'string' ? undefinedArgs.slice(0, 48) : String(undefinedArgs),
  );

  check(
    'a numeric status is stringified rather than concatenated as a number',
    apiMismatchMessage({ api: 'a', propertyId: 'b', status: 404, isolatedDb: 'c' }).includes(
      '(HTTP 404)',
    ),
  );

  // The shape the original bug had: an identifier that is not in scope. This
  // is a JavaScript property rather than a property of the guard, kept only to
  // record why the fix had to thread the value through a parameter.
  let threw = null;
  try {
    // eslint-disable-next-line no-undef
    void `names ${outOfScopeBinding ?? 'fallback'}`;
  } catch (error) {
    threw = error;
  }
  check(
    'an out-of-scope identifier in a template literal throws, it does not fall back',
    threw instanceof ReferenceError,
    threw === null ? 'did not throw' : threw.constructor.name,
  );

  /**
   * Call-site and ordering checks, read from the source.
   *
   * LIMITED PURPOSE, stated plainly: these compare character offsets in the
   * file, not execution order, and they cannot run the integration guard --
   * importing `create-race.test.mjs` would execute the whole suite. They are a
   * tripwire against the call site losing its third argument or the API probe
   * drifting after the first race, nothing more. The behaviour itself is
   * covered by `pnpm gate:integration` against an isolated database.
   */
  const { readFileSync } = await import('node:fs');
  const suite = readFileSync(
    new URL('../integration/create-race.test.mjs', import.meta.url),
    'utf8',
  );
  check(
    'the integration guard calls the shared helper, not its own template',
    suite.includes('apiMismatchMessage({') && !suite.includes("cannot see this suite's property"),
    'single source of truth',
  );
  check(
    'the API probe is threaded the confirmed name',
    /assertApiSharesDatabase\(cookie, fixture\.propertyId, isolatedDb\)/.test(suite),
  );
  const posGuard = suite.indexOf('await assertIsolatedDatabase()');
  const posApi = suite.indexOf('await assertApiSharesDatabase(');
  const posFirstRace = suite.indexOf('await raceUnderLock(');
  check(
    'the database guard appears before the API probe, which appears before the first race',
    posGuard > -1 && posApi > posGuard && posFirstRace > posApi,
    `guard@${String(posGuard)} api@${String(posApi)} firstRace@${String(posFirstRace)}`,
  );
}
/* ========================================================================== */
console.log(
  failures === 0 ? '\nAll gate-guard checks passed.' : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
