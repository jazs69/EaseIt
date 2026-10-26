/**
 * Consumes outbox jobs, and writes the outcome back to PostgreSQL.
 *
 * ===========================================================================
 * This is where "PostgreSQL owns retry scheduling" becomes real.
 *
 * On failure the worker does NOT rethrow to let BullMQ reschedule. It computes
 * the next attempt time itself -- exponential backoff with jitter -- writes
 * `attempts`, `availableAt` and a scrubbed `lastError` to the row, and returns
 * it to PENDING. The dispatcher republishes when the time comes.
 *
 * The consequence is that one counter and one schedule exist, in the durable
 * store, and `outbox_event_attempt_budget_coherent` enforces that the counter
 * stays sane. There is no second opinion in Redis to disagree with it.
 *
 * Jitter matters more than it looks. Without it, a provider outage that fails
 * fifty events at once produces fifty retries at the same instant, forever, in
 * lockstep -- a thundering herd that keeps the provider down. Full jitter
 * spreads them.
 * ===========================================================================
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { outboxPayloadSchemaFor, OUTBOX_PAYLOAD_VERSION } from '@repo/types';
import { Worker, type Job } from 'bullmq';

import { PrismaService } from '../../../prisma/prisma.service.js';
import { describe } from './outbox-dispatcher.service.js';
import { OutboxMetricsService } from './outbox-metrics.service.js';
import {
  OutboxHandlerRegistry,
  OutboxPermanentError,
} from './outbox-handler.registry.js';
import {
  OUTBOX_QUEUE_NAME,
  redisConnectionFrom,
  type OutboxJobData,
} from './outbox.queue.js';

@Injectable()
export class OutboxWorker implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private worker: Worker<OutboxJobData> | null = null;

  private readonly concurrency: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly handlerTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: OutboxHandlerRegistry,
    private readonly metrics: OutboxMetricsService,
    private readonly config: ConfigService,
  ) {
    this.concurrency = config.get<number>('OUTBOX_CONCURRENCY', 4);
    this.baseBackoffMs = config.get<number>('OUTBOX_BACKOFF_BASE_MS', 2_000);
    this.maxBackoffMs = config.get<number>('OUTBOX_BACKOFF_MAX_MS', 300_000);
    this.handlerTimeoutMs = config.get<number>('OUTBOX_HANDLER_TIMEOUT_MS', 30_000);
  }

  /** Started by the worker entry point, never by the API process. */
  start(): void {
    if (this.worker !== null) return;

    const { url } = redisConnectionFrom(this.config);
    this.worker = new Worker<OutboxJobData>(
      OUTBOX_QUEUE_NAME,
      async (job) => {
        await this.process(job);
      },
      { connection: { url }, concurrency: this.concurrency },
    );

    this.worker.on('failed', (job, error) => {
      // Only reached if `process` itself threw, which it is written not to do.
      this.logger.error(
        `Outbox job ${job?.id ?? 'unknown'} failed outside the handler: ${describe(error)}`,
      );
    });

    this.logger.log(
      `Outbox worker started: concurrency=${String(this.concurrency)} ` +
        `timeout=${String(this.handlerTimeoutMs)}ms types=[${this.registry.registeredTypes.join(', ')}]`,
    );
  }

  /**
   * Handles one job.
   *
   * Deliberately swallows handler failures after recording them, so BullMQ
   * sees success and does not apply a schedule of its own. The durable record
   * of the failure is the row, not the job.
   */
  async process(job: Job<OutboxJobData>): Promise<void> {
    /**
     * Only the id and the property are taken from the job. The event type and
     * payload version are read from the row below instead: the job is a
     * *notification*, and the row is the truth. A job sitting in Redis across
     * a deploy can carry a stale copy of either.
     */
    const { outboxEventId, propertyId, claimToken } = job.data;

    const row = await this.prisma.client.outboxEvent.findUnique({
      where: { id: outboxEventId },
      select: {
        id: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        payload: true,
        payloadVersion: true,
        eventType: true,
        propertyId: true,
        claimedBy: true,
      },
    });

    if (row === null) {
      // The row was deleted — a property cascade, or a manual clean-up. The
      // job has nothing to do and must not be treated as a failure.
      this.logger.warn(`Outbox row ${outboxEventId} no longer exists; dropping job.`);
      return;
    }

    if (row.status !== 'IN_FLIGHT' || row.claimedBy !== claimToken) {
      /**
       * Duplicate delivery, and it is safe.
       *
       * Either another worker already finished this row, or the reaper
       * returned it to PENDING and a newer claim owns it now. Both are stale.
       *
       * The claim token is checked as well as the status, because the status
       * alone cannot tell "my claim" from "somebody else's claim": after a
       * lease expiry the row goes PENDING and straight back to IN_FLIGHT under
       * a new token, and a job carrying the *old* token would otherwise look
       * perfectly current.
       *
       * This is the cheap half of duplicate safety. The other half is the
       * handler's own idempotency, which is still required -- a reclaim can
       * happen after the provider call and before this check, and no amount of
       * guarding here undoes a request that was already sent.
       */
      this.logger.debug(
        `Outbox row ${outboxEventId} is ${row.status} under claim ` +
          `${String(row.claimedBy)} (job carried ${claimToken}); dropping stale job.`,
      );
      this.metrics.recordDuplicateDropped();
      return;
    }

    /**
     * Version check before anything else.
     *
     * An unknown version is not a malformed payload: it usually means this
     * worker is older than the producer that wrote the row. Leaving it for a
     * newer worker is a transient condition, so it retries rather than
     * dead-letters — a rolling deploy must not poison its own backlog.
     */
    const currentVersion = OUTBOX_PAYLOAD_VERSION[row.eventType];
    const schema = outboxPayloadSchemaFor(row.eventType, row.payloadVersion);

    if (schema === undefined) {
      const known = row.payloadVersion > currentVersion;
      await this.recordFailure(
        row,
        claimToken,
        `Unrecognised payload version ${String(row.payloadVersion)} for ${row.eventType}`,
        known ? 'transient' : 'permanent',
      );
      return;
    }

    const parsed = schema.safeParse(row.payload);
    if (!parsed.success) {
      /**
       * A malformed payload is permanent.
       *
       * It cannot become valid by waiting, so it skips the remaining budget
       * and dead-letters now, which surfaces the producer bug immediately
       * instead of five backoffs later. Field paths only — the invalid values
       * are not logged, because a payload in a log is a payload in a
       * dashboard.
       */
      const paths = parsed.error.issues
        .map((issue) => issue.path.join('.') || 'root')
        .join(', ');
      await this.recordFailure(row, claimToken, `Payload failed validation at: ${paths}`, 'permanent');
      return;
    }

    const handler = this.registry.get(row.eventType);
    if (handler === undefined) {
      /**
       * No handler registered. Transient on purpose.
       *
       * The usual cause is a worker deployed without a handler the producer
       * already emits. That resolves on the next deploy, so the row should
       * wait rather than die.
       */
      await this.recordFailure(
        row,
        claimToken,
        `No handler registered for ${row.eventType}`,
        'transient',
      );
      return;
    }

    const startedAt = Date.now();
    try {
      await withTimeout(
        handler.handle({
          outboxEventId: row.id,
          propertyId: row.propertyId,
          payload: parsed.data,
          attempt: row.attempts + 1,
        }),
        this.handlerTimeoutMs,
        `${row.eventType} handler exceeded ${String(this.handlerTimeoutMs)}ms`,
      );

      /**
       * Guarded on IN_FLIGHT so a row reclaimed mid-handler is not overwritten
       * by a worker that lost its lease. Raw SQL so `completedAt` comes from
       * the database clock, the same one the dispatcher wrote the lease with
       * -- see the one-clock note in `outbox-dispatcher.service.ts`.
       */
      const written = await this.prisma.client.$executeRaw`
        UPDATE "outbox_event"
        SET "status"         = 'SUCCEEDED',
            "attempts"       = ${row.attempts + 1},
            "completedAt"    = now(),
            "claimedAt"      = NULL,
            "leaseExpiresAt" = NULL,
            "claimedBy"      = NULL,
            "lastError"      = NULL,
            "lastErrorAt"    = NULL,
            "updatedAt"      = now()
        WHERE "id" = ${row.id}::uuid
          AND "status" = 'IN_FLIGHT'
          AND "claimedBy" = ${claimToken}
      `;

      if (written === 0) {
        /**
         * The lease was lost while the handler was working.
         *
         * Another worker owns the row now, and it will record its own outcome.
         * This is the one case the token guard exists for, and it is worth a
         * warning rather than a debug line: it means a handler outran its
         * lease, which is a configuration problem (the env schema requires a
         * lease of at least twice the handler timeout) or a very slow
         * provider. The side effect may have happened twice, so the handler's
         * idempotency is what protects correctness here.
         */
        this.logger.warn(
          `Outbox ${row.eventType} ${row.id} succeeded but its lease had been reclaimed; ` +
            'the outcome was recorded by another worker. Check OUTBOX_LEASE_MS against handler duration.',
        );
        this.metrics.recordDuplicateDropped();
        return;
      }

      this.metrics.recordProcessed(Date.now() - startedAt);
      this.logger.debug(
        `Outbox ${row.eventType} ${row.id} succeeded in ${String(Date.now() - startedAt)}ms ` +
          `(property=${propertyId}, attempt=${String(row.attempts + 1)})`,
      );
    } catch (cause) {
      const kind = cause instanceof OutboxPermanentError ? 'permanent' : 'transient';
      await this.recordFailure(row, claimToken, describe(cause), kind);
    }
  }

  /**
   * Writes a failure to the row and decides its next state.
   *
   * This is the only place `attempts` advances, and the only place
   * `availableAt` is scheduled.
   */
  private async recordFailure(
    row: { id: string; eventType: string; attempts: number; maxAttempts: number },
    claimToken: string,
    reason: string,
    kind: 'transient' | 'permanent',
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const exhausted = kind === 'permanent' || attempts >= row.maxAttempts;

    if (exhausted) {
      await this.prisma.client.$executeRaw`
        UPDATE "outbox_event"
        SET "status"         = 'DEAD',
            "attempts"       = ${attempts},
            "completedAt"    = now(),
            "claimedAt"      = NULL,
            "leaseExpiresAt" = NULL,
            "claimedBy"      = NULL,
            "lastError"      = ${truncate(reason)},
            "lastErrorAt"    = now(),
            "updatedAt"      = now()
        WHERE "id" = ${row.id}::uuid
          AND "status" = 'IN_FLIGHT'
          AND "claimedBy" = ${claimToken}
      `;

      this.metrics.recordDead();
      /**
       * Dead-lettered work alerts. CLAUDE.md section 5: "A job that fails
       * permanently must alert, not vanish." `error` is the loudest level this
       * stack has; a real alerting hook belongs with the monitoring work, and
       * is listed as a limitation rather than pretended at.
       */
      this.logger.error(
        `OUTBOX DEAD LETTER: ${row.eventType} ${row.id} after ${String(attempts)} attempt(s) ` +
          `(${kind}): ${truncate(reason)}`,
      );
      return;
    }

    const delayMs = this.backoffFor(attempts);
    /**
     * The next attempt is scheduled as `now() + interval` in SQL, because the
     * dispatcher's due check is `availableAt <= now()` against that same
     * clock. Computing it here from `Date.now()` would make the schedule
     * depend on this host's clock agreeing with the database's.
     */
    await this.prisma.client.$executeRaw`
      UPDATE "outbox_event"
      SET "status"         = 'PENDING',
          "attempts"       = ${attempts},
          "availableAt"    = now() + make_interval(secs => ${delayMs / 1_000}),
          "claimedAt"      = NULL,
          "leaseExpiresAt" = NULL,
          "claimedBy"      = NULL,
          "lastError"      = ${truncate(reason)},
          "lastErrorAt"    = now(),
          "updatedAt"      = now()
      WHERE "id" = ${row.id}::uuid
        AND "status" = 'IN_FLIGHT'
        AND "claimedBy" = ${claimToken}
    `;

    this.metrics.recordRetry();
    this.logger.warn(
      `Outbox ${row.eventType} ${row.id} attempt ${String(attempts)}/${String(row.maxAttempts)} ` +
        `failed, retrying in ${String(delayMs)}ms: ${truncate(reason)}`,
    );
  }

  /**
   * Exponential backoff with **full jitter**.
   *
   * `random() * min(max, base * 2^(n-1))`. Full jitter rather than
   * equal jitter because the failure mode we actually fear is correlated: one
   * provider outage failing a whole batch, which then retries in lockstep.
   * Spreading across the entire window decorrelates them fastest.
   */
  backoffFor(attempt: number): number {
    const ceiling = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (attempt - 1));
    return Math.max(100, Math.floor(Math.random() * ceiling));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker !== null) {
      // `close()` waits for in-flight jobs, so a job either finishes and
      // records its outcome, or its lease expires and it is reclaimed.
      await this.worker.close();
      this.worker = null;
      this.logger.log('Outbox worker stopped.');
    }
  }
}

/** Bounds a handler so a hung provider call cannot hold a lease forever. */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Fits the `VARCHAR(500)` column, leaving room for the prefix we add. */
function truncate(reason: string): string {
  return reason.length > 400 ? `${reason.slice(0, 397)}...` : reason;
}
