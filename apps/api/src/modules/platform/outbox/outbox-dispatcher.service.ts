/**
 * Moves due outbox rows into BullMQ, and recovers the ones a dead worker left
 * behind.
 *
 * ===========================================================================
 * Two crash gaps exist, and neither can be closed by a transaction.
 *
 * **Gap A — between claiming a row and publishing it to Redis.** There is no
 * transaction spanning PostgreSQL and Redis, so a process that dies here has
 * marked a row IN_FLIGHT that no queue knows about. If IN_FLIGHT were a lock,
 * the row would be stranded forever.
 *
 * So IN_FLIGHT is a **lease**, not a lock. A claim writes `leaseExpiresAt`,
 * and `reapStaleLeases` returns expired rows to PENDING. A crash costs one
 * lease duration of latency and nothing else.
 *
 * **Gap B — between a handler succeeding and the row being marked SUCCEEDED.**
 * A process that dies here has already called the provider. The lease expires,
 * the row is reclaimed, and the handler runs **again**. This is unavoidable,
 * and it is why delivery is at-least-once: see the note in `outbox.service.ts`
 * about what the handler must do to make that safe.
 *
 * A reclaim increments `recoveries`, never `attempts`. A worker dying is an
 * operational event, not a handler failure, and must not consume retry budget
 * -- otherwise three unlucky restarts would dead-letter a healthy job.
 *
 * WHY POLLING RATHER THAN A POST-COMMIT PUBLISH
 * Publishing straight after commit is lower latency and strictly less safe: if
 * that publish fails, the event is lost unless something later notices. A
 * poller that claims from the table *is* that something, so it has to exist
 * anyway. Building only the poller means one mechanism, and restart recovery
 * comes free -- a restarted process simply finds the rows still sitting there.
 * Latency is bounded by the poll interval, which at ten properties is a
 * trade worth making.
 * ===========================================================================
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../prisma/prisma.service.js';
import { OutboxMetricsService } from './outbox-metrics.service.js';
import { OutboxQueue } from './outbox.queue.js';

/** One claimed row, as the dispatcher needs it. */
export interface ClaimedRow {
  id: string;
  propertyId: string;
  eventType: string;
  payloadVersion: number;
  attempts: number;
  recoveries: number;
  /**
   * Who holds the claim, as written by the claiming UPDATE.
   *
   * This travels to the worker as a **lease token**. The worker quotes it back
   * on every write, so a worker whose lease was reclaimed while its handler
   * was still running cannot overwrite the outcome recorded by whoever owns
   * the row now. Without it, `WHERE status = 'IN_FLIGHT'` is satisfied by
   * *any* claim, not this one.
   */
  claimedBy: string;
}

@Injectable()
export class OutboxDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);

  /** Identifies this process in `claimedBy`. Diagnosis only, never trust. */
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: OutboxQueue,
    private readonly metrics: OutboxMetricsService,
    config: ConfigService,
  ) {
    this.pollMs = config.get<number>('OUTBOX_POLL_MS', 1_000);
    this.batchSize = config.get<number>('OUTBOX_BATCH_SIZE', 50);
    this.leaseMs = config.get<number>('OUTBOX_LEASE_MS', 60_000);
  }

  /**
   * Starts the loop.
   *
   * Called by the worker entry point, not by `OnModuleInit`, so that importing
   * this module into the API process does not silently start draining the
   * queue from every running instance. One codebase, two process roles.
   */
  start(): void {
    if (this.timer !== null) return;
    this.logger.log(
      `Outbox dispatcher starting: poll=${String(this.pollMs)}ms ` +
        `batch=${String(this.batchSize)} lease=${String(this.leaseMs)}ms worker=${this.workerId}`,
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
  }

  /**
   * Stops accepting new work and waits for the current tick.
   *
   * Nest calls this through `app.enableShutdownHooks()`, which `main.ts`
   * already enables. Rows claimed but unpublished when we stop are not lost:
   * their leases expire and another process reclaims them.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-progress tick finish so we do not abandon a claim we could
    // have published. Bounded, because shutdown must not hang.
    for (let waited = 0; this.running && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.logger.log('Outbox dispatcher stopped.');
  }

  /** One poll: reap what died, then publish what is due. */
  async tick(): Promise<{ reaped: number; published: number }> {
    if (this.running || this.stopping) return { reaped: 0, published: 0 };
    this.running = true;

    try {
      const reaped = await this.reapStaleLeases();
      const published = await this.publishDue();
      return { reaped, published };
    } catch (cause) {
      // Never let a poll failure kill the interval. A dispatcher that stops
      // silently is worse than one that logs and tries again in a second.
      this.logger.error(`Outbox dispatcher tick failed: ${describe(cause)}`);
      return { reaped: 0, published: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * Returns rows whose lease expired to PENDING.
   *
   * This is the entire crash-recovery mechanism for gaps A and B. It is a
   * single statement so two dispatchers racing it cannot double-count
   * `recoveries`: the UPDATE's own WHERE clause is the guard.
   */
  async reapStaleLeases(): Promise<number> {
    const reaped = await this.prisma.client.$executeRaw`
      UPDATE "outbox_event"
      SET "status"         = 'PENDING',
          "recoveries"     = "recoveries" + 1,
          "claimedAt"      = NULL,
          "leaseExpiresAt" = NULL,
          "claimedBy"      = NULL,
          "updatedAt"      = now()
      WHERE "status" = 'IN_FLIGHT'
        AND "leaseExpiresAt" < now()
    `;

    if (reaped > 0) {
      // Worth a warning, not a debug line: this only happens when a process
      // died or a handler outran its lease, and both deserve attention.
      this.logger.warn(
        `Reclaimed ${String(reaped)} outbox row(s) from expired leases. ` +
          'A worker died mid-job, or a handler exceeded the lease duration.',
      );
      this.metrics.recordRecovered(reaped);
    }

    return reaped;
  }

  /**
   * Claims due rows and publishes them.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes several dispatchers safe: each
   * takes a disjoint set and none waits on another. The claim and the publish
   * are deliberately *not* in one transaction, because they cannot be -- Redis
   * is not transactional with PostgreSQL. The lease is what covers the gap.
   */
  async publishDue(): Promise<number> {
    /**
     * Claim and return in one statement.
     *
     * A CTE rather than SELECT-then-UPDATE so the claim is atomic: there is no
     * window in which a row is selected by us and then claimed by someone
     * else. The inner SELECT takes the lock; the UPDATE marks the lease.
     *
     * ONE CLOCK OWNS LEASES, AND IT IS THE DATABASE'S
     * The lease is computed as `now() + interval` **in SQL** rather than as a
     * JS `Date` from this process. Two reasons, and both have bitten:
     *
     *   1. A lease written by one host and compared against `now()` by another
     *      is only correct while their clocks agree. They drift. A lease that
     *      reads as already expired makes the reaper reclaim rows that are
     *      healthily in flight, which delivers every side effect twice.
     *   2. The driver serialises a `Date` as wall-clock digits with no offset,
     *      so a session on a non-UTC time zone stores the wrong instant --
     *      measured at 5h30m on this machine before `client-factory.ts` pinned
     *      the session to UTC. Taking the time from the database makes this
     *      code correct even if that setting is ever lost.
     */
    const claimed = await this.prisma.client.$queryRaw<ClaimedRow[]>`
      WITH due AS (
        SELECT "id"
        FROM "outbox_event"
        WHERE "status" = 'PENDING'
          AND "availableAt" <= now()
        ORDER BY "availableAt" ASC, "createdAt" ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "outbox_event" e
      SET "status"         = 'IN_FLIGHT',
          "claimedAt"      = now(),
          "leaseExpiresAt" = now() + make_interval(secs => ${this.leaseMs / 1_000}),
          "claimedBy"      = ${this.workerId},
          "updatedAt"      = now()
      FROM due
      WHERE e."id" = due."id"
      RETURNING e."id", e."propertyId", e."eventType", e."payloadVersion",
                e."attempts", e."recoveries", e."claimedBy"
    `;

    if (claimed.length === 0) return 0;

    let published = 0;
    for (const row of claimed) {
      try {
        await this.queue.publish(row);
        published += 1;
      } catch (cause) {
        /**
         * The publish failed, so this row is in gap A.
         *
         * We could return it to PENDING immediately, and usually that is what
         * happens on the next line. If even that fails -- Redis and PostgreSQL
         * both unhappy -- the lease still expires and the reaper picks it up.
         * Two independent paths to recovery, which is the point.
         */
        this.logger.error(
          `Failed to publish outbox row ${row.id} (${row.eventType}): ${describe(cause)}`,
        );
        await this.releaseToPending(row.id).catch(() => {
          this.logger.warn(
            `Could not release outbox row ${row.id}; its lease will expire and the reaper will recover it.`,
          );
        });
      }
    }

    if (published > 0) {
      this.logger.debug(`Published ${String(published)} outbox row(s).`);
    }

    return published;
  }

  /** Hands a claimed row back without touching its retry budget. */
  private async releaseToPending(id: string): Promise<void> {
    await this.prisma.client.outboxEvent.updateMany({
      where: { id, status: 'IN_FLIGHT' },
      data: {
        status: 'PENDING',
        claimedAt: null,
        leaseExpiresAt: null,
        claimedBy: null,
      },
    });
  }
}

/**
 * A safe one-line description of a failure.
 *
 * Name and message only, truncated. No stack, no SQL, no provider response
 * body -- those carry payloads, and payloads reach logs and dashboards
 * (CLAUDE.md section 5: never log guest PII or full channel payloads).
 */
export function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`.slice(0, 300);
  }
  return String(cause).slice(0, 300);
}
