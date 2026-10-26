/**
 * The BullMQ side of the outbox.
 *
 * ===========================================================================
 * BullMQ is a delivery mechanism here, not a scheduler and not a record.
 *
 * Jobs are published with **`attempts: 1`**. BullMQ never retries on its own.
 * That is a deliberate inversion of its usual role, and it is the answer to
 * "which layer owns retry counting": PostgreSQL does, exclusively.
 *
 * With BullMQ also retrying, two counters would exist -- `job.attemptsMade`
 * and `outbox_event.attempts` -- advancing at different rates, with two
 * backoff schedules and two opinions about when something is dead. There
 * would be no single answer to "how many times has this been tried", which is
 * precisely the question an operator asks. One counter, in the durable store,
 * is worth more than BullMQ's built-in backoff.
 *
 * JOB IDS ARE PER ATTEMPT, NOT PER ROW
 * The job id is `<rowId>:<attempts>:<recoveries>`. Making it the row id alone
 * is the obvious choice and is wrong: BullMQ ignores `add` for a job id it
 * already knows, so a row that failed, was returned to PENDING and became due
 * again would be silently *not* republished while its old job sat in the
 * failed set. Including the counters makes each publication distinct, while
 * still deduplicating a double publish of the *same* attempt -- which is
 * exactly the protection gap A needs.
 * ===========================================================================
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import type { ClaimedRow } from './outbox-dispatcher.service.js';

export const OUTBOX_QUEUE_NAME = 'outbox';

/** What travels to the worker. Deliberately only identifiers. */
export interface OutboxJobData {
  outboxEventId: string;
  propertyId: string;
  eventType: string;
  payloadVersion: number;
  attempt: number;
  /**
   * The lease token the claim was written with.
   *
   * The worker quotes it back on every write so it can only record an outcome
   * for the claim it was actually handed. See `ClaimedRow.claimedBy`.
   */
  claimToken: string;
}

/**
 * Redis connection options.
 *
 * Exported because the worker builds its own connection from the same shape;
 * sharing one `Queue` instance across processes is not possible.
 */
export function redisConnectionFrom(config: ConfigService): { url: string } {
  const url = config.get<string>('REDIS_URL');
  if (url === undefined || url.trim() === '') {
    // `validateEnv` defaults this, so an empty value means someone set it to
    // the empty string deliberately. Failing loudly beats connecting to a
    // guessed localhost in production.
    throw new Error('REDIS_URL is not configured; the outbox worker cannot start.');
  }
  return { url };
}

@Injectable()
export class OutboxQueue implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxQueue.name);
  private queue: Queue<OutboxJobData> | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Lazily constructed.
   *
   * The API process imports this module for `OutboxService`, which never
   * touches Redis. Connecting at construction would make every API instance
   * hold a Redis connection it does not use, and would make the API fail to
   * boot when Redis is down -- which is exactly the coupling requirement 5
   * forbids.
   */
  private get handle(): Queue<OutboxJobData> {
    if (this.queue === null) {
      const { url } = redisConnectionFrom(this.config);
      this.queue = new Queue<OutboxJobData>(OUTBOX_QUEUE_NAME, {
        connection: { url },
        defaultJobOptions: {
          // PostgreSQL owns retries. See the file header.
          attempts: 1,
          // Bounded retention: Redis is a buffer, not an archive. The durable
          // history lives in `outbox_event`.
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      });
    }
    return this.queue;
  }

  async publish(row: ClaimedRow): Promise<void> {
    const jobId = `${row.id}:${String(row.attempts)}:${String(row.recoveries)}`;

    await this.handle.add(
      row.eventType,
      {
        outboxEventId: row.id,
        propertyId: row.propertyId,
        eventType: row.eventType,
        payloadVersion: row.payloadVersion,
        attempt: row.attempts + 1,
        claimToken: row.claimedBy,
      },
      { jobId },
    );
  }

  /** Queue depth straight from Redis, for diagnosis alongside the DB view. */
  async depth(): Promise<{ waiting: number; active: number; failed: number }> {
    const [waiting, active, failed] = await Promise.all([
      this.handle.getWaitingCount(),
      this.handle.getActiveCount(),
      this.handle.getFailedCount(),
    ]);
    return { waiting, active, failed };
  }

  /**
   * True when Redis answers within `timeoutMs`. Used by the worker's own
   * start-up check, never by the API's readiness probe.
   *
   * `waitUntilReady()` rather than a raw `PING` through the backend's
   * Redis-specific escape hatch: it is the datastore-agnostic contract, and it
   * reports ready only once BullMQ itself can work, which is the question
   * being asked. It is raced against a timer because an unreachable host
   * leaves ioredis retrying rather than failing, so without a bound this would
   * hang instead of answering `false`.
   */
  async ping(timeoutMs = 5_000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.handle.waitUntilReady(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Redis did not become ready within ${String(timeoutMs)}ms`));
          }, timeoutMs);
        }),
      ]);
      return true;
    } catch (cause) {
      this.logger.error(`Redis is not reachable: ${String(cause)}`);
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue !== null) {
      await this.queue.close();
      this.queue = null;
      this.logger.log('Outbox queue closed.');
    }
  }
}
