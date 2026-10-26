/**
 * Outbox counters and backlog, for operators.
 *
 * ===========================================================================
 * Backlog is a workload signal, never a readiness signal.
 *
 * Nothing here feeds a readiness probe. An API with ten thousand pending
 * events is working exactly as designed, and pulling it out of a load balancer
 * for a backlog would turn a queue into an outage. The health controller
 * exposes these figures on their own endpoint, always 200.
 *
 * In-process counters, deliberately. There is no metrics backend in this stack
 * and CLAUDE.md section 6.4 says not to add a runtime dependency without a
 * reason; a Prometheus client for four counters at ten properties is not one.
 * The counters reset on restart, which is stated rather than hidden -- the
 * durable history lives in `outbox_event`, which is queryable and survives.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import type { OutboxBacklog } from '@repo/types';

import { PrismaService } from '../../../prisma/prisma.service.js';

@Injectable()
export class OutboxMetricsService {
  private readonly logger = new Logger(OutboxMetricsService.name);

  private processed = 0;
  private failed = 0;
  private retried = 0;
  private recovered = 0;
  private duplicatesDropped = 0;
  private totalDurationMs = 0;

  constructor(private readonly prisma: PrismaService) {}

  recordProcessed(durationMs: number): void {
    this.processed += 1;
    this.totalDurationMs += durationMs;
  }

  recordRetry(): void {
    this.retried += 1;
  }

  recordDead(): void {
    this.failed += 1;
  }

  recordRecovered(count: number): void {
    this.recovered += count;
  }

  recordDuplicateDropped(): void {
    this.duplicatesDropped += 1;
  }

  get averageDurationMs(): number {
    return this.processed === 0 ? 0 : Math.round(this.totalDurationMs / this.processed);
  }

  get duplicatesDroppedCount(): number {
    return this.duplicatesDropped;
  }

  /**
   * The backlog, read from PostgreSQL rather than Redis.
   *
   * The database is the source of truth, so these figures stay correct even if
   * Redis has been flushed -- which is the scenario where an operator most
   * needs them.
   *
   * Cross-property by design: this is a system view, the same exception
   * CLAUDE.md section 3.2 grants night-audit orchestration. A per-property
   * view uses the tenant-led index instead.
   */
  async backlog(): Promise<OutboxBacklog> {
    const [counts, ages] = await Promise.all([
      this.prisma.client.outboxEvent.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      /**
       * Age and staleness are computed **in SQL**, against the same `now()`
       * the dispatcher and the reaper use. Subtracting a fetched timestamp
       * from `Date.now()` in here would report an age measured between two
       * clocks, which is how a backlog gauge quietly starts lying -- and, on a
       * session that is not UTC, lying by hours. See the one-clock note in
       * `outbox-dispatcher.service.ts`.
       */
      this.prisma.client.$queryRaw<{ oldest: number | null; stale: number }[]>`
        SELECT
          (SELECT floor(extract(epoch FROM now() - min("createdAt")))::int
             FROM "outbox_event" WHERE "status" = 'PENDING')           AS oldest,
          (SELECT count(*)::int
             FROM "outbox_event"
            WHERE "status" = 'IN_FLIGHT' AND "leaseExpiresAt" < now()) AS stale
      `,
    ]);

    const by = (status: string): number =>
      counts.find((row) => row.status === status)?._count._all ?? 0;

    const oldestSeconds = ages[0]?.oldest ?? null;

    return {
      pending: by('PENDING'),
      inFlight: by('IN_FLIGHT'),
      dead: by('DEAD'),
      oldestPendingAgeSeconds: oldestSeconds === null ? null : Math.max(0, oldestSeconds),
      staleLeases: ages[0]?.stale ?? 0,
      processedSinceBoot: this.processed,
      failedSinceBoot: this.failed,
      retriedSinceBoot: this.retried,
      recoveredSinceBoot: this.recovered,
    };
  }

  /**
   * Logs the backlog at a fixed interval, so a growing queue is visible in the
   * log even where nobody is scraping an endpoint.
   */
  async logBacklog(): Promise<void> {
    const backlog = await this.backlog();
    const line =
      `outbox backlog pending=${String(backlog.pending)} inFlight=${String(backlog.inFlight)} ` +
      `dead=${String(backlog.dead)} staleLeases=${String(backlog.staleLeases)} ` +
      `oldestPendingAgeSeconds=${String(backlog.oldestPendingAgeSeconds ?? 0)} ` +
      `processed=${String(backlog.processedSinceBoot)} retried=${String(backlog.retriedSinceBoot)} ` +
      `dead_since_boot=${String(backlog.failedSinceBoot)} recovered=${String(backlog.recoveredSinceBoot)}`;

    // Dead letters and stale leases are the two conditions that want a human.
    if (backlog.dead > 0 || backlog.staleLeases > 0) this.logger.warn(line);
    else this.logger.log(line);
  }
}
