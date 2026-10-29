/**
 * The release gate's preflight.
 *
 * ===========================================================================
 * Why this exists as a separate, loud step.
 *
 * Three of the integration suites in `test/` read `DATABASE_URL` and happily
 * run against whatever it names — which, with no environment set, is the
 * **shared development database**. `cancel-reservation.test.mjs`,
 * `check-in.test.mjs` and `parallel-booking.test.mjs` all create and mutate
 * fixtures, and `parallel-booking` mutates shared inventory rows. None of them
 * asserts which database it reached. Only `create-race.test.mjs` does.
 *
 * Rewriting those suites to each carry their own guard would mean editing
 * working, verified tests. Putting one guard in front of them instead gives
 * the same protection for the whole layer: the integration command refuses to
 * start unless the environment names a disposable database from an explicit
 * allowlist, and refuses again if the live connection disagrees with the URL.
 *
 * It also turns an absent service into a FAILURE rather than a skip. A suite
 * that quietly does nothing because Redis is down is worse than one that
 * fails, because it reports success.
 *
 * Nothing here prints a connection string: they carry passwords. Only
 * host, port and database name are ever shown.
 * ===========================================================================
 *
 * Usage:
 *   node scripts/require-services.mjs --db=easeit_racetest[,other]
 *   node scripts/require-services.mjs --db=... --api=http://127.0.0.1:4100/api/v1
 *   node scripts/require-services.mjs --redis=redis://127.0.0.1:6380
 *
 * Exits 0 only when every requested prerequisite is present and verified.
 */

import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

/**
 * The same classifier the suites themselves use.
 *
 * Imported rather than reimplemented so the gate and the suites can never
 * disagree about which databases are permitted -- in particular about the rule
 * that a development database is refused whatever `EASEIT_TEST_DBS` says.
 */
import {
  classifyTarget,
  describeTarget,
  developmentDatabaseNames,
} from '../test/support/isolation-guard.mjs';

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);

const problems = [];
const confirmed = [];

/** Same resolution order the suites use, so the gate sees what they will see. */
function loadEnvValue(key) {
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

/* -------------------------------------------------------------------------- */
/*  PostgreSQL: the right database, proven twice                              */
/* -------------------------------------------------------------------------- */

async function checkDatabase(allowlistRaw) {
  const allowed = allowlistRaw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (allowed.length === 0) {
    problems.push('--db was given no database names, so nothing could be allowed.');
    return;
  }

  const url = process.env.DATABASE_URL ?? loadEnvValue('DATABASE_URL');
  if (!url) {
    problems.push(
      'DATABASE_URL is not set and no .env supplied one. ' +
        `This layer must run against one of: ${allowed.join(', ')}.`,
    );
    return;
  }

  const verdict = classifyTarget({
    url,
    allowExtra: [allowlistRaw, process.env.EASEIT_TEST_DBS ?? ''].filter(Boolean).join(','),
    developmentNames: developmentDatabaseNames(),
  });

  if (!verdict.ok) {
    for (const reason of verdict.reasons) problems.push(reason);
    return;
  }

  const target = verdict.target;

  // The reality, checked by asking the server. A URL only says what we meant.
  let prisma = null;
  try {
    const mod = await import('../packages/database/dist/index.js');
    const { createPrismaClient } = mod.default ?? mod;
    prisma = createPrismaClient();
    const [live] = await prisma.$queryRaw`SELECT current_database() AS name, version() AS version`;

    if (live.name !== target.name) {
      problems.push(
        `DATABASE_URL names "${target.name}" but the live connection is to "${live.name}". ` +
          'The URL and the server disagree; refusing.',
      );
      return;
    }

    // The guards every concurrency assertion leans on. Without them a green
    // run proves nothing, so their absence is a failure, not a warning.
    const constraints = await prisma.$queryRaw`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('inventory_day_not_oversold', 'reservation_room_no_overlap',
                        'inventory_day_counters_non_negative',
                        'reservation_cancelled_at_matches_status')`;
    const present = new Set(constraints.map((row) => row.conname));
    const missing = [
      'inventory_day_not_oversold',
      'reservation_room_no_overlap',
      'inventory_day_counters_non_negative',
      'reservation_cancelled_at_matches_status',
    ].filter((name) => !present.has(name));

    if (missing.length > 0) {
      problems.push(
        `Database "${live.name}" is missing: ${missing.join(', ')}. ` +
          'Run `prisma migrate deploy` against it; the concurrency suites assert behaviour ' +
          'these constraints provide.',
      );
      return;
    }

    confirmed.push(
      `PostgreSQL  ${target.host}:${target.port}/${live.name} — ` +
        `${live.version.split(',')[0]}, ${String(present.size)}/4 guards present`,
    );
  } catch (error) {
    problems.push(
      `Could not verify the database: ${String(error.message ?? error)}. ` +
        '(Is the server running, and has `pnpm build` produced packages/database/dist?)',
    );
  } finally {
    if (prisma !== null) await prisma.$disconnect().catch(() => null);
  }
}

/* -------------------------------------------------------------------------- */
/*  The API under test                                                        */
/* -------------------------------------------------------------------------- */

async function checkApi(base) {
  const url = `${base.replace(/\/$/, '')}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      problems.push(`The API at ${base} answered HTTP ${String(response.status)} on /health.`);
      return;
    }
    confirmed.push(`API         ${base} — /health 200`);
  } catch (error) {
    problems.push(
      `The API at ${base} is unreachable (${String(error.name ?? error)}). ` +
        'Start one pointed at the SAME disposable database before running this layer.',
    );
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  Redis                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A plain socket, not ioredis.
 *
 * ioredis retries a refused connection instead of failing, so asking BullMQ
 * would hang rather than answer — the same reason `outbox-redis.test.mjs`
 * opens a socket first.
 */
async function checkRedis(url) {
  const target = describeTarget(url);
  if (target === null) {
    problems.push('The Redis URL has an unrecognised shape.');
    return;
  }

  const reachable = await new Promise((resolve) => {
    const socket = createConnection({
      host: target.host,
      port: Number(target.port) || 6379,
    });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(5_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

  if (!reachable) {
    problems.push(
      `Redis is unreachable at ${target.host}:${target.port}. ` +
        'This layer needs an ISOLATED instance, because the outbox suite calls ' +
        '`obliterate` on the `outbox` queue and OutboxQueue sets no BullMQ prefix — ' +
        'on a shared Redis that would destroy real queue state. Start one, e.g.: ' +
        'docker run -d --name easeit-redis-test -p 6380:6379 redis:7-alpine',
    );
    return;
  }

  if (target.port === '6379') {
    problems.push(
      'Redis is on the default port 6379, which is the shared development instance. ' +
        'Use a dedicated instance on another port (6380) so queue obliteration ' +
        'cannot reach development state.',
    );
    return;
  }

  confirmed.push(`Redis       ${target.host}:${target.port} — reachable, non-default port`);
}

/* -------------------------------------------------------------------------- */

if (args.has('db')) await checkDatabase(args.get('db'));
if (args.has('api')) await checkApi(args.get('api'));
if (args.has('redis')) await checkRedis(args.get('redis'));

if (!args.has('db') && !args.has('api') && !args.has('redis')) {
  console.error('require-services: nothing requested. Pass --db, --api and/or --redis.');
  process.exit(2);
}

for (const line of confirmed) console.log(`  ok    ${line}`);

if (problems.length > 0) {
  console.error('');
  console.error('PREREQUISITES NOT MET — refusing to run. Nothing was changed.');
  for (const problem of problems) console.error(`  ✖  ${problem}`);
  console.error('');
  console.error('See TESTING.md for how to provision an isolated database and Redis.');
  process.exit(1);
}

console.log('  ok    all prerequisites verified');
