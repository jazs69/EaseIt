/**
 * The outbox claim race suite.
 *
 * ===========================================================================
 * The question: can two dispatchers hand the same event to two workers?
 *
 * This is the outbox's version of the double-booking problem, and it has the
 * same answer as CLAUDE.md section 3.1 gives there — the database, not the
 * application, is the guarantee. The claim is a single CTE whose inner SELECT
 * is `FOR UPDATE SKIP LOCKED`, so concurrent dispatchers take disjoint sets
 * and none waits on another.
 *
 * Why it matters even though delivery is at-least-once: a *lease expiry*
 * duplicate is rare, bounded and recoverable, and a handler is required to
 * survive it. A *claim race* duplicate would be routine, unbounded and
 * invisible — every poll, at every scale — and would make the backlog
 * meaningless. The two are not the same risk.
 *
 * So this suite fires N dispatchers at one batch of rows, in parallel, and
 * asserts that every row was claimed exactly once and that the union of what
 * they claimed is the whole batch with nothing missing and nothing repeated.
 * Then it does it again with a tighter batch size than the row count, to prove
 * SKIP LOCKED spreads the work rather than serialising on the same head rows.
 *
 * Section 3.1: "Deleting or weakening these tests is not permitted."
 *
 * Redis is not involved: the queue is a recording fake. The property under
 * test is the lowest-coded one, and every row is removed in teardown.
 * ===========================================================================
 */

// Nest's decorators need the metadata polyfill, and it lives in the API's own
// node_modules rather than the root's under pnpm, so it is resolved by path.
await import(new URL('../../apps/api/node_modules/reflect-metadata/Reflect.js', import.meta.url));
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function loadDatabaseEnv() {
  for (const relative of ['../../packages/database/.env', '../../.env']) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
      const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m.exec(text);
      if (match?.[1]) return match[1];
    } catch {
      // Next candidate.
    }
  }
  return null;
}

process.env.DATABASE_URL ??= loadDatabaseEnv() ?? '';
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set and no .env was found. Run pnpm db:seed first.');
  process.exit(1);
}

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;

const DIST = '../../apps/api/dist/modules/platform/outbox';
/**
 * Loads a compiled service.
 *
 * `nest build` emits CommonJS, so Node may hand back the module either flat or
 * behind a `default` interop wrapper depending on how it was bundled. Taking
 * whichever one actually carries named exports keeps this working either way.
 */
async function load(relative) {
  const loaded = await import(new URL(`${DIST}/${relative}`, import.meta.url));
  return Object.keys(loaded).some((key) => key !== 'default') ? loaded : (loaded.default ?? loaded);
}

const { OutboxDispatcherService } = await load('outbox-dispatcher.service.js');
const { OutboxMetricsService } = await load('outbox-metrics.service.js');

const prisma = createPrismaClient();

const RUN = randomUUID().slice(0, 8);
const KEY = (suffix) => `claimrace:${RUN}:${suffix}`;

/** Dispatchers racing. More than the batch size, so claims must overlap. */
const DISPATCHERS = Number(process.env.EASEIT_OUTBOX_DISPATCHERS ?? 8);
const ROWS = Number(process.env.EASEIT_OUTBOX_ROWS ?? 60);

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const prismaStub = { client: prisma, ping: async () => true };

function configStub(overrides) {
  return {
    get(key, fallback) {
      return key in overrides ? overrides[key] : fallback;
    },
  };
}

/** Records every publish, so a double claim shows up as a duplicate row id. */
function recordingQueue() {
  return {
    published: [],
    async publish(row) {
      this.published.push(row.id);
    },
  };
}

/** Seeds `count` rows, all immediately due. */
async function seedRows(propertyId, label, count) {
  const ids = [];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    ids.push(id);
    values.push({ id, dedupeKey: KEY(`${label}-${index}`) });
  }

  // One statement: the fixture must not be the slow part of a race test.
  await prisma.outboxEvent.createMany({
    data: values.map(({ id, dedupeKey }) => ({
      id,
      propertyId,
      eventType: 'OUTBOX_SELF_TEST',
      payloadVersion: 1,
      payload: { nonce: `${RUN}-${label}` },
      dedupeKey,
      dedupeMode: 'COALESCE',
      availableAt: new Date(Date.now() - 1_000),
    })),
  });

  return ids;
}

/** Builds `count` independent dispatchers, each with its own queue. */
function buildDispatchers(count, batchSize) {
  return Array.from({ length: count }, () => {
    const queue = recordingQueue();
    const dispatcher = new OutboxDispatcherService(
      prismaStub,
      queue,
      new OutboxMetricsService(prismaStub),
      configStub({ OUTBOX_BATCH_SIZE: batchSize, OUTBOX_LEASE_MS: 60_000 }),
    );
    return { dispatcher, queue };
  });
}

async function race(label, ids, dispatcherCount, batchSize) {
  console.log(
    `\n${label}: ${ids.length} due row(s), ${dispatcherCount} dispatcher(s), batch size ${batchSize}`,
  );

  const racers = buildDispatchers(dispatcherCount, batchSize);

  // One tick each, all at once. `publishDue` rather than `start()` so the
  // assertion is deterministic rather than interval-dependent.
  const claimedCounts = await Promise.all(racers.map(({ dispatcher }) => dispatcher.publishDue()));

  const allPublished = racers.flatMap(({ queue }) => queue.published);
  const ours = allPublished.filter((id) => ids.includes(id));
  const unique = new Set(ours);

  check(
    'no row was claimed by two dispatchers',
    unique.size === ours.length,
    `${ours.length} claim(s), ${unique.size} distinct`,
  );
  check(
    'every row was claimed exactly once',
    unique.size === ids.length,
    `${unique.size}/${ids.length} claimed`,
  );
  check(
    'the claim counts the dispatchers reported add up',
    claimedCounts.reduce((total, count) => total + count, 0) >= ids.length,
    `reported ${claimedCounts.join('+')} = ${claimedCounts.reduce((a, b) => a + b, 0)}`,
  );

  const states = await prisma.outboxEvent.groupBy({
    by: ['status'],
    where: { id: { in: ids } },
    _count: { _all: true },
  });
  const inFlight = states.find((entry) => entry.status === 'IN_FLIGHT')?._count._all ?? 0;
  check(
    'and all of them are IN_FLIGHT in the database',
    inFlight === ids.length,
    states.map((entry) => `${entry.status}=${entry._count._all}`).join(' '),
  );

  const claimants = await prisma.outboxEvent.findMany({
    where: { id: { in: ids } },
    select: { claimedBy: true, leaseExpiresAt: true, attempts: true, recoveries: true },
  });
  check(
    'each row names exactly one claimant and holds a future lease',
    claimants.every(
      (entry) =>
        typeof entry.claimedBy === 'string' &&
        entry.claimedBy.length > 0 &&
        entry.leaseExpiresAt instanceof Date &&
        entry.leaseExpiresAt.getTime() > Date.now(),
    ),
  );
  check(
    'racing consumed no retry budget',
    claimants.every((entry) => entry.attempts === 0 && entry.recoveries === 0),
  );

  const distinctClaimants = new Set(claimants.map((entry) => entry.claimedBy));
  console.log(
    `  INFO  work was spread across ${distinctClaimants.size} of ${dispatcherCount} dispatcher(s)` +
      ` — SKIP LOCKED distributes, it does not serialise`,
  );

  return distinctClaimants.size;
}

async function main() {
  const property = await prisma.property.findFirst({
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  if (property === null) throw new Error('No property found. Run pnpm db:seed first.');

  console.log(`Property under test: ${property.code} — ${property.name}`);
  console.log(`Run namespace: ${RUN}`);

  /**
   * Round 1: batch size >= row count.
   *
   * Every dispatcher wants the whole set, so this is the harshest form of the
   * race: without SKIP LOCKED they would all block on the same rows, and
   * without the atomic CTE they would all claim them.
   */
  const wide = await seedRows(property.id, 'wide', ROWS);
  await race('Round 1 — every dispatcher wants every row', wide, DISPATCHERS, ROWS);

  /**
   * Round 2: batch size smaller than the row count.
   *
   * The realistic shape, and the one that proves the work is *distributed*:
   * eight dispatchers taking ten each should clear sixty rows between them.
   */
  const narrow = await seedRows(property.id, 'narrow', ROWS);
  const spread = await race(
    'Round 2 — small batches, so the work must be shared',
    narrow,
    DISPATCHERS,
    Math.ceil(ROWS / DISPATCHERS) + 2,
  );
  check(
    'more than one dispatcher did work when batches were small',
    spread > 1,
    `${spread} dispatcher(s) claimed rows`,
  );

  /**
   * Round 3: the reaper, raced.
   *
   * Several dispatchers reclaiming the same expired leases must not
   * double-count `recoveries`, or a few restarts would inflate the counter
   * past the attempt budget and mislead whoever reads it.
   */
  console.log('\nRound 3 — concurrent reapers must not double-count recoveries');
  await prisma.outboxEvent.updateMany({
    where: { id: { in: wide } },
    data: {
      status: 'IN_FLIGHT',
      claimedAt: new Date(Date.now() - 600_000),
      leaseExpiresAt: new Date(Date.now() - 300_000),
      claimedBy: 'dead-worker',
    },
  });

  /**
   * Counted first, because `reapStaleLeases` is deliberately cross-property
   * and table-wide -- the same system-process exception CLAUDE.md section 3.2
   * grants night-audit orchestration. Comparing the sum against the rows that
   * were actually stale keeps the assertion exact without assuming this run
   * owns the whole table.
   */
  const [{ stale }] = await prisma.$queryRaw`
    SELECT count(*)::int AS stale
    FROM "outbox_event"
    WHERE "status" = 'IN_FLIGHT' AND "leaseExpiresAt" < now()
  `;

  const reapers = buildDispatchers(DISPATCHERS, ROWS);
  const reaped = await Promise.all(reapers.map(({ dispatcher }) => dispatcher.reapStaleLeases()));

  const afterReap = await prisma.outboxEvent.findMany({
    where: { id: { in: wide } },
    select: { status: true, recoveries: true, attempts: true },
  });
  check(
    'every row came back exactly once',
    afterReap.every((entry) => entry.recoveries === 1),
    `recoveries seen: ${[...new Set(afterReap.map((entry) => entry.recoveries))].join(', ')}`,
  );
  check(
    'all rows are PENDING again',
    afterReap.every((entry) => entry.status === 'PENDING'),
  );
  check(
    'and a worker dying still cost no retry budget',
    afterReap.every((entry) => entry.attempts === 0),
  );
  check(
    'the reap counts across reapers sum to exactly the stale rows — no double counting',
    reaped.reduce((total, count) => total + count, 0) === stale,
    `${reaped.join('+')} = ${reaped.reduce((a, b) => a + b, 0)} of ${stale} stale row(s)`,
  );
  check(
    'and the stale set was exactly the rows this round expired',
    stale === wide.length,
    `${stale} stale vs ${wide.length} expired`,
  );
}

async function teardown() {
  const { count } = await prisma.outboxEvent.deleteMany({
    where: { dedupeKey: { startsWith: `claimrace:${RUN}:` } },
  });
  console.log(`\nTeardown: removed ${count} outbox row(s) written by this run.`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error('\nSuite error:', error.message);
} finally {
  await teardown().catch((error) => {
    console.error('Teardown failed:', error.message);
  });
  await prisma.$disconnect();
}

console.log(
  failures === 0 ? '\nAll outbox claim-race checks passed.' : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
