/**
 * The outbox end-to-end suite — the only one that needs Redis.
 *
 * ===========================================================================
 * Everything else about the outbox is PostgreSQL-owned, by design.
 *
 * `outbox.test.mjs` proves the enqueue, the dedupe indexes, the claim, the
 * lease, the retry schedule, the dead letter and the CHECK constraints with a
 * fake queue, because requirement 3 puts the source of truth in PostgreSQL
 * and Redis holds nothing that cannot be rebuilt from it.
 *
 * What is left for this suite is exactly the part that *is* Redis: that a row
 * written by a producer gets picked up and handled with nobody calling
 * `process()` by hand, that a worker restart loses nothing, and that a job
 * surviving in Redis across a restart cannot re-run work the database has
 * already recorded as done.
 *
 * It needs a reachable Redis. If there is not one, it says so and fails
 * rather than passing quietly — a suite that skips itself in silence is how a
 * broken integration ships.
 *
 *   docker run -d --name easeit-redis -p 6379:6379 redis:7-alpine
 *
 * Checks, in order: a bare enqueue is drained end to end with no manual
 * stepping; the handler ran exactly once; a transient failure is retried to
 * success without intervention; a worker killed mid-handler leaves the row
 * recoverable and a second worker finishes it, once; and a job replayed from
 * Redis against an already-completed row is dropped rather than re-run.
 * ===========================================================================
 */

// Nest's decorators need the metadata polyfill, and it lives in the API's own
// node_modules rather than the root's under pnpm, so it is resolved by path.
await import(new URL('../../apps/api/node_modules/reflect-metadata/Reflect.js', import.meta.url));
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function loadEnvValue(name) {
  for (const relative of ['../../packages/database/.env', '../../apps/api/.env', '../../.env']) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
      const match = new RegExp(`^${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'm').exec(text);
      if (match?.[1]) return match[1];
    } catch {
      // Next candidate.
    }
  }
  return null;
}

process.env.DATABASE_URL ??= loadEnvValue('DATABASE_URL') ?? '';
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set and no .env was found. Run pnpm db:seed first.');
  process.exit(1);
}

const REDIS_URL = process.env.REDIS_URL ?? loadEnvValue('REDIS_URL') ?? 'redis://localhost:6379';

/* -------------------------------------------------------------------------- */
/*  Preflight — Redis must actually be there                                  */
/* -------------------------------------------------------------------------- */

/**
 * Checked with a plain socket before anything is loaded.
 *
 * ioredis retries a refused connection rather than failing, so asking BullMQ
 * first would hang for the full lease duration instead of reporting the real
 * problem.
 */
async function redisReachable(url, timeoutMs = 3_000) {
  const { createConnection } = await import('node:net');
  const parsed = new URL(url);
  const port = Number(parsed.port || 6379);
  const host = parsed.hostname || '127.0.0.1';

  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

if (!(await redisReachable(REDIS_URL))) {
  console.error(`\nNOT RUN — Redis is not reachable at ${REDIS_URL}.`);
  console.error('This suite is the one part of the outbox that genuinely needs Redis.');
  console.error('Start one and run it again:');
  console.error('  docker run -d --name easeit-redis -p 6379:6379 redis:7-alpine');
  console.error('\nThe PostgreSQL-owned behaviour is covered without Redis by:');
  console.error('  pnpm test:outbox');
  console.error('  pnpm test:outbox:concurrency');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;

const DIST = '../../apps/api/dist/modules/platform/outbox';
async function load(relative) {
  const loaded = await import(new URL(`${DIST}/${relative}`, import.meta.url));
  return Object.keys(loaded).some((key) => key !== 'default') ? loaded : (loaded.default ?? loaded);
}

const { OutboxService } = await load('outbox.service.js');
const { OutboxDispatcherService } = await load('outbox-dispatcher.service.js');
const { OutboxWorker } = await load('outbox.worker.js');
const { OutboxQueue } = await load('outbox.queue.js');
const { OutboxHandlerRegistry } = await load('outbox-handler.registry.js');
const { OutboxMetricsService } = await load('outbox-metrics.service.js');
const { OutboxSelfTestHandler } = await load('handlers/self-test.handler.js');

/**
 * BullMQ directly, for one job only: destroying the queue.
 *
 * `obliterate` is how this suite simulates total Redis state loss without
 * touching the container, which keeps the test honest about the thing it
 * claims -- that pending work is rediscovered from PostgreSQL -- rather than
 * about Docker.
 */
// The CJS build, not the ESM one: bullmq's ESM output uses extensionless
// directory imports that only resolve through a bundler, and Node refuses them.
const { Queue } = await import(
  new URL('../../apps/api/node_modules/bullmq/dist/cjs/index.js', import.meta.url)
);
const { OUTBOX_QUEUE_NAME } = await load('outbox.queue.js');

const prisma = createPrismaClient();
const prismaStub = { client: prisma, ping: async () => true };

const RUN = randomUUID().slice(0, 8);
const KEY = (suffix) => `redis-e2e:${RUN}:${suffix}`;

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function configStub(overrides = {}) {
  return {
    get(key, fallback) {
      if (key === 'REDIS_URL') return REDIS_URL;
      return key in overrides ? overrides[key] : fallback;
    },
  };
}

/** Builds one complete processing stack, as the worker process would. */
function buildRuntime(overrides = {}) {
  const config = configStub({
    OUTBOX_POLL_MS: 100,
    OUTBOX_BATCH_SIZE: 20,
    OUTBOX_LEASE_MS: 5_000,
    OUTBOX_CONCURRENCY: 4,
    OUTBOX_BACKOFF_BASE_MS: 100,
    OUTBOX_BACKOFF_MAX_MS: 500,
    OUTBOX_HANDLER_TIMEOUT_MS: 2_000,
    ...overrides,
  });

  const registry = new OutboxHandlerRegistry();
  const handler = new OutboxSelfTestHandler();
  registry.register(handler);
  const metrics = new OutboxMetricsService(prismaStub);
  const queue = new OutboxQueue(config);
  const dispatcher = new OutboxDispatcherService(prismaStub, queue, metrics, config);
  const worker = new OutboxWorker(prismaStub, registry, metrics, config);

  return { registry, handler, metrics, queue, dispatcher, worker };
}

async function shutdown(runtime) {
  await runtime.dispatcher.onModuleDestroy();
  await runtime.worker.onModuleDestroy();
  await runtime.queue.onModuleDestroy();
}

/** Polls the row until it reaches a terminal state, or gives up. */
async function waitForStatus(id, wanted, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await prisma.outboxEvent.findUnique({ where: { id } });
    if (current !== null && wanted.includes(current.status)) return current;
    if (Date.now() > deadline) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                     */
/* -------------------------------------------------------------------------- */

const runtimes = [];

async function main() {
  const property = await prisma.property.findFirst({
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  if (property === null) throw new Error('No property found. Run pnpm db:seed first.');

  console.log(`Property under test: ${property.code} — ${property.name}`);
  console.log(`Redis: ${REDIS_URL}`);
  console.log(`Run namespace: ${RUN}`);

  const outbox = new OutboxService(prismaStub);

  /* -- 1. End to end ----------------------------------------------------- */

  section('1. An enqueued event is drained with nobody stepping it along');

  const runtime = buildRuntime();
  runtimes.push(runtime);
  check('Redis answers through the queue', await runtime.queue.ping());

  runtime.worker.start();
  runtime.dispatcher.start();

  const plainNonce = `${RUN}-plain`;
  const plain = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: plainNonce },
    dedupeKey: KEY('plain'),
  });

  const plainRow = await waitForStatus(plain.id, ['SUCCEEDED', 'DEAD']);
  check(
    'the row reached SUCCEEDED on its own',
    plainRow?.status === 'SUCCEEDED' && plainRow.attempts === 1,
    `status=${plainRow?.status} attempts=${plainRow?.attempts}`,
  );
  check(
    'the handler ran exactly once',
    runtime.handler.runsFor(plainNonce).length === 1,
    `${runtime.handler.runsFor(plainNonce).length} run(s)`,
  );

  /* -- 2. Retry without intervention ------------------------------------- */

  section('2. A transient failure is retried to success by the loop itself');

  const retryNonce = `${RUN}-retry`;
  const retrying = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: retryNonce, failTimes: 2 },
    dedupeKey: KEY('retry'),
  });

  const retried = await waitForStatus(retrying.id, ['SUCCEEDED', 'DEAD']);
  check(
    'it succeeded on the third attempt',
    retried?.status === 'SUCCEEDED' && retried.attempts === 3,
    `status=${retried?.status} attempts=${retried?.attempts}`,
  );
  check(
    'and the handler saw all three',
    runtime.handler.runsFor(retryNonce).length === 3,
    `${runtime.handler.runsFor(retryNonce).length} run(s)`,
  );
  check(
    'the per-attempt job id meant each republish was a new job',
    retried?.recoveries === 0,
    `recoveries=${retried?.recoveries}`,
  );

  await shutdown(runtime);

  /* -- 3. Worker death, mid-handler -------------------------------------- */

  section('3. A worker killed mid-handler loses nothing');

  /**
   * The handler sleeps longer than the lease, and the worker is shut down
   * while it is sleeping. That is gap B from `outbox-dispatcher.service.ts`:
   * the side effect may have happened, and the row does not say so yet.
   *
   * The lease is what covers it. A second runtime reclaims the row and
   * finishes it — once — which is at-least-once delivery working as designed
   * rather than work being lost.
   */
  /**
   * The handler sleep, and the two runtimes sized around it.
   *
   * `dying` gets a short lease so the reclaim is quick, and a handler timeout
   * well above the sleep so the handler is genuinely still working when the
   * process is killed -- that is the scenario.
   *
   * `survivor` needs a handler timeout *above* the sleep too, because a
   * reclaimed attempt re-runs the handler from the start. An earlier version
   * left it at the 2s default, so the survivor's handler was killed by its own
   * timeout on every attempt and the row dead-lettered at attempt 5. The
   * scenario was contradictory, not the implementation -- and its lease is
   * sized at more than twice the timeout, which is what the env schema
   * requires of a real deployment.
   */
  const HANDLER_SLEEP_MS = 4_000;
  const dying = buildRuntime({ OUTBOX_LEASE_MS: 2_000, OUTBOX_HANDLER_TIMEOUT_MS: 30_000 });
  runtimes.push(dying);
  dying.worker.start();
  dying.dispatcher.start();

  const crashNonce = `${RUN}-crash`;
  const crashing = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: crashNonce, delayMs: HANDLER_SLEEP_MS },
    dedupeKey: KEY('crash'),
  });

  // Wait until it is genuinely in flight, then stop paying attention to it.
  const inFlight = await waitForStatus(crashing.id, ['IN_FLIGHT'], 5_000);
  check('the row was claimed and handed to a handler', inFlight?.status === 'IN_FLIGHT');

  await dying.dispatcher.onModuleDestroy();
  await dying.queue.onModuleDestroy();

  /**
   * The kill.
   *
   * `close(true)` is a forced close: it does not wait for the handler, does
   * not move the job to failed, and does not extend the lock. From the row's
   * point of view that is exactly `kill -9` -- a held lease and no process
   * coming back for it.
   *
   * It matters that the worker really stops rather than merely being ignored.
   * An earlier version only removed its listeners, and the still-running
   * BullMQ worker went on consuming jobs for the rest of the suite, so later
   * sections recorded their effects on a dead runtime's counters. A crashed
   * process does not keep taking work, and neither should this one.
   */
  const zombie = dying.worker.worker;
  await zombie?.close(true);
  dying.worker.worker = null;

  const survivor = buildRuntime({
    OUTBOX_LEASE_MS: 60_000,
    OUTBOX_HANDLER_TIMEOUT_MS: 20_000,
  });
  runtimes.push(survivor);
  survivor.worker.start();
  survivor.dispatcher.start();

  const recovered = await waitForStatus(crashing.id, ['SUCCEEDED', 'DEAD'], 30_000);
  check(
    'a second worker reclaimed and completed it',
    recovered?.status === 'SUCCEEDED',
    `status=${recovered?.status} attempts=${recovered?.attempts} recoveries=${recovered?.recoveries}`,
  );
  check(
    'the reclaim was counted as a recovery, not as a failed attempt',
    recovered?.recoveries >= 1 && recovered.attempts === 1,
    `recoveries=${recovered?.recoveries} attempts=${recovered?.attempts}`,
  );

  /**
   * The killed worker's handler is still asleep inside this Node process, and
   * will resolve and try to write an outcome. It holds a claim token that no
   * longer owns the row, so its write must affect nothing -- this is the
   * window the token guard in `outbox.worker.ts` exists for. Waiting it out
   * and re-reading is the only way to prove the guard holds.
   */
  await new Promise((resolve) => setTimeout(resolve, HANDLER_SLEEP_MS + 2_000));
  const afterZombieWrite = await prisma.outboxEvent.findUnique({ where: { id: crashing.id } });
  check(
    'the killed worker could not overwrite the outcome when it woke up',
    afterZombieWrite?.attempts === 1 &&
      afterZombieWrite.status === 'SUCCEEDED' &&
      afterZombieWrite.completedAt?.getTime() === recovered?.completedAt?.getTime(),
    `attempts=${afterZombieWrite?.attempts} status=${afterZombieWrite?.status}`,
  );

  await shutdown(survivor);

  /* -- 4. Bounded retries, end to end ------------------------------------ */

  section('4. A permanently failing handler exhausts a bounded budget');

  /**
   * The same dead-letter path `outbox.test.mjs` drives by hand, but here the
   * loop does every attempt itself: claim, publish, fail, reschedule,
   * republish, and finally DEAD. That is what proves the budget is actually
   * bounded in a running system rather than only in a stepped test -- a
   * mistake here is an infinite retry loop against a provider.
   */
  const lettering = buildRuntime({
    OUTBOX_LEASE_MS: 5_000,
    OUTBOX_BACKOFF_BASE_MS: 50,
    OUTBOX_BACKOFF_MAX_MS: 200,
  });
  runtimes.push(lettering);
  lettering.worker.start();
  lettering.dispatcher.start();

  const deadNonce = `${RUN}-dead`;
  const dyingEvent = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: deadNonce, failForever: true },
    dedupeKey: KEY('dead'),
    maxAttempts: 3,
  });

  const deadRow = await waitForStatus(dyingEvent.id, ['DEAD', 'SUCCEEDED'], 20_000);
  check(
    'it reached DEAD, not SUCCEEDED and not a loop',
    deadRow?.status === 'DEAD',
    `status=${deadRow?.status}`,
  );
  check(
    'after exactly its budget of attempts',
    deadRow?.attempts === 3 && deadRow.maxAttempts === 3,
    `attempts=${deadRow?.attempts}/${deadRow?.maxAttempts}`,
  );
  check(
    'the handler was called exactly that many times, not more',
    lettering.handler.runsFor(deadNonce).length === 3,
    `${lettering.handler.runsFor(deadNonce).length} run(s)`,
  );
  check(
    'with a completion time and a retained reason',
    deadRow?.completedAt !== null && typeof deadRow?.lastError === 'string',
    String(deadRow?.lastError).slice(0, 60),
  );

  // Nothing further must happen to it. A dead letter that quietly resumes is
  // worse than one that stays dead.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const stillDead = await prisma.outboxEvent.findUnique({ where: { id: dyingEvent.id } });
  check(
    'and it stays dead — the loop does not pick it up again',
    stillDead?.status === 'DEAD' && stillDead.attempts === 3,
    `status=${stillDead?.status} attempts=${stillDead?.attempts}`,
  );

  await shutdown(lettering);

  /* -- 5. Total Redis state loss ----------------------------------------- */

  section('5. Work survives losing the entire queue');

  /**
   * Requirement 3, tested rather than asserted: Redis holds nothing that
   * cannot be rebuilt from PostgreSQL.
   *
   * A row is claimed, so its job exists in Redis and the row says IN_FLIGHT.
   * Then the queue is obliterated -- the job is simply gone, which is what a
   * flushed cache, an evicted key or a wiped Redis instance looks like. No
   * amount of waiting will deliver that job.
   *
   * The lease is the only thing standing between that and lost work.
   */
  const lossy = buildRuntime({ OUTBOX_LEASE_MS: 2_000 });
  runtimes.push(lossy);

  const lossNonce = `${RUN}-loss`;
  const lost = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: lossNonce },
    dedupeKey: KEY('loss'),
  });

  // Claimed and published, with no worker running to consume it.
  const published = await lossy.dispatcher.publishDue();
  const claimed = await prisma.outboxEvent.findUnique({ where: { id: lost.id } });
  check(
    'the row is claimed and its job is in Redis',
    published >= 1 && claimed?.status === 'IN_FLIGHT',
    `published=${published} status=${claimed?.status}`,
  );

  const destroyer = new Queue(OUTBOX_QUEUE_NAME, { connection: { url: REDIS_URL } });
  await destroyer.obliterate({ force: true });
  const remaining = await destroyer.getJobCountByTypes('waiting', 'delayed', 'active', 'failed');
  await destroyer.close();
  check(
    'the queue is then empty — the job is genuinely gone',
    remaining === 0,
    `${remaining} job(s) left in Redis`,
  );

  // Only now is anything started. There is no job to find; the row is the
  // only remaining evidence that the work exists.
  lossy.worker.start();
  lossy.dispatcher.start();

  const rebuilt = await waitForStatus(lost.id, ['SUCCEEDED', 'DEAD'], 25_000);
  check(
    'the work was rediscovered from PostgreSQL and completed',
    rebuilt?.status === 'SUCCEEDED',
    `status=${rebuilt?.status} attempts=${rebuilt?.attempts} recoveries=${rebuilt?.recoveries}`,
  );
  check(
    'via the lease, so losing Redis cost a recovery and no retry budget',
    rebuilt?.recoveries >= 1 && rebuilt.attempts === 1,
    `recoveries=${rebuilt?.recoveries} attempts=${rebuilt?.attempts}`,
  );
  check(
    'and the handler ran exactly once despite the loss',
    lossy.handler.runsFor(lossNonce).length === 1,
    `${lossy.handler.runsFor(lossNonce).length} run(s)`,
  );

  await shutdown(lossy);

  /* -- 6. Replay from Redis ---------------------------------------------- */

  section('6. A job replayed from Redis against a finished row is dropped');

  /**
   * Redis is not transactional with PostgreSQL, so a job can outlive the row's
   * completion — a slow consumer, a restart, a manual retry from Bull Board.
   * Publishing the finished row again is the sharpest version of that, and the
   * worker must refuse it on the row's status rather than call the handler.
   */
  const replayer = buildRuntime();
  runtimes.push(replayer);
  replayer.worker.start();

  const finished = await prisma.outboxEvent.findUnique({ where: { id: plain.id } });
  const droppedBefore = replayer.metrics.duplicatesDroppedCount;
  const handlerRunsBefore = replayer.handler.allRuns.length;

  await replayer.queue.publish({
    id: finished.id,
    propertyId: finished.propertyId,
    eventType: finished.eventType,
    payloadVersion: finished.payloadVersion,
    attempts: 99,
    recoveries: 99,
  });

  // Give the consumer a moment; there is nothing to poll for, since a correct
  // outcome is "nothing happened".
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const stillFinished = await prisma.outboxEvent.findUnique({ where: { id: plain.id } });
  check(
    'the row is untouched',
    stillFinished?.status === 'SUCCEEDED' && stillFinished.attempts === 1,
    `status=${stillFinished?.status} attempts=${stillFinished?.attempts}`,
  );
  check(
    'the handler was not called again',
    replayer.handler.allRuns.length === handlerRunsBefore,
    `${replayer.handler.allRuns.length} vs ${handlerRunsBefore} run(s)`,
  );
  check(
    'and the drop was counted',
    replayer.metrics.duplicatesDroppedCount > droppedBefore,
    `duplicatesDropped ${droppedBefore} -> ${replayer.metrics.duplicatesDroppedCount}`,
  );

  await shutdown(replayer);

  /* -- 7. Concurrency ---------------------------------------------------- */

  section('7. The worker really works in parallel');

  /**
   * `OUTBOX_CONCURRENCY` is only worth having if it does something. Eight
   * events that each sleep 400ms take 3.2s one at a time and about 800ms four
   * at a time, so the wall clock distinguishes them without needing to inspect
   * BullMQ's internals.
   */
  const parallel = buildRuntime({ OUTBOX_CONCURRENCY: 4, OUTBOX_HANDLER_TIMEOUT_MS: 10_000 });
  runtimes.push(parallel);

  const SLEEP_MS = 400;
  const BATCH = 8;
  const parallelIds = [];
  for (let index = 0; index < BATCH; index += 1) {
    const result = await outbox.enqueueStandalone({
      propertyId: property.id,
      eventType: 'OUTBOX_SELF_TEST',
      payload: { nonce: `${RUN}-par-${index}`, delayMs: SLEEP_MS },
      dedupeKey: KEY(`par-${index}`),
    });
    parallelIds.push(result.id);
  }

  const startedAt = Date.now();
  parallel.worker.start();
  parallel.dispatcher.start();

  for (;;) {
    const done = await prisma.outboxEvent.count({
      where: { id: { in: parallelIds }, status: { in: ['SUCCEEDED', 'DEAD'] } },
    });
    if (done === BATCH || Date.now() - startedAt > 20_000) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const elapsed = Date.now() - startedAt;

  const parallelRows = await prisma.outboxEvent.findMany({
    where: { id: { in: parallelIds } },
    select: { status: true, attempts: true },
  });
  check(
    'all eight succeeded',
    parallelRows.length === BATCH &&
      parallelRows.every((entry) => entry.status === 'SUCCEEDED' && entry.attempts === 1),
    `${parallelRows.filter((entry) => entry.status === 'SUCCEEDED').length}/${BATCH}`,
  );
  check(
    `and in well under the ${String((BATCH * SLEEP_MS) / 1000)}s a serial worker would take`,
    elapsed < BATCH * SLEEP_MS,
    `${String(elapsed)}ms for ${String(BATCH)} x ${String(SLEEP_MS)}ms at concurrency 4`,
  );

  await shutdown(parallel);

  /* -- 8. Graceful shutdown ---------------------------------------------- */

  section('8. Shutting down mid-flight strands nothing');

  /**
   * Windows has no deliverable SIGTERM -- `Stop-Process` is a hard kill and
   * `process.kill` terminates unconditionally -- so the signal path cannot be
   * exercised from outside the process. What *can* be exercised is the thing
   * the signal handler calls: `onModuleDestroy` on each component, in the
   * order Nest's shutdown hooks call them.
   *
   * The requirement is not that an in-flight job finishes. It is that the row
   * is never **stuck**: either it completed, or it still holds a lease that
   * will expire and bring it back. Those are the only two acceptable outcomes.
   */
  const closing = buildRuntime({ OUTBOX_LEASE_MS: 4_000, OUTBOX_HANDLER_TIMEOUT_MS: 1_500 });
  runtimes.push(closing);
  closing.worker.start();
  closing.dispatcher.start();

  const shutdownNonce = `${RUN}-shutdown`;
  const interrupted = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: shutdownNonce, delayMs: 1_200 },
    dedupeKey: KEY('shutdown'),
  });

  await waitForStatus(interrupted.id, ['IN_FLIGHT'], 5_000);
  await shutdown(closing);

  const atShutdown = await prisma.outboxEvent.findUnique({ where: { id: interrupted.id } });
  const terminal = atShutdown?.status === 'SUCCEEDED' || atShutdown?.status === 'DEAD';
  const recoverable =
    atShutdown?.status === 'IN_FLIGHT' && atShutdown.leaseExpiresAt instanceof Date;
  check(
    'after shutdown the row is either finished or still leased — never stuck',
    terminal || recoverable,
    `status=${atShutdown?.status} lease=${atShutdown?.leaseExpiresAt?.toISOString() ?? 'none'}`,
  );
  check(
    'a graceful close waited for the handler rather than abandoning it',
    terminal,
    terminal ? 'the in-flight job completed before close returned' : 'left for the reaper',
  );

  // Whichever it was, a fresh process must end up with the work done and the
  // handler having run once in total.
  const resumed = buildRuntime({ OUTBOX_LEASE_MS: 30_000, OUTBOX_HANDLER_TIMEOUT_MS: 10_000 });
  runtimes.push(resumed);
  resumed.worker.start();
  resumed.dispatcher.start();

  const afterRestart = await waitForStatus(interrupted.id, ['SUCCEEDED', 'DEAD'], 20_000);
  check(
    'and a restarted worker leaves it SUCCEEDED',
    afterRestart?.status === 'SUCCEEDED',
    `status=${afterRestart?.status} attempts=${afterRestart?.attempts} recoveries=${afterRestart?.recoveries}`,
  );

  await shutdown(resumed);

  /* -- 9. Nothing stranded ----------------------------------------------- */

  section('9. Nothing from this run is left waiting, and the books balance');

  const leftovers = await prisma.outboxEvent.findMany({
    where: { dedupeKey: { startsWith: `redis-e2e:${RUN}:` } },
    select: { status: true, dedupeKey: true, leaseExpiresAt: true, claimedBy: true },
  });
  check(
    'every row this run wrote reached a terminal state',
    leftovers.every((entry) => entry.status === 'SUCCEEDED' || entry.status === 'DEAD'),
    `${leftovers.length} row(s): ` +
      [...new Set(leftovers.map((entry) => entry.status))].sort().join(' + '),
  );
  check(
    'exactly one of them is a dead letter',
    leftovers.filter((entry) => entry.status === 'DEAD').length === 1,
    `${leftovers.filter((entry) => entry.status === 'DEAD').length} dead`,
  );
  check(
    'and no lease is left held',
    leftovers.every((entry) => entry.leaseExpiresAt === null && entry.claimedBy === null),
  );
}

async function teardown() {
  for (const runtime of runtimes) {
    await shutdown(runtime).catch(() => null);
  }
  const { count } = await prisma.outboxEvent.deleteMany({
    where: { dedupeKey: { startsWith: `redis-e2e:${RUN}:` } },
  });
  console.log(`\nTeardown: removed ${count} outbox row(s) and closed every runtime.`);
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
  failures === 0 ? '\nAll outbox end-to-end checks passed.' : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
