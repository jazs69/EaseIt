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
 * Database names belonging to shared development, read from the env files the
 * suites themselves default to. Always refused.
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
  const allowed = new Set([...DEFAULT_ALLOWLIST, ...extra]);

  /**
   * The development name is refused FIRST and unconditionally.
   *
   * Order matters: if the allowlist were consulted first, adding `easeit` to
   * `EASEIT_TEST_DBS` would authorise it. This is the rule the environment
   * cannot override.
   */
  if (developmentNames.has(target.name)) {
    reasons.push(
      `"${target.name}" is a shared development database (named in this repository's ` +
        '.env files). It can never be a destructive-test target, and no environment ' +
        'variable can authorise it.',
    );
  } else if (!allowed.has(target.name)) {
    reasons.push(
      `"${target.name}" is not a permitted isolated database. Permitted: ` +
        `${[...allowed].sort().join(', ')}. Set EASEIT_TEST_DBS to extend that list ` +
        '(it cannot include a development database).',
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
