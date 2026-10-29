/**
 * The transactional outbox suite.
 *
 * ===========================================================================
 * Runs against a real Postgres, through the real compiled services.
 *
 * CLAUDE.md section 5: "in-memory fakes cannot prove constraint behaviour,
 * which is where our correctness guarantees actually live." That applies here
 * more than almost anywhere else, because the outbox's two hardest claims are
 * both enforced by the database and by nothing else:
 *
 *   * `outbox_event_coalesce_one_pending_per_key` — a partial unique index on
 *     PENDING rows only, which is what makes coalescing a *merge* rather than
 *     a read-then-write race.
 *   * `outbox_event_unique_forever_per_key` — unconditional, which is what
 *     makes "send this once" actually mean once.
 *
 * It imports the compiled services from `apps/api/dist` rather than
 * reimplementing them, with only `PrismaService` and `ConfigService` stubbed.
 * The SQL under test — the claiming CTE, the reaper's single UPDATE, the
 * failure writes — is therefore the exact SQL the worker runs in production.
 *
 * Redis is NOT required: the queue is replaced with a recording fake. That is
 * deliberate, not a shortcut. Everything asserted here is PostgreSQL-owned by
 * design (requirement 3: Redis state must be recoverable from the database),
 * so a suite that needed Redis to prove it would be evidence the design had
 * leaked. The Redis-dependent end-to-end path is a separate matter and is
 * reported as such.
 *
 * What it asserts, in order: enqueue is atomic with its transaction and leaves
 * nothing behind on rollback; COALESCE merges while PENDING and does *not*
 * suppress forever; UNIQUE_FOREVER does suppress forever; a malformed payload
 * is refused at the boundary with field paths and no values; the dispatcher's
 * claim writes a lease without spending retry budget; a failed publish is
 * released; an expired lease is reclaimed as a recovery, never as an attempt;
 * a handler runs once on success and a redelivered job is dropped; a transient
 * failure is rescheduled with growing jitter; a budget runs out into DEAD; a
 * permanent failure dead-letters on the first attempt; error metadata carries
 * no payload; and the CHECK constraints refuse incoherent rows.
 *
 * Every row it creates is removed in teardown, including on failure.
 * ===========================================================================
 */

// Nest's decorators need the metadata polyfill, and it lives in the API's own
// node_modules rather than the root's under pnpm, so it is resolved by path.
await import(new URL('../../apps/api/node_modules/reflect-metadata/Reflect.js', import.meta.url));
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Same resolution as the check-in suite: the repo's `.env`, then the root one. */
function loadDatabaseEnv() {
  for (const relative of ['../../packages/database/.env', '../../.env']) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
      const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m.exec(text);
      if (match?.[1]) return match[1];
    } catch {
      // Next candidate. A missing file here is ordinary, not an error.
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

const { OutboxService } = await load('outbox.service.js');
const { OutboxDispatcherService } = await load('outbox-dispatcher.service.js');
const { OutboxWorker } = await load('outbox.worker.js');
const { OutboxHandlerRegistry } = await load('outbox-handler.registry.js');
const { OutboxMetricsService } = await load('outbox-metrics.service.js');
const { OutboxSelfTestHandler } = await load('handlers/self-test.handler.js');

const prisma = createPrismaClient();

/**
 * The isolation guard, shared with every other destructive suite.
 *
 * Imported here rather than relied upon from the release gate: this file is
 * reachable directly through its own npm script, and run that way the gate's
 * preflight never executes. See `test/support/isolation-guard.mjs`.
 */
const { assertIsolatedDatabase } = await import('../support/isolation-guard.mjs');

/** Namespaces every dedupeKey this run writes, so teardown is exact. */
const RUN = randomUUID().slice(0, 8);
const KEY = (suffix) => `selftest:${RUN}:${suffix}`;

let failures = 0;

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

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

/** The slice of PrismaService the outbox services use. */
const prismaStub = { client: prisma, ping: async () => true };

/** A ConfigService stand-in over a plain object, defaults included. */
function configStub(overrides = {}) {
  return {
    get(key, fallback) {
      return key in overrides ? overrides[key] : fallback;
    },
  };
}

/**
 * The queue, faked.
 *
 * Records what would have been published, and can be told to throw so the
 * publish-failure path is reachable without breaking Redis on purpose.
 */
function fakeQueue() {
  return {
    published: [],
    throwNext: false,
    async publish(row) {
      if (this.throwNext) {
        this.throwNext = false;
        throw new Error('fake redis is unreachable');
      }
      this.published.push({ ...row, jobId: `${row.id}:${row.attempts}:${row.recoveries}` });
    },
    async ping() {
      return true;
    },
    async depth() {
      return { waiting: this.published.length, active: 0, failed: 0 };
    },
  };
}

function row(id) {
  return prisma.outboxEvent.findUnique({ where: { id } });
}

function byKey(dedupeKey) {
  return prisma.outboxEvent.findMany({ where: { dedupeKey }, orderBy: { createdAt: 'asc' } });
}

/**
 * A job as BullMQ would hand it over. Only the data matters to the worker.
 *
 * `claimToken` is taken from the row's current `claimedBy`, which is what the
 * dispatcher puts in the real job. Passing something else is how a *stale* job
 * is simulated, and `staleJob` below does exactly that.
 */
function job(rowRecord, attempt) {
  return {
    id: `${rowRecord.id}:${attempt - 1}:0`,
    data: {
      outboxEventId: rowRecord.id,
      propertyId: rowRecord.propertyId,
      eventType: rowRecord.eventType,
      payloadVersion: rowRecord.payloadVersion,
      attempt,
      claimToken: rowRecord.claimedBy,
    },
  };
}

/** A job carrying a claim token that no longer owns the row. */
function staleJob(rowRecord, attempt) {
  const stale = job(rowRecord, attempt);
  stale.data.claimToken = 'a-worker-that-lost-its-lease';
  return stale;
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  // Before any fixture is created, mutated or deleted.
  await assertIsolatedDatabase({ prisma, suite: 'the outbox suite' });

  const property = await prisma.property.findFirst({
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  if (property === null) throw new Error('No property found. Run pnpm db:seed first.');

  console.log(`Property under test: ${property.code} — ${property.name}`);
  console.log(`Run namespace: ${RUN}\n`);

  const outbox = new OutboxService(prismaStub);
  const registry = new OutboxHandlerRegistry();
  const handler = new OutboxSelfTestHandler();
  registry.register(handler);
  const metrics = new OutboxMetricsService(prismaStub);
  const queue = fakeQueue();
  const dispatcher = new OutboxDispatcherService(
    prismaStub,
    queue,
    metrics,
    configStub({ OUTBOX_BATCH_SIZE: 100, OUTBOX_LEASE_MS: 60_000 }),
  );
  const worker = new OutboxWorker(
    prismaStub,
    registry,
    metrics,
    configStub({ OUTBOX_BACKOFF_BASE_MS: 50, OUTBOX_BACKOFF_MAX_MS: 1_000 }),
  );

  /* -- 1. Atomicity ------------------------------------------------------ */

  section('1. The enqueue shares the caller\'s transaction');

  const committedKey = KEY('committed');
  const committed = await prisma.$transaction(async (tx) =>
    outbox.enqueue(tx, {
      propertyId: property.id,
      eventType: 'OUTBOX_SELF_TEST',
      payload: { nonce: `${RUN}-committed` },
      dedupeKey: committedKey,
    }),
  );

  check('a committed transaction leaves the row', committed.outcome === 'created', committed.outcome);

  const committedRow = await row(committed.id);
  check(
    'the new row starts PENDING with no attempts spent',
    committedRow?.status === 'PENDING' && committedRow.attempts === 0 && committedRow.recoveries === 0,
    `status=${committedRow?.status} attempts=${committedRow?.attempts}`,
  );
  check(
    'defaults are applied: version stamped, availableAt set, nothing terminal',
    committedRow?.payloadVersion === 1 &&
      committedRow.availableAt instanceof Date &&
      committedRow.completedAt === null &&
      committedRow.leaseExpiresAt === null,
    `version=${committedRow?.payloadVersion}`,
  );

  const rolledBackKey = KEY('rolled-back');
  await prisma
    .$transaction(async (tx) => {
      await outbox.enqueue(tx, {
        propertyId: property.id,
        eventType: 'OUTBOX_SELF_TEST',
        payload: { nonce: `${RUN}-rolled-back` },
        dedupeKey: rolledBackKey,
      });
      // The business change fails *after* the event was recorded. This is the
      // scenario the whole pattern exists for: there must be no promise to
      // publish a booking that never happened.
      throw new Error('deliberate rollback');
    })
    .catch(() => null);

  check(
    'a rolled-back transaction leaves no row at all',
    (await byKey(rolledBackKey)).length === 0,
  );

  /* -- 2. COALESCE ------------------------------------------------------- */

  section('2. COALESCE merges while PENDING, and is not permanent idempotency');

  const coalesceKey = KEY('coalesce');
  const first = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-coalesce-1` },
    dedupeKey: coalesceKey,
  });
  const second = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-coalesce-2` },
    dedupeKey: coalesceKey,
  });
  const third = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-coalesce-3` },
    dedupeKey: coalesceKey,
  });

  check(
    'three enqueues of one key produce one created and two coalesced',
    first.outcome === 'created' && second.outcome === 'coalesced' && third.outcome === 'coalesced',
    `${first.outcome}, ${second.outcome}, ${third.outcome}`,
  );

  const coalesced = await byKey(coalesceKey);
  check('and exactly one row exists', coalesced.length === 1, `${coalesced.length} row(s)`);
  check(
    'the surviving row carries the NEWEST payload, not the first',
    coalesced[0]?.payload?.nonce === `${RUN}-coalesce-3`,
    String(coalesced[0]?.payload?.nonce),
  );

  // The partial index covers PENDING only. Once a row is terminal the key is
  // free again — which is the point: "push the latest ARI for this window"
  // must be enqueueable again tomorrow.
  await prisma.outboxEvent.update({
    where: { id: coalesced[0].id },
    data: { status: 'SUCCEEDED', completedAt: new Date() },
  });
  const afterTerminal = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-coalesce-4` },
    dedupeKey: coalesceKey,
  });
  check(
    'the same key enqueues again once the previous row is terminal',
    afterTerminal.outcome === 'created',
    afterTerminal.outcome,
  );

  /* -- 3. UNIQUE_FOREVER ------------------------------------------------- */

  section('3. UNIQUE_FOREVER suppresses forever');

  const onceKey = KEY('once');
  const once1 = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-once-1` },
    dedupeKey: onceKey,
    dedupeMode: 'UNIQUE_FOREVER',
  });
  const once2 = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-once-2` },
    dedupeKey: onceKey,
    dedupeMode: 'UNIQUE_FOREVER',
  });

  check(
    'a second enqueue is suppressed rather than failing',
    once1.outcome === 'created' && once2.outcome === 'suppressed',
    `${once1.outcome}, ${once2.outcome}`,
  );
  check('one row only', (await byKey(onceKey)).length === 1);

  await prisma.outboxEvent.update({
    where: { id: once1.id },
    data: { status: 'SUCCEEDED', completedAt: new Date() },
  });
  const once3 = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-once-3` },
    dedupeKey: onceKey,
    dedupeMode: 'UNIQUE_FOREVER',
  });
  check(
    'still suppressed after the first row succeeded — unlike COALESCE',
    once3.outcome === 'suppressed' && (await byKey(onceKey)).length === 1,
    once3.outcome,
  );

  /* -- 4. Validation at the boundary ------------------------------------- */

  section('4. A malformed payload never reaches the table');

  const SECRET = 'guest-pii-must-not-appear-in-errors';
  const badKey = KEY('malformed');
  let validationError = null;
  try {
    await outbox.enqueueStandalone({
      propertyId: property.id,
      eventType: 'OUTBOX_SELF_TEST',
      // `nonce` must be a non-empty string; `failTimes` must be an integer.
      payload: { nonce: '', failTimes: SECRET },
      dedupeKey: badKey,
    });
  } catch (error) {
    validationError = error;
  }

  check('the enqueue throws', validationError !== null, validationError?.constructor?.name);
  check('and writes nothing', (await byKey(badKey)).length === 0);

  const serialised = JSON.stringify({
    message: validationError?.message,
    details: validationError?.details,
  });
  check(
    'the error names the offending FIELDS',
    serialised.includes('payload.nonce') && serialised.includes('payload.failTimes'),
    serialised.slice(0, 120),
  );
  check(
    'and does not echo the offending VALUE',
    !serialised.includes(SECRET),
    'no payload value in the error',
  );

  /* -- 5. Claiming ------------------------------------------------------- */

  section('5. The dispatcher claims with a lease, not a lock');

  const claimKey = KEY('claim');
  const toClaim = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-claim` },
    dedupeKey: claimKey,
  });

  const publishedCount = await dispatcher.publishDue();
  check('publishDue claims and publishes', publishedCount >= 1, `${publishedCount} published`);

  const claimedRow = await row(toClaim.id);
  check(
    'the claimed row is IN_FLIGHT with a future lease and a named claimant',
    claimedRow?.status === 'IN_FLIGHT' &&
      claimedRow.leaseExpiresAt instanceof Date &&
      claimedRow.leaseExpiresAt.getTime() > Date.now() &&
      typeof claimedRow.claimedBy === 'string' &&
      claimedRow.claimedBy.length > 0,
    `status=${claimedRow?.status} claimedBy=${claimedRow?.claimedBy}`,
  );
  check(
    'claiming spends no retry budget',
    claimedRow?.attempts === 0 && claimedRow.recoveries === 0,
    `attempts=${claimedRow?.attempts} recoveries=${claimedRow?.recoveries}`,
  );

  /**
   * A freshly claimed row must not look stale. This is a regression guard for
   * a bug found while writing this suite: the driver was storing JS `Date`
   * values shifted by the session's UTC offset, so `leaseExpiresAt < now()`
   * was true for a lease with 60 seconds left, and the reaper reclaimed every
   * healthy in-flight row on its next tick -- delivering every side effect
   * again and again. `client-factory.ts` pins the session to UTC and the
   * lease is now computed by the database itself; this check fails loudly if
   * either protection is removed.
   */
  const staleNow = await prisma.$queryRaw`
    SELECT count(*)::int AS stale
    FROM "outbox_event"
    WHERE "status" = 'IN_FLIGHT' AND "leaseExpiresAt" < now()
  `;
  check(
    'a lease taken one moment ago is not already expired',
    staleNow[0].stale === 0,
    `${staleNow[0].stale} stale lease(s) immediately after claiming`,
  );
  check(
    'and the backlog view agrees',
    (await metrics.backlog()).staleLeases === 0,
  );

  const publishedJob = queue.published.find((entry) => entry.id === toClaim.id);
  check(
    'the job id is per attempt, not per row',
    publishedJob?.jobId === `${toClaim.id}:0:0`,
    String(publishedJob?.jobId),
  );
  check(
    'the job carries identifiers only — no payload travels through Redis',
    publishedJob !== undefined && !('payload' in publishedJob),
  );

  /* -- 6. Publish failure ------------------------------------------------ */

  section('6. A failed publish is released, not stranded');

  // Return the claimed row to PENDING so it is due again, then break Redis.
  await prisma.outboxEvent.update({
    where: { id: toClaim.id },
    data: { status: 'PENDING', claimedAt: null, leaseExpiresAt: null, claimedBy: null },
  });
  queue.throwNext = true;
  await dispatcher.publishDue();

  const released = await row(toClaim.id);
  check(
    'the row is back to PENDING after the publish threw',
    released?.status === 'PENDING' && released.leaseExpiresAt === null,
    `status=${released?.status}`,
  );
  check(
    'and a broken queue did not consume an attempt',
    released?.attempts === 0,
    `attempts=${released?.attempts}`,
  );

  /* -- 7. Stale lease recovery ------------------------------------------- */

  section('7. An expired lease is a recovery, never an attempt');

  await prisma.outboxEvent.update({
    where: { id: toClaim.id },
    data: {
      status: 'IN_FLIGHT',
      claimedAt: new Date(Date.now() - 600_000),
      // Simulates the process dying between the claim and the publish (gap A),
      // or between the handler succeeding and the row being written (gap B).
      leaseExpiresAt: new Date(Date.now() - 300_000),
      claimedBy: 'dead-worker-1234',
    },
  });

  const reaped = await dispatcher.reapStaleLeases();
  const recoveredRow = await row(toClaim.id);
  check('the reaper reclaims it', reaped >= 1, `${reaped} reclaimed`);
  check(
    'back to PENDING with the claim cleared',
    recoveredRow?.status === 'PENDING' &&
      recoveredRow.claimedBy === null &&
      recoveredRow.leaseExpiresAt === null,
    `status=${recoveredRow?.status}`,
  );
  check(
    'recoveries incremented and attempts untouched',
    recoveredRow?.recoveries === 1 && recoveredRow.attempts === 0,
    `recoveries=${recoveredRow?.recoveries} attempts=${recoveredRow?.attempts}`,
  );

  /* -- 8. Handling, and duplicate delivery ------------------------------- */

  section('8. A handler runs once, and a redelivered job is dropped');

  await dispatcher.publishDue();
  const toHandle = await row(toClaim.id);
  await worker.process(job(toHandle, toHandle.attempts + 1));

  const succeeded = await row(toClaim.id);
  check(
    'the row is SUCCEEDED with the lease cleared and an attempt counted',
    succeeded?.status === 'SUCCEEDED' &&
      succeeded.attempts === 1 &&
      succeeded.completedAt instanceof Date &&
      succeeded.leaseExpiresAt === null &&
      succeeded.lastError === null,
    `status=${succeeded?.status} attempts=${succeeded?.attempts}`,
  );
  check(
    'the handler ran exactly once',
    handler.allRuns.filter((entry) => entry.outboxEventId === toClaim.id).length === 1,
  );

  const droppedBefore = metrics.duplicatesDroppedCount;
  await worker.process(job(succeeded, 2));
  check(
    'redelivering the same job is a no-op, not a second side effect',
    handler.allRuns.filter((entry) => entry.outboxEventId === toClaim.id).length === 1 &&
      metrics.duplicatesDroppedCount === droppedBefore + 1,
    `duplicatesDropped ${droppedBefore} -> ${metrics.duplicatesDroppedCount}`,
  );

  /**
   * The claim token, not just the status.
   *
   * After a lease expiry a row goes PENDING and straight back to IN_FLIGHT
   * under a *new* claim. A job carrying the old token looks perfectly current
   * to a status-only check, so the token is what distinguishes "my claim" from
   * "somebody else's claim".
   */
  const reclaimKey = KEY('token-guard');
  const guarded = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-token-guard` },
    dedupeKey: reclaimKey,
  });
  await dispatcher.publishDue();
  const underNewClaim = await row(guarded.id);
  const droppedBeforeStale = metrics.duplicatesDroppedCount;
  await worker.process(staleJob(underNewClaim, 1));

  const untouched = await row(guarded.id);
  check(
    'a job holding a superseded claim token is refused, though the row IS in flight',
    untouched?.status === 'IN_FLIGHT' &&
      untouched.attempts === 0 &&
      handler.runsFor(`${RUN}-token-guard`).length === 0 &&
      metrics.duplicatesDroppedCount === droppedBeforeStale + 1,
    `status=${untouched?.status} attempts=${untouched?.attempts} ` +
      `handlerRuns=${handler.runsFor(`${RUN}-token-guard`).length}`,
  );

  // Handed the right token, the very same row processes normally.
  await worker.process(job(underNewClaim, 1));
  const finally_ = await row(guarded.id);
  check(
    'and the correct token processes that same row',
    finally_?.status === 'SUCCEEDED' && handler.runsFor(`${RUN}-token-guard`).length === 1,
    `status=${finally_?.status}`,
  );

  /* -- 9. Transient failure and retry ------------------------------------ */

  section('9. A transient failure is rescheduled, with the budget in PostgreSQL');

  const retryKey = KEY('retry');
  const retrying = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-retry`, failTimes: 1 },
    dedupeKey: retryKey,
  });

  await dispatcher.publishDue();
  let retryRow = await row(retrying.id);
  const beforeFailure = Date.now();
  await worker.process(job(retryRow, retryRow.attempts + 1));

  retryRow = await row(retrying.id);
  check(
    'it returns to PENDING with one attempt spent',
    retryRow?.status === 'PENDING' && retryRow.attempts === 1,
    `status=${retryRow?.status} attempts=${retryRow?.attempts}`,
  );
  check(
    'the next attempt is scheduled in the future — the schedule lives in the row',
    retryRow?.availableAt instanceof Date && retryRow.availableAt.getTime() >= beforeFailure,
    `availableAt=${retryRow?.availableAt?.toISOString()}`,
  );
  check(
    'the failure reason is recorded, bounded, and free of payload',
    typeof retryRow?.lastError === 'string' &&
      retryRow.lastError.length > 0 &&
      retryRow.lastError.length <= 500 &&
      !retryRow.lastError.includes(`${RUN}-retry`) &&
      retryRow.lastErrorAt instanceof Date,
    `lastError=${String(retryRow?.lastError).slice(0, 80)}`,
  );

  // Make it due now rather than sleeping out the backoff: the schedule has
  // already been asserted above, and waiting would only test setTimeout.
  await prisma.outboxEvent.update({
    where: { id: retrying.id },
    data: { availableAt: new Date(Date.now() - 1_000) },
  });
  await dispatcher.publishDue();
  retryRow = await row(retrying.id);
  await worker.process(job(retryRow, retryRow.attempts + 1));

  retryRow = await row(retrying.id);
  check(
    'the second attempt succeeds and the attempt count is cumulative',
    retryRow?.status === 'SUCCEEDED' && retryRow.attempts === 2,
    `status=${retryRow?.status} attempts=${retryRow?.attempts}`,
  );
  check(
    'and the handler saw both attempts',
    handler.runsFor(`${RUN}-retry`).length === 2,
    `${handler.runsFor(`${RUN}-retry`).length} run(s)`,
  );

  /* -- 10. Exhausting the budget ----------------------------------------- */

  section('10. An exhausted budget dead-letters, durably');

  const deadKey = KEY('dead');
  const dying = await outbox.enqueueStandalone({
    propertyId: property.id,
    eventType: 'OUTBOX_SELF_TEST',
    payload: { nonce: `${RUN}-dead`, failForever: true },
    dedupeKey: deadKey,
    maxAttempts: 2,
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await prisma.outboxEvent.updateMany({
      where: { id: dying.id, status: 'PENDING' },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    await dispatcher.publishDue();
    const current = await row(dying.id);
    if (current.status !== 'IN_FLIGHT') break;
    await worker.process(job(current, current.attempts + 1));
  }

  const dead = await row(dying.id);
  check(
    'the row is DEAD after exactly its budget, with a completion time',
    dead?.status === 'DEAD' &&
      dead.attempts === 2 &&
      dead.maxAttempts === 2 &&
      dead.completedAt instanceof Date,
    `status=${dead?.status} attempts=${dead?.attempts}/${dead?.maxAttempts}`,
  );
  check(
    'the terminal reason is retained for an operator',
    typeof dead?.lastError === 'string' && dead.lastError.length > 0,
    String(dead?.lastError).slice(0, 80),
  );
  check(
    'the dead letter is visible in the backlog view, read from PostgreSQL',
    (await metrics.backlog()).dead >= 1,
    `dead=${(await metrics.backlog()).dead}`,
  );

  /* -- 11. Permanent failure -------------------------------------------- */

  section('11. A payload that can never be valid dies on the first attempt');

  // Written with raw SQL on purpose: `enqueue` would refuse this, which is
  // check 4. This is the other case — a row already in the table, written by
  // a producer from a future or buggy deploy, which the worker must survive.
  const permanentId = randomUUID();
  const permanentKey = KEY('permanent');
  await prisma.$executeRaw`
    INSERT INTO "outbox_event"
      ("id", "propertyId", "eventType", "payloadVersion", "payload", "dedupeKey",
       "dedupeMode", "status", "attempts", "maxAttempts", "availableAt", "createdAt", "updatedAt")
    VALUES
      (${permanentId}, ${property.id}, 'OUTBOX_SELF_TEST', 1,
       ${JSON.stringify({ nonce: '', failTimes: SECRET })}::jsonb, ${permanentKey},
       'COALESCE', 'PENDING', 0, 5, now() - interval '1 second', now(), now())
  `;

  await dispatcher.publishDue();
  const permanentClaimed = await row(permanentId);
  await worker.process(job(permanentClaimed, 1));

  const permanent = await row(permanentId);
  check(
    'it is DEAD on attempt 1 despite a budget of 5',
    permanent?.status === 'DEAD' && permanent.attempts === 1 && permanent.maxAttempts === 5,
    `status=${permanent?.status} attempts=${permanent?.attempts}/${permanent?.maxAttempts}`,
  );
  check(
    'the recorded reason names the failing field',
    typeof permanent?.lastError === 'string' && permanent.lastError.includes('nonce'),
    String(permanent?.lastError).slice(0, 100),
  );
  check(
    'and still does not echo the payload value',
    !String(permanent?.lastError).includes(SECRET),
    'no payload value in lastError',
  );

  /* -- 12. Backoff ------------------------------------------------------- */

  section('12. Backoff grows, is jittered, and is bounded');

  const ceilings = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const samples = Array.from({ length: 200 }, () => worker.backoffFor(attempt));
    ceilings.push(Math.max(...samples));
    const min = Math.min(...samples);
    // The 100ms floor can exceed the computed ceiling on the first attempts,
    // which is deliberate: a retry 3ms later helps nobody.
    const bound = Math.max(100, Math.min(1_000, 50 * 2 ** (attempt - 1)));
    check(
      `attempt ${attempt}: every sample within [100, ${bound}]`,
      min >= 100 && Math.max(...samples) <= bound,
      `min=${min} max=${Math.max(...samples)}`,
    );
  }
  check(
    'the window widens with the attempt number',
    ceilings[0] < ceilings[3],
    `attempt1 max=${ceilings[0]} attempt4 max=${ceilings[3]}`,
  );
  check(
    'and is capped by OUTBOX_BACKOFF_MAX_MS',
    Math.max(...ceilings) <= 1_000,
    `overall max=${Math.max(...ceilings)}`,
  );
  check(
    'successive calls differ — jitter is real, not nominal',
    new Set(Array.from({ length: 50 }, () => worker.backoffFor(6))).size > 10,
  );

  /* -- 13. Constraints --------------------------------------------------- */

  section('13. The database refuses incoherent rows (CLAUDE.md 6.2)');

  /**
   * Asserts a write is refused with a specific SQLSTATE.
   *
   * The state is read the same three ways `common/errors/sql-state.ts` reads
   * it, and for the same reason documented there: Prisma wraps a raw-query
   * failure as `P2010`, which is itself five characters of `[0-9A-Z]`, so
   * reading `error.code` alone reports `P2010` and misses the `23514` sitting
   * in the message. That exact mistake once turned a working exclusion
   * constraint into a 500.
   */
  function sqlState(error) {
    if (typeof error !== 'object' || error === null) return null;
    if (typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) && !/^P\d{4}$/.test(error.code)) {
      return error.code;
    }
    if (error.code === 'P2002') return '23505';
    if (typeof error.meta?.code === 'string') return error.meta.code;
    if (typeof error.message === 'string') {
      return /Code:\s*`?([0-9A-Z]{5})`?/.exec(error.message)?.[1] ?? null;
    }
    return null;
  }

  async function expectViolation(label, expectedState, work) {
    try {
      await work();
      check(label, false, 'the write was ACCEPTED — a constraint is missing');
    } catch (error) {
      const state = sqlState(error);
      check(label, state === expectedState, `rejected with ${String(state)}`);
    }
  }

  await expectViolation('attempts cannot exceed maxAttempts', '23514', () =>
    prisma.$executeRaw`UPDATE "outbox_event" SET "attempts" = 99 WHERE "id" = ${permanentId}`,
  );
  await expectViolation('IN_FLIGHT requires a lease', '23514', () =>
    prisma.$executeRaw`
      UPDATE "outbox_event" SET "status" = 'IN_FLIGHT', "leaseExpiresAt" = NULL, "completedAt" = NULL
      WHERE "id" = ${permanentId}`,
  );
  await expectViolation('a terminal status requires completedAt', '23514', () =>
    prisma.$executeRaw`UPDATE "outbox_event" SET "completedAt" = NULL WHERE "id" = ${permanentId}`,
  );
  await expectViolation('payloadVersion must be positive', '23514', () =>
    prisma.$executeRaw`UPDATE "outbox_event" SET "payloadVersion" = 0 WHERE "id" = ${permanentId}`,
  );
  await expectViolation('two PENDING rows cannot share a COALESCE key', '23505', async () => {
    await prisma.$executeRaw`
      INSERT INTO "outbox_event"
        ("id", "propertyId", "eventType", "payloadVersion", "payload", "dedupeKey",
         "dedupeMode", "status", "attempts", "maxAttempts", "availableAt", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${property.id}, 'OUTBOX_SELF_TEST', 1, '{"nonce":"dup"}'::jsonb,
         ${KEY('coalesce-dup')}, 'COALESCE', 'PENDING', 0, 5, now(), now(), now()),
        (${randomUUID()}, ${property.id}, 'OUTBOX_SELF_TEST', 1, '{"nonce":"dup"}'::jsonb,
         ${KEY('coalesce-dup')}, 'COALESCE', 'PENDING', 0, 5, now(), now(), now())
    `;
  });

  /* -- 14. Tenancy ------------------------------------------------------- */

  section('14. Every row is tenant-stamped (CLAUDE.md 3.2)');

  const ours = await prisma.outboxEvent.findMany({
    where: { dedupeKey: { startsWith: `selftest:${RUN}:` } },
    select: { propertyId: true },
  });
  check(
    'all rows this run wrote name the property they belong to',
    ours.length > 0 && ours.every((entry) => entry.propertyId === property.id),
    `${ours.length} row(s), all propertyId=${property.code}`,
  );

  await expectViolation('a row cannot name a property that does not exist', '23503', () =>
    prisma.$executeRaw`
      INSERT INTO "outbox_event"
        ("id", "propertyId", "eventType", "payloadVersion", "payload", "dedupeKey",
         "dedupeMode", "status", "attempts", "maxAttempts", "availableAt", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${randomUUID()}, 'OUTBOX_SELF_TEST', 1, '{"nonce":"orphan"}'::jsonb,
         ${KEY('orphan')}, 'COALESCE', 'PENDING', 0, 5, now(), now(), now())
    `,
  );
}

async function teardown() {
  const { count } = await prisma.outboxEvent.deleteMany({
    where: { dedupeKey: { startsWith: `selftest:${RUN}:` } },
  });
  console.log(`\nTeardown: removed ${count} outbox row(s) written by this run.`);

  const leftovers = await prisma.outboxEvent.count();
  if (leftovers > 0) {
    console.log(
      `Note: ${leftovers} outbox row(s) from other runs remain. ` +
        'They are inspectable at GET /api/v1/health/outbox.',
    );
  }
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

console.log(failures === 0 ? '\nAll outbox checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
