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
import { resolveSuiteSelection, suiteSelectionSyntax } from '../../scripts/lib/suite-selection.mjs';
import {
  apiMismatchMessage,
  assertIsolatedDatabase,
  classifyTarget,
  DEFAULT_ALLOWLIST,
  APPROVED_REDIS_PORTS,
  classifyDisposableTarget,
  describeRedisTarget,
  expectedTestPrefix,
  queuePrefixRefusals,
  REDIS_BOUNDARIES,
  REDIS_MODES,
  redisBoundaryRefusals,
  redisDbRefusal,
  redisModeFrom,
  redisOwnershipRefusals,
  redisTestRefusals,
  describeTarget,
  developmentDatabaseNames,
  postConnectionRefusals,
  redisRefusal,
  WHOLLY_DISPOSABLE,
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
  // `guardDatabase()` wraps the shared `assertIsolatedDatabase`; the ordering
  // it enforces is unchanged.
  const posGuard = suite.indexOf('await guardDatabase()');
  const posApi = suite.indexOf('await assertApiSharesDatabase(');
  const posFirstRace = suite.indexOf('await raceUnderLock(');
  check(
    'the database guard appears before the API probe, which appears before the first race',
    posGuard > -1 && posApi > posGuard && posFirstRace > posApi,
    `guard@${String(posGuard)} api@${String(posApi)} firstRace@${String(posFirstRace)}`,
  );
}
/* ========================================================================== */
/* -------------------------------------------------------------------------- */
/*  The post-connection policy, as a pure function                            */
/* -------------------------------------------------------------------------- */

/**
 * No database, and no seam on the guard either.
 *
 * ===========================================================================
 * These cases used to drive `assertIsolatedDatabase` end to end with a stub
 * client and a `developmentNamesOverride` option. The stub was fine; the
 * override was not. It let a caller tell the guard what counts as a
 * development database -- on the one function whose job is to stop a
 * destructive suite reaching real data. "No production caller passes it" is a
 * habit, not a guarantee, and a test-only parameter on a safety check is
 * exactly the kind of thing that later looks like a feature.
 *
 * So the policy is now `postConnectionRefusals`, pure and taking the
 * discovered set as an argument, and `assertIsolatedDatabase` obtains that
 * set itself with no way to be told otherwise. These cases call the helper
 * directly, which also makes the strict live-identity rule reachable --
 * through the guard it sits behind an early return.
 *
 * Two defects are pinned here, both found by reading rather than running:
 *
 *   1. The post-connection development-name check carried no built-in
 *      exemption while the pre-connection one did. In CI
 *      `packages/database/.env` names `easeit_ci`, so discovery reports it as
 *      "development" and every suite would have refused *after* passing every
 *      other check.
 *   2. `disposableOnly` was asserted only against the URL-derived name.
 * ===========================================================================
 */
console.log('\nThe post-connection policy (pure; no database is opened).');
{
  const decide = ({ urlName, liveName, dev = [], disposableOnly = false }) =>
    postConnectionRefusals({
      urlName,
      liveName: liveName ?? urlName,
      developmentNames: new Set(dev),
      disposableOnly,
    });

  const ok = (args) => decide(args).length === 0;
  const why = (args) => (decide(args)[0] ?? '').slice(0, 92);

  /* ---- the built-in exemption: the CI case ---- */
  check(
    'easeit_ci is permitted even when discovery reports it as development',
    ok({ urlName: 'easeit_ci', dev: ['easeit_ci'] }),
    'this is the CI configuration',
  );
  check(
    'and so is easeit_test, which is also built in',
    ok({ urlName: 'easeit_test', dev: ['easeit_test'] }),
  );

  /* ---- an ordinary working database is still refused ---- */
  check(
    "a developer's own database is refused when discovery finds it",
    !ok({ urlName: 'easeit_scratch', dev: ['easeit_scratch'] }),
    why({ urlName: 'easeit_scratch', dev: ['easeit_scratch'] }),
  );
  check(
    'but a name discovery has never heard of passes this tier',
    ok({ urlName: 'easeit_scratch', dev: [] }),
    'the allowlist tier in classifyTarget is what refuses it',
  );

  /* ---- identity ---- */
  const mismatch = { urlName: 'easeit_ci', liveName: 'easeit_racetest' };
  check(
    'a URL/live identity mismatch is refused',
    !ok(mismatch) && decide(mismatch)[0].includes('disagree'),
    why(mismatch),
  );
  check(
    'and nothing else is reported once the identity is wrong',
    decide({ ...mismatch, disposableOnly: true, dev: ['easeit_racetest'] }).length === 1,
    'one reason, not a pile of consequences',
  );

  /* ---- the strict tier, now directly reachable ---- */
  check(
    'disposableOnly refuses a live easeit_test',
    !ok({ urlName: 'easeit_test', disposableOnly: true }),
    why({ urlName: 'easeit_test', disposableOnly: true }),
  );
  check(
    'disposableOnly accepts a live easeit_ci',
    ok({ urlName: 'easeit_ci', disposableOnly: true, dev: ['easeit_ci'] }),
  );
  for (const name of WHOLLY_DISPOSABLE) {
    check(`disposableOnly accepts ${name}`, ok({ urlName: name, disposableOnly: true }));
  }
  check(
    'without disposableOnly, easeit_test is fine',
    ok({ urlName: 'easeit_test' }),
    'the strict tier is opt-in, per suite',
  );

  /* ---- the environment cannot reach this ---- */
  check(
    'postConnectionRefusals takes no environment input at all',
    postConnectionRefusals.length === 1,
    'one options object; nothing is read from process.env',
  );
  check(
    'and the guard no longer accepts a development-name override',
    !String(assertIsolatedDatabase).includes('developmentNamesOverride'),
    'the test-only seam is gone from the safety function',
  );

  check(
    'WHOLLY_DISPOSABLE is a proper subset of DEFAULT_ALLOWLIST, excluding easeit_test',
    WHOLLY_DISPOSABLE.every((n) => DEFAULT_ALLOWLIST.includes(n)) &&
      !WHOLLY_DISPOSABLE.includes('easeit_test') &&
      DEFAULT_ALLOWLIST.includes('easeit_test'),
    `strict [${WHOLLY_DISPOSABLE.join(', ')}] vs ordinary [${DEFAULT_ALLOWLIST.join(', ')}]`,
  );
}


/* -------------------------------------------------------------------------- */
/*  The guard's own wiring, with a stubbed client                             */
/* -------------------------------------------------------------------------- */

/**
 * Still no database: the client is a stub, so the live identity is dictated.
 *
 * ===========================================================================
 * The policy above is pure and covered. This covers the *wiring* -- that
 * `assertIsolatedDatabase` still reads `current_database()`, still feeds the
 * real discovered set into `postConnectionRefusals`, and still throws what it
 * returns.
 *
 * That is worth its own cases because extracting the helper meant cutting a
 * block out of the middle of the function, and the first attempt took the
 * `current_database()` query with it. Syntax checks passed; the function
 * would have thrown a ReferenceError on the first real run. A pure-policy
 * suite would not have noticed.
 * ===========================================================================
 */
console.log("\nThe guard's wiring (stubbed client; no database is opened).");
{
  const clientSaying = (name) => ({
    $queryRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings);
      if (sql.includes('current_database')) {
        return [{ name, version: 'PostgreSQL 17.6 on x86_64-test' }];
      }
      return [];
    },
  });

  const run = async ({ urlName, liveName, disposableOnly = false, extra = '' }) => {
    try {
      const confirmed = await assertIsolatedDatabase({
        prisma: clientSaying(liveName ?? urlName),
        suite: 'wiring test',
        requireConstraints: false,
        disposableOnly,
        env: {
          DATABASE_URL: `postgresql://u:p@127.0.0.1:5432/${urlName}?schema=public`,
          EASEIT_TEST_DBS: extra,
        },
      });
      return { ok: true, confirmed };
    } catch (error) {
      const text = String(error.message ?? error);
      const first = text.split('\n').find((l) => l.trim().startsWith('x')) ?? text;
      return { ok: false, why: first.trim().replace(/^x\s*/, '').slice(0, 92) };
    }
  };

  const happy = await run({ urlName: 'easeit_ci' });
  check(
    'an allowed database passes and the live name is read back',
    happy.ok && happy.confirmed?.liveName === 'easeit_ci',
    happy.ok ? `liveName=${String(happy.confirmed?.liveName)}` : happy.why,
  );

  const mismatch = await run({ urlName: 'easeit_ci', liveName: 'easeit_racetest' });
  check(
    'the guard still refuses a URL/live mismatch',
    !mismatch.ok &&
      mismatch.why.includes('easeit_ci') &&
      mismatch.why.includes('easeit_racetest'),
    mismatch.why,
  );

  const strict = await run({ urlName: 'easeit_test', disposableOnly: true });
  check('the guard still refuses easeit_test for a disposableOnly suite', !strict.ok, strict.why);

  const shared = await run({ urlName: 'easeit', extra: 'easeit' });
  check(
    'the guard still refuses the shared database, even via EASEIT_TEST_DBS',
    !shared.ok,
    shared.why,
  );
}

/* -------------------------------------------------------------------------- */
/*  Every destructive suite uses the shared guard                             */
/* -------------------------------------------------------------------------- */

/**
 * Read as source, not executed: these suites open databases.
 *
 * ===========================================================================
 * `create-race.test.mjs` carried its own `assertIsolatedDatabase` for a
 * while. It was not unguarded -- it called the shared `classifyTarget` and
 * verified `current_database()` -- but it was a second implementation, and
 * the failure mode of a second implementation is the one nobody sees: a tier
 * added to the shared guard simply does not apply.
 *
 * That already happened once. The built-in-test-name exemption was fixed in
 * `postConnectionRefusals`, and the copy never received it, so in CI -- where
 * discovery reports `easeit_ci` as a development name -- that suite would
 * have refused the database the workflow had just provisioned.
 *
 * So this asserts the property directly: no destructive suite declares its
 * own guard. It is a source check rather than a behavioural one because the
 * behaviour needs a database, and the thing worth defending is structural.
 * ===========================================================================
 */
console.log('\nEvery destructive suite uses the shared guard (source inspection).');
{
  const { readFileSync } = await import('node:fs');
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

  const suites = [
    'outbox.test.mjs',
    'check-in.test.mjs',
    'folio-payment.test.mjs',
    'cancel-reservation.test.mjs',
    'create-race.test.mjs',
    'check-out.test.mjs',
    'outbox-redis.test.mjs',
  ].map((name) => [name, read(`../integration/${name}`)]);
  suites.push(
    ['outbox-claim.test.mjs', read('../concurrency/outbox-claim.test.mjs')],
    ['parallel-booking.test.mjs', read('../concurrency/parallel-booking.test.mjs')],
  );

  for (const [name, source] of suites) {
    check(
      `${name} declares no guard of its own`,
      !/(?:async\s+)?function\s+assertIsolatedDatabase\s*\(/.test(source),
      'a local copy would not receive future tiers',
    );
    check(
      `${name} imports the shared guard`,
      // Matched on the specifier alone: some suites import it across a line
      // break, and the point is that the module is reached, not how it is laid out.
      source.includes('../support/isolation-guard.mjs'),
    );
  }

  /* ---- create-race specifically, since it is the one that was converted ---- */
  const race = read('../integration/create-race.test.mjs');
  check(
    'create-race calls the shared assertIsolatedDatabase',
    /assertIsolatedDatabase\(\{/.test(race),
    'with an options object, not the old no-arg local call',
  );
  check(
    'create-race preserves its EASEIT_TEST_DB alias by folding it into the shared variable',
    race.includes('EASEIT_TEST_DBS: EXTRA_ALLOWED'),
    'the alias keeps working without the shared guard growing a special case',
  );
  check(
    'create-race does not set disposableOnly, so easeit_test stays valid for it',
    !/disposableOnly\s*:/.test(race),
    'it removes its own fixtures and releases the nights it took',
  );
  check(
    'create-race no longer falls back to a .env file for DATABASE_URL',
    !race.includes('loadDatabaseEnv'),
  );
  check(
    'create-race requires EASEIT_API_URL rather than assuming a port',
    race.includes("if (!process.env.EASEIT_API_URL)") &&
      !/EASEIT_API_URL \?\? 'http/.test(race),
  );

  /* ---- and the two suites that must stay strict ---- */
  for (const [name, source] of [
    ['parallel-booking.test.mjs', read('../concurrency/parallel-booking.test.mjs')],
    ['outbox-redis.test.mjs', read('../integration/outbox-redis.test.mjs')],
  ]) {
    check(`${name} still passes disposableOnly: true`, source.includes('disposableOnly: true'));
  }
}

/* -------------------------------------------------------------------------- */
/*  Redis endpoint policy                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pure: no socket, no `process.env`, nothing to provision.
 *
 * ===========================================================================
 * This is the whole of the Redis defence, so it is tested as policy.
 *
 * `outbox-redis.test.mjs` calls `obliterate({ force: true })` and
 * `OutboxQueue` sets no BullMQ `prefix`, so every process pointed at one Redis
 * shares `bull:outbox:*`. There is no `current_database()` for Redis and no
 * prefix to scope a check to, so unlike the PostgreSQL guard there is nothing
 * to verify after connecting -- the URL decision is final. Before this helper
 * existed, the only refusal of 6379 lived in `require-services.mjs`, which
 * runs from the release gate and nowhere else.
 * ===========================================================================
 */
console.log('\nRedis endpoint policy (pure, no network).');
{
  const refused = (url) => redisRefusal({ url }) !== null;

  check('localhost:6379 is refused', refused('redis://localhost:6379'), 'the dev instance');
  check('127.0.0.1:6379 is refused', refused('redis://127.0.0.1:6379'), 'same instance, as an IP');
  check('localhost:6380 is accepted', !refused('redis://localhost:6380'));
  check('127.0.0.1:6380 is accepted', !refused('redis://127.0.0.1:6380'));
  check('rediss://127.0.0.1:6380 is accepted', !refused('rediss://127.0.0.1:6380'), 'TLS scheme');
  check('[::1]:6380 is accepted', !refused('redis://[::1]:6380'), 'bracketed IPv6 loopback');

  check('a malformed URL is refused', refused('not-a-url'));
  check('an empty URL is refused', refused(''));
  check('a missing URL is refused', refused(undefined), 'fail closed on absence');
  check('a non-string URL is refused', refused(6380), 'no coercion');
  check('an unsupported protocol is refused', refused('http://127.0.0.1:6380'));
  check('postgresql:// is refused', refused('postgresql://u:p@127.0.0.1:5432/db'), 'wrong service');
  check('a missing port is refused', refused('redis://127.0.0.1'), 'no implied 6379');
  check('a non-numeric port is refused', refused('redis://127.0.0.1:abc'));
  check('port 0 is refused', refused('redis://127.0.0.1:0'));
  check('a non-local host is refused', refused('redis://redis.example.com:6380'));

  /**
   * The allowlist, not a blocklist.
   *
   * A blocklist of 6379 accepts 6381 from a typo and obliterates whatever is
   * listening there. Nothing in this repository uses another port:
   * `release.yml` maps the container to 6380, `TESTING.md` documents 6380 and
   * `require-services.mjs` defaults to 6380.
   */
  check(
    'an unapproved port is refused even though it is not 6379',
    refused('redis://127.0.0.1:6381'),
    'the policy is an allowlist',
  );
  check('6380 is the approved port', APPROVED_REDIS_PORTS.includes(6380));
  check('6379 is not in the approved list', !APPROVED_REDIS_PORTS.includes(6379));

  /* ---- the reasons are usable, and carry no credentials ---- */
  const credentialled = redisRefusal({ url: 'redis://user:hunter2@127.0.0.1:6379' });
  check('the 6379 refusal names the port', credentialled?.includes('6379') === true);
  check(
    'a refusal never echoes credentials',
    credentialled !== null && !credentialled.includes('hunter2'),
    'these messages are printed',
  );

  /* ---- and the parser the policy and the preflight share ---- */
  check(
    'describeRedisTarget parses a port-only Redis URL',
    describeRedisTarget('redis://127.0.0.1:6380')?.port === '6380',
    'describeTarget cannot: its regex requires a /database segment',
  );
  check(
    'describeTarget still cannot, which is why this exists',
    describeTarget('redis://127.0.0.1:6380') === null,
    'the preflight refused its own default value as "unrecognised shape"',
  );
  check(
    'describeRedisTarget strips IPv6 brackets',
    describeRedisTarget('redis://[::1]:6380')?.host === '::1',
  );
  check(
    'describeRedisTarget does not return credentials',
    JSON.stringify(describeRedisTarget('redis://user:hunter2@127.0.0.1:6380') ?? {}).includes(
      'hunter2',
    ) === false,
  );
}

/* -------------------------------------------------------------------------- */
/*  The resilience gate propagates what it validated                          */
/* -------------------------------------------------------------------------- */

/**
 * Source inspection, because the behaviour needs PostgreSQL and Redis.
 *
 * ===========================================================================
 * H-1: the gate used to export `REDIS_URL` and nothing else.
 *
 * It validated an allowlist of database *names*, handed that to the preflight,
 * and spawned each suite with `env: { ...process.env, REDIS_URL }`. The
 * database it approved was therefore not the database the suite used -- each
 * suite re-derived its own from `packages/database/.env`, which on a developer
 * machine names the shared development database. The release path worked only
 * because the suites still carried that fallback.
 *
 * These are structural assertions for the same reason the shared-guard
 * adoption cases below are: the property worth defending is that the wiring
 * exists at all, and a behavioural test of it would have to connect.
 * ===========================================================================
 */
console.log('\nResilience gate environment propagation (source inspection).');
{
  const { readFileSync } = await import('node:fs');
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

  const gate = read('../../scripts/gate-resilience.mjs');
  const pkg = JSON.parse(read('../../package.json'));

  /* ---- the child environment is built from the validated values ---- */
  check(
    'the child env starts from the validated DATABASE_URL',
    /const childEnv = \{ \.\.\.process\.env, DATABASE_URL \};/.test(gate) &&
      /process\.env\.DATABASE_URL = DATABASE_URL;/.test(gate),
    'so the preflight, which inherits, sees it too',
  );
  check('the spawn hands over that object and nothing else', /^\s+env: childEnv,$/m.test(gate));
  check(
    'EASEIT_API_URL is set when needed and REMOVED when not',
    /if \(needsApi\) childEnv\.EASEIT_API_URL = API;\s*\n\s*else delete childEnv\.EASEIT_API_URL;/.test(
      gate,
    ),
    'an unvalidated value must not reach a child that does not need it',
  );
  check(
    'REDIS_URL is set when needed and REMOVED when not',
    /if \(needsRedis\) childEnv\.REDIS_URL = REDIS;\s*\n\s*else delete childEnv\.REDIS_URL;/.test(
      gate,
    ),
  );
  check(
    'the gate no longer writes API or Redis into its own process.env',
    !gate.includes('process.env.EASEIT_API_URL = ') && !gate.includes('process.env.REDIS_URL = '),
    'only DATABASE_URL, which the inheriting preflight needs',
  );

  /* ---- validated before anything is started ---- */
  const at = (needle) => gate.indexOf(needle);
  check(
    'the database target is classified before the preflight spawns',
    at('classifyDisposableTarget({') !== -1 &&
      at('classifyDisposableTarget({') < at("'scripts/require-services.mjs'"),
  );
  check(
    'the Redis URL is refused before the preflight spawns',
    at('redisRefusal({') !== -1 && at('redisRefusal({') < at("'scripts/require-services.mjs'"),
  );
  check(
    'and both are checked before any suite is spawned',
    at('classifyDisposableTarget({') < at('[suite.script]') &&
      at('redisRefusal({') < at('[suite.script]'),
  );
  check(
    'the strict tier is the shared composed helper, not a local narrowing',
    gate.includes('classifyDisposableTarget({') &&
      !gate.includes('WHOLLY_DISPOSABLE.includes(verdict') &&
      !/const\s+\w+\s*=\s*\[\s*'easeit_racetest'/.test(gate),
    'so the decision has a behavioural test, below',
  );
  check(
    'the banner prints the database NAME, never the URL',
    gate.includes('${verdict.target.name}') && !/console\.log\([^)]*\$\{DATABASE_URL\}/.test(gate),
    'a connection string carries a password',
  );
  check(
    'the banner reports the STRICT list it applied, not the preflight allowlist',
    /permitted : \$\{\[\.\.\.WHOLLY_DISPOSABLE\]/.test(gate) &&
      !/allowlist: \$\{ALLOWED_DATABASES\}/.test(gate),
    'ALLOWED_DATABASES folds in EASEIT_TEST_DBS and is the looser one',
  );

  /* ---- suite selection: every suite reachable, none duplicated ---- */
  const ids = [...gate.matchAll(/^\s{4}id: '([^']+)',$/gm)].map((m) => m[1]);
  check('the gate declares exactly two suites', ids.length === 2, ids.join(', '));
  check('suite ids are unique', new Set(ids).size === ids.length);
  check(
    'the default run selects every suite',
    gate.includes('only === null\n    ? suites'),
    'so gate:resilience behaviour is unchanged',
  );
  check(
    'an explicit --only overrides optional',
    gate.includes('{ ...suite, optional: false }'),
    '--no-stress must not silently skip the suite you named',
  );
  check(
    'a run with nothing left to do refuses to report success',
    gate.includes('running.length === 0'),
    'defensive: unreachable while outbox-redis is never optional',
  );

  /**
   * The selector is now a pure helper, tested behaviourally further down.
   *
   * =========================================================================
   * What is left to assert HERE is the wiring and the position, which are the
   * two things the helper's own tests cannot see: that the gate actually
   * delegates to it, that it honours a refusal rather than continuing, and
   * that all of it happens above the first file read and the first spawn.
   *
   * The needles below are chosen so they cannot match prose. The docblock
   * explaining this very ordering names `developmentDatabaseNames()`, and an
   * unqualified match found that sentence a few hundred bytes above the code.
   * =========================================================================
   */
  check(
    'the gate delegates selection to the pure helper',
    gate.includes("from './lib/suite-selection.mjs'") && gate.includes('resolveSuiteSelection({'),
    'rather than parsing argv inline, where only a substring could check it',
  );
  check(
    'and parses no --only argument of its own any more',
    !gate.includes("startsWith('--only=')") && !gate.includes("arg === '--only'"),
    'one parser, in one place',
  );
  check(
    'a refusal stops the gate with the exit code the helper chose',
    /if \(!selection\.ok\) \{/.test(gate) && gate.includes('process.exit(selection.exitCode)'),
    'the gate does not downgrade a usage error to a warning',
  );
  {
    const selector = at('resolveSuiteSelection({');
    const later = {
      'the env-file reader': at('function fromEnvFile'),
      'development-name discovery': at('developmentNames: developmentDatabaseNames()'),
      'the database classification': at('classifyDisposableTarget({'),
      'the first spawn': at('spawnSync('),
    };
    check(
      'selection precedes the first file read, the classification and every spawn',
      selector !== -1 && Object.values(later).every((index) => index !== -1 && selector < index),
      `a malformed invocation touches no file and starts no process (${Object.entries(later)
        .filter(([, index]) => index === -1 || selector > index)
        .map(([name]) => name)
        .join(', ')})`,
    );
  }

  /* ---- and the documented commands go through it ---- */
  for (const [script, id] of [
    ['test:concurrency', 'parallel-booking'],
    ['test:outbox:redis', 'outbox-redis'],
  ]) {
    const command = pkg.scripts[script] ?? '';
    check(
      `pnpm ${script} routes through the gate`,
      command.includes('scripts/gate-resilience.mjs') && command.includes(`--only=${id}`),
      command,
    );
    check(
      `pnpm ${script} does not invoke the suite file directly`,
      !/node\s+test\//.test(command),
      'no preflight, no allowlist, no exported target',
    );
    check(`pnpm ${script} names a suite the gate knows`, ids.includes(id));
  }
}

/* -------------------------------------------------------------------------- */
/*  The two destructive suites infer nothing                                  */
/* -------------------------------------------------------------------------- */

console.log('\nDestructive suites fail closed on their environment (source inspection).');
{
  const { readFileSync } = await import('node:fs');
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

  const booking = read('../concurrency/parallel-booking.test.mjs');
  const redis = read('../integration/outbox-redis.test.mjs');

  /* ---- parallel-booking ---- */
  check(
    'parallel-booking has no .env fallback for DATABASE_URL',
    !booking.includes('loadDatabaseEnv') && !/DATABASE_URL \?\?=/.test(booking),
  );
  check(
    'parallel-booking requires DATABASE_URL',
    booking.includes('if (!process.env.DATABASE_URL)'),
  );
  check(
    'parallel-booking no longer defaults the API to :4000',
    !/EASEIT_API_URL \?\? 'http/.test(booking) &&
      booking.includes('const API = process.env.EASEIT_API_URL;'),
  );
  check(
    'parallel-booking requires EASEIT_API_URL',
    booking.includes('if (!process.env.EASEIT_API_URL)'),
  );
  {
    const dbAt = booking.indexOf('if (!process.env.DATABASE_URL)');
    const apiAt = booking.indexOf('if (!process.env.EASEIT_API_URL)');
    const moduleAt = booking.indexOf("await import('../../packages/database/dist/index.js')");
    const prismaAt = booking.indexOf('createPrismaClient()');
    check(
      'both checks precede the database module import and the client',
      dbAt !== -1 && apiAt !== -1 && dbAt < moduleAt && apiAt < moduleAt && moduleAt < prismaAt,
      'a check after the client is not a check',
    );
  }

  /* ---- outbox-redis ---- */
  check(
    'outbox-redis has no .env fallback for either target',
    !redis.includes('loadEnvValue') && !/DATABASE_URL \?\?=/.test(redis),
  );
  check(
    'outbox-redis no longer defaults Redis to localhost:6379',
    // The construct, not the substring: the docblock names the old default
    // while explaining why it is gone.
    !/REDIS_URL\s*=\s*process\.env\.REDIS_URL\s*\?\?/.test(redis) &&
      !/\?\?\s*'redis:\/\//.test(redis),
    'on a suite that calls obliterate',
  );
  check('outbox-redis requires DATABASE_URL', redis.includes('if (!process.env.DATABASE_URL)'));
  check('outbox-redis requires REDIS_URL', redis.includes('if (!process.env.REDIS_URL)'));
  /**
   * Phase 3A-3 replaced `redisRefusal` here with the composed policy.
   *
   * =========================================================================
   * Two things had to change in this block, and the second is the instructive
   * one.
   *
   * The import assertion was anchored to a single-line `import { … }`, which
   * stopped matching once the list grew past the print width. Fine, and
   * caught immediately.
   *
   * The ordering assertions below were worse: they searched for
   * `redisRefusal({`, which the suite no longer calls -- but its new docblock
   * *quotes* `redisRefusal({ url })` while explaining that it is gone. So the
   * offset pointed at a comment and the checks passed for a reason unrelated
   * to the code. Reading the comment-stripped source removes the whole class.
   * =========================================================================
   */
  const redisCode = redis.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(
    'the comment-stripped view of outbox-redis keeps its code',
    redisCode.length > 0 &&
      redisCode.length < redis.length &&
      redisCode.includes('function configStub('),
    `${String(redis.length)} → ${String(redisCode.length)} characters`,
  );
  check(
    'outbox-redis imports the shared Redis policy statically',
    /import \{[\s\S]*?redisTestRefusals[\s\S]*?\} from '\.\.\/support\/isolation-guard\.mjs';/.test(
      redisCode,
    ),
    'a dynamic import could be reordered below the socket',
  );
  check(
    'and no longer uses the development-only policy',
    !redisCode.includes('redisRefusal'),
    'it knew nothing of the run, the namespace or the owner',
  );
  {
    const refusalAt = redisCode.indexOf('redisTestRefusals({');
    const probeAt = redisCode.indexOf('await redisReachable(');
    const prismaAt = redisCode.indexOf('createPrismaClient()');
    const queueAt = redisCode.indexOf('new Queue(');
    const obliterateAt = redisCode.indexOf('.obliterate(');
    check(
      'the composed policy runs before the first network I/O',
      refusalAt !== -1 && probeAt !== -1 && refusalAt < probeAt,
      'the reachability socket is the first connection this suite opens',
    );
    check(
      'and before Prisma, the Queue and obliterate',
      refusalAt < prismaAt && refusalAt < queueAt && refusalAt < obliterateAt,
    );
    check(
      'the not-run guidance recommends the approved port',
      redis.includes('-p 6380:6379') && !redis.includes('-p 6379:6379'),
    );
    /**
     * No 6379 default anywhere in the code, not even an unreachable one.
     *
     * The reachability probe used to do `Number(parsed.port || 6379)`. It was
     * dead -- the policy above requires an explicit approved port -- but a
     * 6379 default inside the file whose purpose is refusing 6379 is a trap
     * for whoever edits the policy next. Mutating that default back in was
     * caught by nothing until this check existed.
     */
    check(
      'the reachability probe keeps no 6379 default of its own',
      !/\|\|\s*6379/.test(redisCode) &&
        !/\?\?\s*6379/.test(redisCode) &&
        !/port = 6379/.test(redisCode),
      'the only 6379 left is the container-side port of the 6380 mapping',
    );
    check(
      'and the probe takes the already-parsed target instead of re-parsing',
      redis.includes('const REDIS_TARGET = describeRedisTarget(REDIS_URL);') &&
        redis.includes('await redisReachable(REDIS_TARGET)'),
      'one parser, the same one the policy used',
    );
    check(
      'neither the banner nor the not-run message prints the Redis URL',
      !/\$\{REDIS_URL\}/.test(redis),
      'it can carry credentials',
    );
  }

  /* ---- one definition of the port policy ---- */
  const preflight = read('../../scripts/require-services.mjs');
  check(
    'require-services uses the shared helper rather than its own port check',
    preflight.includes('redisRefusal({ url })') && !/target\.port === '6379'/.test(preflight),
  );
  check(
    'and applies the policy before it opens a socket',
    preflight.indexOf('redisRefusal({ url })') < preflight.indexOf('createConnection({'),
  );
}

/* -------------------------------------------------------------------------- */
/*  The composed strict database decision                                     */
/* -------------------------------------------------------------------------- */

/**
 * `classifyDisposableTarget` -- pure, and the real thing the gate calls.
 *
 * ===========================================================================
 * This replaces a source-substring assertion with a behavioural one.
 *
 * The resilience gate's decision is two rules composed: `classifyTarget`'s
 * ordinary tiers, then a narrowing to `WHOLLY_DISPOSABLE`. While the second
 * rule was an `if` in top-level script code it could not be imported, so the
 * most important guarantee of that gate -- *`easeit_test` is refused even
 * when `EASEIT_TEST_DBS` names it* -- was only ever checked by looking for a
 * substring in the file. A refactor that dropped the narrowing while leaving
 * the words in a comment would have kept that check green.
 *
 * `developmentNames` is passed explicitly and empty here: these cases are
 * about the allowlist tiers, and the discovery tier has its own cases above.
 * Nothing in this block reads a file, the environment or a socket.
 * ===========================================================================
 */
console.log('\nComposed strict database decision (pure).');
{
  const urlFor = (name) => `postgresql://u:p@127.0.0.1:5432/${name}?schema=public`;
  const decide = (name, allowExtra = '') =>
    classifyDisposableTarget({
      url: urlFor(name),
      allowExtra,
      developmentNames: new Set(),
    });

  /* ---- the three wholly disposable databases ---- */
  for (const name of WHOLLY_DISPOSABLE) {
    check(`${name} is accepted`, decide(name).ok === true);
  }
  check(
    'and those are exactly the three, so the cases above are the whole list',
    WHOLLY_DISPOSABLE.length === 3,
    WHOLLY_DISPOSABLE.join(', '),
  );

  /* ---- the one the ordinary allowlist accepts and this tier must not ---- */
  const plainTest = decide('easeit_test');
  check('easeit_test is rejected', plainTest.ok === false);
  check(
    'and classifyTarget alone would have accepted it',
    classifyTarget({ url: urlFor('easeit_test'), developmentNames: new Set() }).ok === true,
    'which is why the narrowing is the load-bearing part',
  );
  check(
    'the refusal says why, and that the variable cannot help',
    plainTest.reasons.some((reason) => reason.includes('not wholly disposable')) &&
      plainTest.reasons.some((reason) => reason.includes('EASEIT_TEST_DBS cannot extend')),
    plainTest.reasons[0],
  );

  /* ---- EASEIT_TEST_DBS cannot widen the strict tier ---- */
  check(
    'easeit_test is still rejected when EASEIT_TEST_DBS names it',
    decide('easeit_test', 'easeit_test').ok === false,
    'allowExtra is spent inside the ordinary tier',
  );
  check(
    'and when it is one name among several',
    decide('easeit_test', 'easeit_test,easeit_scratch,easeit_ci').ok === false,
  );
  check(
    'an invented disposable name is rejected even though allowExtra names it',
    decide('easeit_scratch', 'easeit_scratch').ok === false,
    'classifyTarget would accept it; this tier is not extensible',
  );

  /* ---- the shared database, under every spelling of permission ---- */
  check('easeit is rejected', decide('easeit').ok === false);
  check('easeit is rejected even via EASEIT_TEST_DBS', decide('easeit', 'easeit').ok === false);
  check(
    'and the refusal is the absolute one, not the disposability one',
    decide('easeit').reasons.some((reason) => reason.includes('known shared database')),
  );

  /* ---- everything else ---- */
  check('an unrecognised database is rejected', decide('postgres').ok === false);
  check('a production-looking name is rejected', decide('easeit_prod').ok === false);

  for (const [label, url] of [
    ['an empty URL', ''],
    ['a malformed URL', 'not-a-url'],
    ['a URL with no database segment', 'postgresql://u:p@127.0.0.1:5432'],
    ['a non-local host', 'postgresql://u:p@db.example.com:5432/easeit_ci'],
  ]) {
    const verdict = classifyDisposableTarget({ url, developmentNames: new Set() });
    check(`${label} is rejected`, verdict.ok === false, verdict.reasons[0]);
  }
  check(
    'an unparseable URL still returns reasons, and no null dereference',
    classifyDisposableTarget({ url: 'not-a-url' }).reasons.length > 0 &&
      classifyDisposableTarget({ url: 'not-a-url' }).target === null,
    'the gate reads verdict.target only after ok',
  );

  /* ---- purity, and no second copy of the list ---- */
  check(
    'the helper is pure: calling it twice gives the same answer',
    JSON.stringify(decide('easeit_ci')) === JSON.stringify(decide('easeit_ci')),
  );
  {
    const { readFileSync } = await import('node:fs');
    const guard = readFileSync(new URL('../support/isolation-guard.mjs', import.meta.url), 'utf8');
    // `DEFAULT_ALLOWLIST` legitimately also begins with 'easeit_racetest', so
    // counting that literal counted a list that is supposed to exist.
    const declarations = (guard.match(/WHOLLY_DISPOSABLE = \[/g) ?? []).length;
    check(
      'the strict list is declared exactly once in the guard',
      declarations === 1,
      `${String(declarations)} declaration(s)`,
    );
    check(
      'and the helper reads that array rather than a copy',
      /WHOLLY_DISPOSABLE\.includes\(verdict\.target\.name\)/.test(guard),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Suite selection — the --only parser, behaviourally                        */
/* -------------------------------------------------------------------------- */

/**
 * `resolveSuiteSelection` — the real parser, run, not read.
 *
 * ===========================================================================
 * The defect: `--only` was matched with `startsWith('--only=')` alone, so
 * `--only parallel-booking` -- with a space -- matched nothing, the gate saw
 * "no selector", and it ran its DEFAULT set: both suites, including the one
 * that rewrites shared `inventory_day` counters, which the operator had just
 * tried to exclude. A selector that silently widens the selection is worse
 * than a missing one.
 *
 * The fix was then only checkable by searching the gate for substrings,
 * because the gate is a script with top-level `process.exit` and `spawnSync`
 * and importing it would run it. A substring search cannot tell a working
 * parser from a comment quoting one -- a failure mode that has already
 * produced three false-green assertions in this file, each matching prose a
 * few hundred bytes above the code it meant to check.
 *
 * So the parser moved to `scripts/lib/suite-selection.mjs` and these cases
 * call it. No files, no `process.env`, no spawning, no services.
 * ===========================================================================
 */
console.log('\nSuite selection: the --only parser (pure).');
{
  const ids = ['outbox-redis', 'parallel-booking'];
  const resolve = (...argv) => resolveSuiteSelection({ argv, ids });

  /* ---- the two valid selectors ---- */
  const booking = resolve('--only=parallel-booking');
  check(
    'a valid parallel-booking selector resolves to exactly that id',
    booking.ok === true && booking.only === 'parallel-booking',
  );
  const outbox = resolve('--only=outbox-redis');
  check(
    'a valid outbox-redis selector resolves to exactly that id',
    outbox.ok === true && outbox.only === 'outbox-redis',
  );

  /* ---- absent means "every suite", which is the default run ---- */
  const absent = resolve();
  check(
    'no selector resolves to null, meaning every suite',
    absent.ok === true && absent.only === null,
    'gate:resilience default behaviour',
  );
  check(
    'and other flags do not disturb it',
    resolve('--no-stress').only === null &&
      resolve('--no-stress', '--only=outbox-redis').only === 'outbox-redis',
    'order independent',
  );

  /* ---- every malformed form, refused with exit code 2 ---- */
  const refusals = {
    'a bare --only (missing value)': resolve('--only'),
    'a space-separated value': resolve('--only', 'parallel-booking'),
    'a space-separated value, flags either side': resolve(
      '--no-stress',
      '--only',
      'parallel-booking',
    ),
    'an empty --only=': resolve('--only='),
    'an unknown selector': resolve('--only=bogus'),
    'duplicate selectors': resolve('--only=outbox-redis', '--only=parallel-booking'),
    'duplicate identical selectors': resolve('--only=outbox-redis', '--only=outbox-redis'),
    'a bare --only plus a valued one': resolve('--only', '--only=outbox-redis'),
  };

  for (const [label, verdict] of Object.entries(refusals)) {
    check(`${label} is refused`, verdict.ok === false, JSON.stringify(verdict.reasons?.[0]));
    check(`${label} exits 2, not 1`, verdict.exitCode === 2, 'a usage error, not a failed check');
    check(
      `${label} explains the accepted syntax`,
      Array.isArray(verdict.reasons) &&
        verdict.reasons.at(-1) === suiteSelectionSyntax(ids) &&
        verdict.reasons.length >= 2,
      'a refusal that does not say what to type instead is half a refusal',
    );
    check(`${label} never yields a selector`, verdict.only === undefined);
  }

  /**
   * The specific regression, stated as its own case.
   *
   * This is the one that matters: the space form must NOT come back as
   * "no selector given", because that is what widened the run.
   */
  const spaced = resolve('--only', 'parallel-booking');
  check(
    'the space form is not silently treated as "no selector"',
    spaced.ok === false && spaced.only !== null,
    'that reading is what made the gate run both suites',
  );
  check(
    'and the value sitting in the next argv slot is not adopted',
    spaced.reasons.some((reason) => reason.includes('a space is not the separator')),
    'accepting it would make the space a second, undocumented separator',
  );

  /**
   * Each refusal gives its OWN reason, not just some reason.
   *
   * Deleting the empty-value branch failed nothing at first: `--only=` then
   * fell through to the unknown-id branch and was still refused, as
   * "Unknown --only=." -- correct, but it tells the operator they typed an
   * unrecognised suite name when what they actually did was type nothing.
   * The distinction only exists if something asserts it.
   */
  check(
    'an empty value is reported as empty, not as an unknown suite',
    refusals['an empty --only='].reasons[0].includes('empty value') &&
      !refusals['an empty --only='].reasons[0].includes('Unknown'),
    refusals['an empty --only='].reasons[0],
  );
  check(
    'a bare --only is reported as a missing value, not as an unknown suite',
    refusals['a bare --only (missing value)'].reasons[0].includes('requires a value'),
  );
  check(
    'duplicates are reported as duplicates, and the count is named',
    refusals['duplicate selectors'].reasons[0].includes('given 2 times'),
  );

  /* ---- the message names both ids, from the list it was given ---- */
  check(
    'the syntax line names every known id',
    ids.every((id) => suiteSelectionSyntax(ids).includes(id)),
  );
  check(
    'the unknown-selector refusal quotes what was typed',
    resolve('--only=bogus').reasons[0].includes('bogus'),
  );

  /* ---- purity ---- */
  check(
    'the parser is pure: the same argv twice gives the same answer',
    JSON.stringify(resolve('--only=bogus')) === JSON.stringify(resolve('--only=bogus')) &&
      JSON.stringify(resolve('--only=outbox-redis')) ===
        JSON.stringify(resolve('--only=outbox-redis')),
  );
  check(
    'it does not mutate the argv it was given',
    (() => {
      const argv = ['--only=outbox-redis', '--no-stress'];
      const copy = [...argv];
      resolveSuiteSelection({ argv, ids });
      return JSON.stringify(argv) === JSON.stringify(copy);
    })(),
  );
  {
    const { readFileSync } = await import('node:fs');
    const parser = readFileSync(
      new URL('../../scripts/lib/suite-selection.mjs', import.meta.url),
      'utf8',
    );
    /**
     * Comments stripped ONCE, and every clause tested against the result.
     *
     * The first version stripped them for the `process.` clause and then
     * tested the raw source for `spawn` -- which the module's own docblock
     * contains, because it explains that it does not spawn. Same prose
     * collision as before, this time inside the check meant to catch it.
     */
    const code = parser.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(
      'and the module itself reaches for nothing outside its arguments',
      !/process\./.test(code) &&
        !/from 'node:/.test(code) &&
        !code.includes('spawn') &&
        !code.includes('readFile') &&
        !code.includes('fetch('),
      'no process, no env, no fs, no child process, no network -- comments excluded',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Redis destructive-run policy (Phase 2)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pure throughout: no socket, no filesystem, no `process.env`.
 *
 * ===========================================================================
 * What these policies are for, and what they honestly are not.
 *
 * `outbox-redis.test.mjs` calls `obliterate({ force: true })`. Before this,
 * the only evidence anything had about the target was its address -- loopback
 * and port 6380 -- which describes a convention, not an owner. These rules add
 * three things the address cannot say: which database, who owns the instance,
 * and whether the queue namespace belongs to this run.
 *
 * None of it proves isolation. `external` records an assertion the caller
 * makes; `owned` checks a chain the caller read elsewhere. The guard's job is
 * to refuse when no claim exists, which turns a silent assumption into one a
 * reviewer can argue with.
 *
 * NO CALLER YET. Phase 2 is policy only; the gate and the suite adopt it
 * later. The existing `redisRefusal` cases above must therefore still pass
 * unchanged, apart from the database tightening asserted here.
 * ===========================================================================
 */
console.log('\nRedis destructive-run policy (pure).');
{
  const RUN = 'a1b2c3d4';
  const CID = 'f'.repeat(64);
  const at = (port = 6380, path = '') => `redis://127.0.0.1:${String(port)}${path}`;
  const owned = (overrides = {}) => ({
    mode: 'owned',
    url: at(49176),
    prefix: `bull:test:${RUN}`,
    runId: RUN,
    container: { id: CID, label: RUN, mappedPort: '49176' },
    ...overrides,
  });
  const external = (overrides = {}) => ({
    mode: 'external',
    url: at(6380),
    prefix: `bull:test:${RUN}`,
    runId: RUN,
    boundary: 'ci-job-service',
    ...overrides,
  });

  /* ======================= database path ================================= */

  check('REDIS_MODES is the closed set', REDIS_MODES.join(',') === 'development,external,owned');
  check(
    'REDIS_BOUNDARIES is the closed set',
    REDIS_BOUNDARIES.join(',') === 'ci-job-service,operator-declared',
  );

  /** Accepted: absent, bare slash, explicit zero. Everything else refused. */
  for (const path of ['', '/', '/0']) {
    const target = describeRedisTarget(at(6380, path));
    check(
      `database path ${JSON.stringify(path)} is accepted`,
      redisDbRefusal(target) === null,
      `dbSpecifier=${JSON.stringify(target.dbSpecifier)}`,
    );
    check(
      `and ${JSON.stringify(path)} still passes the whole development policy`,
      redisRefusal({ url: at(6380, path) }) === null,
    );
  }

  for (const path of ['/1', '/7', '/15', '/00', '/foo', '//', '/0/1', '/ 0']) {
    const target = describeRedisTarget(at(6380, path));
    const reason = target === null ? 'unparseable URL' : redisDbRefusal(target);
    check(`database path ${JSON.stringify(path)} is refused`, reason !== null);
    check(
      `and ${JSON.stringify(path)} is refused by redisRefusal too`,
      redisRefusal({ url: at(6380, path) }) !== null,
      'the tightening reaches the existing callers',
    );
  }

  /* ---- the two new fields, and why there are two ---- */
  check(
    'dbSpecifier keeps what was typed',
    describeRedisTarget(at(6380, '/00'))?.dbSpecifier === '00' &&
      describeRedisTarget(at(6380, '/foo'))?.dbSpecifier === 'foo' &&
      describeRedisTarget(at(6380, '//'))?.dbSpecifier === '/',
  );
  check(
    'db parses when numeric and is null otherwise',
    describeRedisTarget(at(6380, '/7'))?.db === 7 &&
      describeRedisTarget(at(6380, '/foo'))?.db === null &&
      describeRedisTarget(at(6380, ''))?.db === null,
  );
  check(
    'and the policy reads dbSpecifier, not db',
    describeRedisTarget(at(6380, '/00'))?.db === 0 &&
      redisDbRefusal(describeRedisTarget(at(6380, '/00'))) !== null,
    '"00" parses to 0 but nobody meant to type it',
  );
  check(
    'the existing fields are untouched',
    (() => {
      const t = describeRedisTarget(at(6380));
      return t.scheme === 'redis' && t.host === '127.0.0.1' && t.port === '6380';
    })(),
    'additive only; no caller destructuring breaks',
  );
  check('redisDbRefusal fails closed on a null target', redisDbRefusal(null) !== null);
  check('and on undefined', redisDbRefusal(undefined) !== null);
  check(
    'the port message still wins over the database message',
    redisRefusal({ url: at(6379, '/7') })?.includes('6379') === true,
    'the shared instance is the bigger problem',
  );

  /* ======================= mode selection ================================ */

  check('no container id selects external', redisModeFrom({}) === 'external');
  check('an absent argument selects external', redisModeFrom() === 'external');
  check(
    'a blank container id selects external',
    redisModeFrom({ containerId: '   ' }) === 'external',
  );
  check('a container id selects owned', redisModeFrom({ containerId: CID }) === 'owned');
  check(
    'mode selection never returns development',
    [{}, { containerId: CID }, { containerId: '' }].every(
      (input) => redisModeFrom(input) !== 'development',
    ),
    'no destructive context is development',
  );
  check(
    'a container id ALONE does not satisfy ownership',
    redisOwnershipRefusals({
      mode: 'owned',
      target: describeRedisTarget(at(49176)),
      runId: RUN,
      container: { id: CID },
    }).length > 0,
    'classification is not verification',
  );

  /* ======================= boundary declaration ========================== */

  for (const boundary of REDIS_BOUNDARIES) {
    check(
      `external accepts boundary ${boundary}`,
      redisBoundaryRefusals({ mode: 'external', boundary }).length === 0,
    );
  }
  check(
    'external refuses a missing boundary',
    redisBoundaryRefusals({ mode: 'external' }).length === 1,
    redisBoundaryRefusals({ mode: 'external' })[0]?.slice(0, 60),
  );
  check(
    'and says plainly that loopback and the port are not ownership',
    redisBoundaryRefusals({ mode: 'external' })[0]?.includes('do not establish ownership') === true,
  );
  check(
    'external refuses an unrecognised boundary',
    redisBoundaryRefusals({ mode: 'external', boundary: 'ci-job-sevice' }).length === 1,
    'a typo in a closed set',
  );
  check(
    'owned needs no boundary',
    redisBoundaryRefusals({ mode: 'owned' }).length === 0,
    'its evidence is the container triple',
  );
  check(
    'but a typo is still refused in owned mode',
    redisBoundaryRefusals({ mode: 'owned', boundary: 'nonsense' }).length === 1,
    'so it cannot reach external later unnoticed',
  );
  check(
    'development needs no boundary',
    redisBoundaryRefusals({ mode: 'development' }).length === 0,
  );

  /* ======================= ownership triple ============================== */

  const target49176 = describeRedisTarget(at(49176));

  check(
    'a complete, consistent triple is accepted',
    redisOwnershipRefusals({
      mode: 'owned',
      target: target49176,
      runId: RUN,
      container: { id: CID, label: RUN, mappedPort: '49176' },
    }).length === 0,
  );
  check(
    'a numeric mappedPort is accepted',
    redisOwnershipRefusals({
      mode: 'owned',
      target: target49176,
      runId: RUN,
      container: { id: CID, label: RUN, mappedPort: 49176 },
    }).length === 0,
  );
  check(
    'ownership is not checked outside owned mode',
    redisOwnershipRefusals({ mode: 'external', target: target49176, runId: RUN }).length === 0 &&
      redisOwnershipRefusals({ mode: 'development' }).length === 0,
  );

  const ownershipCases = {
    'container evidence missing entirely': { container: undefined },
    'container is null': { container: null },
    'container is not an object': { container: 'deadbeef' },
    'id missing': { container: { label: RUN, mappedPort: '49176' } },
    'id is the 12-character short form': {
      container: { id: CID.slice(0, 12), label: RUN, mappedPort: '49176' },
    },
    'id is not hex': { container: { id: 'z'.repeat(64), label: RUN, mappedPort: '49176' } },
    'label missing': { container: { id: CID, mappedPort: '49176' } },
    'label belongs to another run': {
      container: { id: CID, label: 'deadbeef', mappedPort: '49176' },
    },
    'mappedPort missing': { container: { id: CID, label: RUN } },
    'mappedPort is blank': { container: { id: CID, label: RUN, mappedPort: '' } },
    'mappedPort addresses a different endpoint': {
      container: { id: CID, label: RUN, mappedPort: '6380' },
    },
  };

  for (const [label, overrides] of Object.entries(ownershipCases)) {
    const reasons = redisOwnershipRefusals({
      mode: 'owned',
      target: target49176,
      runId: RUN,
      container: { id: CID, label: RUN, mappedPort: '49176' },
      ...overrides,
    });
    check(`ownership refused when ${label}`, reasons.length > 0, reasons[0]?.slice(0, 64));
  }

  check(
    'an invalid runId refuses rather than matching an equally invalid label',
    redisOwnershipRefusals({
      mode: 'owned',
      target: target49176,
      runId: '',
      container: { id: CID, label: '', mappedPort: '49176' },
    }).length > 0,
    'label === runId must not be vacuously true',
  );
  check(
    'ownership refuses when the URL itself is unparseable',
    redisOwnershipRefusals({
      mode: 'owned',
      target: null,
      runId: RUN,
      container: { id: CID, label: RUN, mappedPort: '49176' },
    }).length > 0,
  );

  /* ======================= queue prefix ================================== */

  check(
    'the canonical prefix is accepted',
    queuePrefixRefusals({ mode: 'owned', prefix: `bull:test:${RUN}`, runId: RUN }).length === 0,
  );
  for (const prefix of [`bull:test:${RUN}`, `bull:test:${RUN}:outbox`, `custom:test:${RUN}`, RUN]) {
    check(
      `prefix ${JSON.stringify(prefix)} carries the run id as a segment`,
      queuePrefixRefusals({ mode: 'external', prefix, runId: RUN }).length === 0,
    );
  }

  check(
    'a substring-only match is refused',
    queuePrefixRefusals({ mode: 'owned', prefix: `bull${RUN}`, runId: RUN }).length === 1,
    'bulla1b2c3d4 is a typo, not a namespace',
  );
  check(
    'and so is a partial segment',
    queuePrefixRefusals({ mode: 'owned', prefix: `bull:test:${RUN}x`, runId: RUN }).length === 1,
  );
  check(
    'a missing prefix is refused',
    queuePrefixRefusals({ mode: 'owned', runId: RUN }).length === 1,
  );
  check(
    'a blank prefix is refused',
    queuePrefixRefusals({ mode: 'owned', prefix: '   ', runId: RUN }).length === 1,
  );
  check(
    'the production prefix "bull" is refused, by its own message',
    queuePrefixRefusals({ mode: 'owned', prefix: 'bull', runId: RUN })[0]?.includes(
      'production default',
    ) === true,
    'not merely "does not contain the run id"',
  );
  check(
    'bull:test with no run id is refused',
    queuePrefixRefusals({ mode: 'owned', prefix: 'bull:test', runId: RUN }).length === 1,
  );
  check(
    'and a trailing colon does not count as the segment',
    queuePrefixRefusals({ mode: 'owned', prefix: 'bull:test:', runId: RUN }).length === 1,
  );
  check(
    'the prefix is not checked in development mode',
    queuePrefixRefusals({ mode: 'development', prefix: 'bull', runId: RUN }).length === 0,
    'that policy is unchanged',
  );

  /* ---- run id validity, checked BEFORE it is used ---- */
  for (const runId of [
    undefined,
    null,
    '',
    '   ',
    'abc',
    'a1b2c3d',
    'A1B2C3D4',
    'a1b2c3dz',
    12345678,
  ]) {
    const reasons = queuePrefixRefusals({ mode: 'owned', prefix: 'bull:test:x', runId });
    check(
      `runId ${JSON.stringify(runId)} is refused as invalid`,
      reasons.length === 1 && reasons[0].includes('not a valid run id'),
    );
  }
  check(
    'an 8-hex run id is valid and a longer one too',
    queuePrefixRefusals({ mode: 'owned', prefix: `p:${RUN}`, runId: RUN }).length === 0 &&
      queuePrefixRefusals({
        mode: 'owned',
        prefix: 'p:0123456789abcdef',
        runId: '0123456789abcdef',
      }).length === 0,
  );
  check(
    'an empty run id cannot vacuously satisfy segment matching',
    queuePrefixRefusals({ mode: 'owned', prefix: 'a::b', runId: '' }).length === 1,
    'the "" segment exists in "a::b"; the run-id check is what stops it',
  );

  /* ---- expectedTestPrefix ---- */
  check(
    'expectedTestPrefix is the canonical shape',
    expectedTestPrefix(RUN) === `bull:test:${RUN}`,
  );
  check(
    'and it refuses to build one from a malformed run id',
    (() => {
      try {
        expectedTestPrefix('nope');
        return false;
      } catch (error) {
        return error.message.includes('Cannot build a test queue prefix');
      }
    })(),
    'a prefix derived from a bad run id would not be run-scoped',
  );
  check(
    'its output satisfies its own policy',
    queuePrefixRefusals({ mode: 'owned', prefix: expectedTestPrefix(RUN), runId: RUN }).length ===
      0,
  );

  /* ======================= the composition =============================== */

  check('a complete owned invocation is accepted', redisTestRefusals(owned()).length === 0);
  check('a complete external invocation is accepted', redisTestRefusals(external()).length === 0);

  check(
    'owned waives the port allowlist',
    redisTestRefusals(
      owned({ url: at(49176), container: { id: CID, label: RUN, mappedPort: '49176' } }),
    ).length === 0,
    'an ephemeral docker -P port must be usable',
  );
  check(
    'external does NOT waive it',
    redisTestRefusals(external({ url: at(49176) })).some((reason) =>
      reason.includes('not an approved test port'),
    ),
    'the address is the only evidence external has',
  );
  check(
    'but 6379 is refused in BOTH modes',
    redisTestRefusals(
      owned({ url: at(6379), container: { id: CID, label: RUN, mappedPort: '6379' } }),
    ).some((reason) => reason.includes('6379')) &&
      redisTestRefusals(external({ url: at(6379) })).some((reason) => reason.includes('6379')),
    'ownership never licenses the development instance',
  );
  check(
    'a non-loopback host is refused in both modes',
    redisTestRefusals(owned({ url: 'redis://redis.example.com:49176' })).some((r) =>
      r.includes('not local'),
    ) &&
      redisTestRefusals(external({ url: 'redis://redis.example.com:6380' })).some((r) =>
        r.includes('not local'),
      ),
  );
  check(
    'a database is refused in both modes',
    redisTestRefusals(owned({ url: at(49176, '/7') })).some((r) => r.includes('database')) &&
      redisTestRefusals(external({ url: at(6380, '/7') })).some((r) => r.includes('database')),
  );

  /* ---- fail closed on the mode ---- */
  for (const mode of [undefined, null, '', 'owned ', 'OWNED', 'test', 'production']) {
    const reasons = redisTestRefusals({ ...owned(), mode });
    check(
      `mode ${JSON.stringify(mode)} is refused`,
      reasons.length === 1 && reasons[0].includes('is not one of'),
    );
  }
  check(
    'development is refused as a destructive mode',
    redisTestRefusals({ ...owned(), mode: 'development' })[0]?.includes(
      'not a destructive-run mode',
    ) === true,
    'obliterate has no business claiming to be development',
  );
  check(
    'an absent argument object is refused',
    redisTestRefusals().length === 1,
    'no default mode',
  );

  /* ---- an unparseable URL reports only that ---- */
  check(
    'an unparseable URL gives exactly one, accurate reason',
    (() => {
      const reasons = redisTestRefusals(owned({ url: 'not-a-url' }));
      return reasons.length === 1 && reasons[0].includes('malformed');
    })(),
    'reporting "database not permitted" for garbage would mislead',
  );

  /* ---- several problems are reported together ---- */
  check(
    'multiple failures are all reported',
    redisTestRefusals({
      mode: 'external',
      url: at(49176, '/7'),
      prefix: 'bull',
      runId: RUN,
    }).length >= 4,
    'port, database, boundary and prefix',
  );

  /* ---- composition is exactly the sum of its parts ---- */
  check(
    'the composition delegates rather than reimplementing',
    (() => {
      const input = { mode: 'external', url: at(6380), prefix: 'bull', runId: RUN };
      const composed = redisTestRefusals(input);
      const direct = [
        ...redisBoundaryRefusals({ mode: 'external', boundary: undefined }),
        ...queuePrefixRefusals(input),
      ];
      return direct.every((reason) => composed.includes(reason));
    })(),
    'every sub-policy reason appears verbatim in the composed result',
  );

  /* ---- purity, asserted over the module source ---- */
  {
    const { readFileSync } = await import('node:fs');
    const guard = readFileSync(new URL('../support/isolation-guard.mjs', import.meta.url), 'utf8');
    const start = guard.indexOf('/*  Redis endpoint policy');
    const end = guard.indexOf('/** host / port / dbname only');
    const block = guard
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check(
      'the Redis policy block touches no network, filesystem or environment',
      start !== -1 &&
        end > start &&
        !/process\.env/.test(block) &&
        !/readFileSync|createConnection|fetch\(|net\.|require\(/.test(block),
      'refusals cannot reach a connection, because the module cannot open one',
    );
  }

  /* ---- and the pre-existing policy still answers as before ---- */
  check(
    'the development policy is otherwise unchanged',
    redisRefusal({ url: at(6380) }) === null &&
      redisRefusal({ url: at(6379) }) !== null &&
      redisRefusal({ url: at(6381) }) !== null &&
      redisRefusal({ url: 'redis://redis.example.com:6380' }) !== null &&
      redisRefusal({ url: 'http://127.0.0.1:6380' }) !== null &&
      redisRefusal({ url: 'redis://127.0.0.1' }) !== null,
  );
}

console.log(
  failures === 0 ? '\nAll gate-guard checks passed.' : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
