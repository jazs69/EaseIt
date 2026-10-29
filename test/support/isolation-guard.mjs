/**
 * The guard every destructive suite calls before it writes anything.
 *
 * ===========================================================================
 * Why each suite, and not just the release gate.
 *
 * `scripts/require-services.mjs` already refuses a shared database — but only
 * for suites invoked *through* `pnpm gate:integration`. Seven npm scripts
 * invoke the suites directly:
 *
 *     pnpm test:cancellation   pnpm test:checkin   pnpm test:concurrency
 *     pnpm test:outbox         pnpm test:outbox:redis
 *     pnpm test:outbox:concurrency                 pnpm test:races
 *
 * Run that way the preflight never executes. `pnpm test:concurrency` would
 * mutate shared inventory fixtures on the development database with no
 * refusal at all. Protection that depends on choosing the right entry point is
 * not protection, so it moves into the suites themselves.
 *
 * THE RULE ENV CANNOT OVERRIDE
 * `EASEIT_TEST_DBS` may *extend* the allowlist, which is how CI names
 * `easeit_ci`. It may not authorise the development database: the names found
 * in `packages/database/.env` and the repository root `.env` are read at
 * startup and **always refused**, whatever the allowlist says. So
 * `EASEIT_TEST_DBS=easeit pnpm test:concurrency` fails, and a stray
 * `DATABASE_URL` pointing at development fails, regardless of how the suite
 * was started.
 *
 * Checked three ways, because the cheap check is the one that lies: the URL
 * says what we *meant* to reach, `current_database()` says what we actually
 * reached, and the constraint inventory says the guards the assertions depend
 * on are really there.
 *
 * Nothing here prints a connection string: they carry passwords. Only host,
 * port and database name are ever shown.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

/** Databases that may be used, before any environment extension. */
const DEFAULT_ALLOWLIST = ['easeit_racetest', 'easeit_recovery', 'easeit_ci', 'easeit_test'];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** The guards every concurrency and inventory assertion leans on. */
const REQUIRED_CONSTRAINTS = [
  'inventory_day_not_oversold',
  'reservation_room_no_overlap',
  'inventory_day_counters_non_negative',
  'reservation_cancelled_at_matches_status',
];

/** host / port / dbname only — never the credentials. */
export function describeTarget(url) {
  /**
   * The host alternation handles bracketed IPv6 (`[::1]`) as well as a
   * hostname or IPv4 literal. Without it `postgresql://u:p@[::1]:5432/db`
   * failed to parse and the caller saw "unrecognised shape" -- which is
   * fail-closed and therefore safe, but it would have refused a legitimate
   * loopback target. Caught by the unit test for local-host acceptance.
   */
  const parsed = /^(\w+):\/\/(?:[^:@/]+(?::[^@/]*)?@)?(\[[^\]]+\]|[^/:]+):(\d+)\/([^?\s]*)/.exec(
    url ?? '',
  );
  if (parsed === null) return null;
  const [, scheme, host, port, name] = parsed;
  // Brackets are URL syntax, not part of the address.
  return { scheme, host: host.replace(/^\[|\]$/g, ''), port, name };
}

/**
 * Shared database names that are refused even when no `.env` file exists.
 *
 * ===========================================================================
 * Discovery from `.env` is necessary but not sufficient, and CI proved it.
 *
 * `.env` files are gitignored, so a fresh checkout has none — and on GitHub
 * Actions run 40820963243 the `fast` job therefore discovered **zero**
 * development names. That broke a unit test, which is how it was found, but
 * the real problem was worse than a red check: with an empty discovered set,
 * `EASEIT_TEST_DBS=easeit` would have *authorised* the shared development
 * database, because the denylist that is supposed to override the allowlist
 * was empty.
 *
 * So the known shared names are seeded unconditionally. Discovery still runs
 * and still adds whatever a developer's own files name, but the floor no
 * longer depends on a file that version control deliberately does not carry.
 * ===========================================================================
 */
const ALWAYS_FORBIDDEN = new Set(['easeit']);

/**
 * Database names this repository's env files point at.
 *
 * Discovery only — the unconditional floor lives in `classifyTarget`, because
 * the two signals mean different things and conflating them caused a CI
 * failure. See the precedence note there.
 */
export function developmentDatabaseNames({
  readFile = (path) => readFileSync(path, 'utf8'),
  files = ['packages/database/.env', '.env', 'apps/api/.env'],
} = {}) {
  const names = new Set();
  for (const file of files) {
    let text;
    try {
      text = readFile(file);
    } catch {
      continue; // A missing env file is ordinary, not an error.
    }
    for (const match of text.matchAll(/^(?:DATABASE_URL|DIRECT_URL)\s*=\s*"?([^"\r\n]+)"?/gm)) {
      const target = describeTarget(match[1]);
      if (target !== null && target.name.length > 0) names.add(target.name);
    }
  }
  return names;
}

/**
 * The whole decision, as a pure function, so every rejection path is testable
 * without a database. Returns `{ ok, target, reasons }`.
 */
export function classifyTarget({ url, allowExtra = '', developmentNames = new Set() }) {
  const reasons = [];

  const target = describeTarget(url);
  if (target === null) {
    return {
      ok: false,
      target: null,
      reasons: ['DATABASE_URL is missing or has an unrecognised shape.'],
    };
  }

  const extra = allowExtra
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const builtInTestNames = new Set(DEFAULT_ALLOWLIST);
  const allowed = new Set([...DEFAULT_ALLOWLIST, ...extra]);

  /**
   * Three tiers, in this order, and the order is the whole design.
   *
   * =======================================================================
   * Two different signals were conflated once, and CI caught it.
   *
   * The first version seeded the discovered-name set with a hard-coded floor
   * and refused anything in it. That broke GitHub Actions, because the
   * integration workflow *writes* `packages/database/.env` pointing at
   * `easeit_ci` -- so discovery dutifully reported the suite's own disposable
   * database as "development" and the gate refused the one database it was
   * supposed to use:
   *
   *     x  "easeit_ci" is a shared development database.
   *
   * The two signals are not the same thing:
   *
   *   1. `ALWAYS_FORBIDDEN` -- names known to be shared and never disposable.
   *      Absolute. No environment variable, allowlist entry or env file can
   *      authorise one. This is the rule that stops
   *      `EASEIT_TEST_DBS=easeit`.
   *   2. `developmentNames` -- whatever this checkout's env files happen to
   *      point at. A useful hint locally, where it catches a non-standard
   *      personal database name. Meaningless in CI, where the env files are
   *      written by the workflow and name a throwaway database. So it refuses
   *      only names that are NOT built-in test databases, and
   *      `EASEIT_TEST_DBS` cannot override it either -- only the built-in
   *      list can.
   *   3. The allowlist -- `DEFAULT_ALLOWLIST` plus `EASEIT_TEST_DBS`.
   * =======================================================================
   */
  if (ALWAYS_FORBIDDEN.has(target.name)) {
    reasons.push(
      `"${target.name}" is a known shared database. It can never be a ` +
        'destructive-test target, and no environment variable can authorise it.',
    );
  } else if (developmentNames.has(target.name) && !builtInTestNames.has(target.name)) {
    reasons.push(
      `"${target.name}" is what this checkout's .env files point at, and it is not one ` +
        `of the built-in disposable test databases (${[...builtInTestNames].sort().join(', ')}). ` +
        'Refusing it as your working database; EASEIT_TEST_DBS cannot override this.',
    );
  } else if (!allowed.has(target.name)) {
    reasons.push(
      `"${target.name}" is not a permitted isolated database. Permitted: ` +
        `${[...allowed].sort().join(', ')}. Set EASEIT_TEST_DBS to extend that list ` +
        '(it can never include a known shared database).',
    );
  }

  if (!LOCAL_HOSTS.has(target.host)) {
    reasons.push(`host "${target.host}" is not local; refusing to mutate it.`);
  }

  return { ok: reasons.length === 0, target, reasons };
}

function refuse(suite, lines) {
  const message =
    `REFUSING TO RUN — ${suite}\n` +
    'This suite creates, mutates and deletes fixtures, so it must not touch a\n' +
    'shared database. Nothing has been changed.\n' +
    lines.map((line) => `  x  ${line}`).join('\n') +
    '\nSee TESTING.md for how to provision an isolated database.';
  return new Error(message);
}

/**
 * Call this BEFORE creating, mutating or deleting any fixture.
 *
 * Throws on any doubt. Returns the confirmed target so a suite can log it.
 */
export async function assertIsolatedDatabase({
  prisma,
  suite,
  requireConstraints = true,
  env = process.env,
}) {
  const developmentNames = developmentDatabaseNames();
  const verdict = classifyTarget({
    url: env.DATABASE_URL,
    allowExtra: env.EASEIT_TEST_DBS ?? '',
    developmentNames,
  });

  if (!verdict.ok) throw refuse(suite, verdict.reasons);

  // What the URL claims, versus what the server says it actually is.
  const [live] = await prisma.$queryRaw`SELECT current_database() AS name, version() AS version`;
  if (live.name !== verdict.target.name) {
    throw refuse(suite, [
      `DATABASE_URL names "${verdict.target.name}" but the live connection is to ` +
        `"${live.name}". The URL and the server disagree.`,
    ]);
  }
  // Re-run the name rules against the live answer, so a proxy or a search_path
  // trick cannot land us on development after the URL check passed.
  if (developmentNames.has(live.name)) {
    throw refuse(suite, [`the live connection is to the development database "${live.name}".`]);
  }

  if (requireConstraints) {
    const rows = await prisma.$queryRaw`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('inventory_day_not_oversold', 'reservation_room_no_overlap',
                        'inventory_day_counters_non_negative',
                        'reservation_cancelled_at_matches_status')`;
    const present = new Set(rows.map((row) => row.conname));
    const missing = REQUIRED_CONSTRAINTS.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw refuse(suite, [
        `missing constraint(s): ${missing.join(', ')}. Run \`prisma migrate deploy\`; ` +
          'these suites assert behaviour those constraints provide, so a green run ' +
          'without them would prove nothing.',
      ]);
    }
  }

  console.log(
    `  guard  ${suite}: ${verdict.target.host}:${verdict.target.port}/${live.name} ` +
      `(${live.version.split(',')[0]})`,
  );
  return { ...verdict.target, liveName: live.name };
}

/**
 * For suites that drive the API: prove the API reached the same database.
 *
 * Without it a suite could assert against the isolated database while the
 * endpoints quietly wrote to development — every assertion passing for the
 * wrong reason. The probe is a row this suite can see; an API on another
 * database cannot.
 */
export async function assertApiSharesDatabase({ suite, api, probe }) {
  const result = await probe();
  if (!result.ok) {
    throw refuse(suite, [
      `the API at ${api} does not share this database (${result.detail}). ` +
        'Start an API whose DATABASE_URL is the same isolated database.',
    ]);
  }
  console.log(`  guard  ${suite}: API ${api} confirmed on the same database`);
}
