/**
 * Turns outbox failures into operator alerts (OB-06, WK-11).
 *
 * ===========================================================================
 * Driven from the database, not from the moment of failure.
 *
 * The obvious design -- send an alert inside the worker's dead-letter branch
 * -- loses the alert whenever the sink is down at that moment, or the worker
 * dies between the DEAD write and the send. Then the dead letter is exactly
 * what section 5 forbids: failed, and vanished.
 *
 * So the DEAD write stays as it was, and this monitor scans for dead letters
 * whose `alertedAt` is still NULL. It sends, and only after a sink has
 * accepted does it stamp `alertedAt`. A sink outage, a crash or a restart
 * leaves the column NULL and the next pass tries again. Delivery is therefore
 * **at least once**: two worker replicas scanning at the same instant can
 * both send the same batch. A duplicate page is the safe failure; a missing
 * one is not.
 *
 * No HTTP call happens inside a transaction (CLAUDE.md section 3.1): the scan
 * and the stamp are separate statements with the send between them.
 *
 * STALE LEASES. A lease that expired and was not reaped means no dispatcher
 * is running its reaper -- every worker is down or wedged -- so work is
 * silently stuck. That is alerted when one has been expired for longer than a
 * grace period, and repeated at a slower interval while it persists. Its
 * cooldown is in memory, per process: a restart may send it once more.
 *
 * Runs in the WORKER only (`worker.ts` calls `start()`), like the dispatcher.
 * Cross-property by design: the night-audit-orchestration exception of
 * section 3.2, through the logged `withoutTenantScope`.
 * ===========================================================================
 */

import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withoutTenantScope } from '@repo/database';

import { PrismaService } from '../../../prisma/prisma.service.js';
import { ClockService } from '../clock.service.js';
import { ALERT_SINKS, type Alert, type AlertSink } from './alert.js';

/** Dead letters per alert. Enough to read at a glance; the rest follow on the next pass. */
const DEAD_LETTER_BATCH = 20;

interface DeadLetterRow {
  id: string;
  eventType: string;
  attempts: number;
  lastError: string | null;
  propertyCode: string;
}

export interface MonitorPassResult {
  deadLettersAlerted: number;
  staleLeaseAlerted: boolean;
}

@Injectable()
export class AlertMonitorService implements OnModuleDestroy {
  private readonly logger = new Logger(AlertMonitorService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** When the current stale-lease incident was last alerted; null when there is none. */
  private staleAlertedAt: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly clock: ClockService,
    @Inject(ALERT_SINKS) private readonly sinks: readonly AlertSink[],
  ) {}

  /** Starts the periodic pass. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    if (this.sinks.length === 0) {
      // Reachable outside production only: validateEnv refuses to boot a
      // production process without a sink.
      this.logger.warn(
        'No alert sink is configured (ALERT_WEBHOOK_URL / ALERT_EMAIL_TO); dead letters will only be logged.',
      );
      return;
    }
    const intervalMs = this.config.get<number>('ALERT_CHECK_MS', 30_000);
    this.timer = setInterval(() => {
      void this.runPass();
    }, intervalMs);
    this.logger.log(
      `Alert monitor started: sinks=${this.sinks.map((sink) => sink.name).join(',')} every ${String(intervalMs)}ms.`,
    );
    void this.runPass();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass, never overlapping another in this process. Exposed for tests. */
  async runPass(): Promise<MonitorPassResult> {
    if (this.running) return { deadLettersAlerted: 0, staleLeaseAlerted: false };
    this.running = true;
    try {
      return await withoutTenantScope(
        'alert monitor: outbox dead letters and stale leases',
        async () => {
          const deadLettersAlerted = await this.alertDeadLetters();
          const staleLeaseAlerted = await this.alertStaleLeases();
          return { deadLettersAlerted, staleLeaseAlerted };
        },
      );
    } catch (cause) {
      // A failed pass is retried by the next one; the rows it was about are
      // still unalerted in the database, so nothing is lost by moving on.
      this.logger.error(
        `Alert monitor pass failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return { deadLettersAlerted: 0, staleLeaseAlerted: false };
    } finally {
      this.running = false;
    }
  }

  private async alertDeadLetters(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<DeadLetterRow[]>`
      SELECT e."id"::text          AS "id",
             e."eventType"::text   AS "eventType",
             e."attempts"          AS "attempts",
             e."lastError"         AS "lastError",
             p."code"              AS "propertyCode"
        FROM "outbox_event" e
        JOIN "property" p ON p."id" = e."propertyId"
       WHERE e."status" = 'DEAD' AND e."alertedAt" IS NULL
       ORDER BY e."completedAt" ASC NULLS FIRST, e."id" ASC
       LIMIT ${DEAD_LETTER_BATCH}
    `;
    if (rows.length === 0) return 0;

    const waiting = await this.prisma.client.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM "outbox_event" WHERE "status" = 'DEAD' AND "alertedAt" IS NULL
    `;
    const total = waiting[0]?.total ?? rows.length;
    const more = total - rows.length;

    const alert: Alert = {
      kind: 'OUTBOX_DEAD_LETTER',
      summary:
        `${String(total)} background job(s) failed permanently and will not be retried` +
        (more > 0 ? ` (${String(rows.length)} listed, ${String(more)} in the next alert)` : ''),
      details: [
        ...rows.map(
          (row) =>
            `${row.eventType} ${row.id} at property ${row.propertyCode} after ${String(row.attempts)} attempt(s): ` +
            (row.lastError ?? 'no error recorded'),
        ),
        'These rows stay in outbox_event with status DEAD. Fix the cause, then re-drive or resolve each one.',
      ],
      raisedAt: this.clock.now().toISOString(),
    };

    if (!(await this.deliver(alert))) return 0;

    const ids = rows.map((row) => row.id);
    await this.prisma.client.$executeRaw`
      UPDATE "outbox_event"
         SET "alertedAt" = now()
       WHERE "id" = ANY(${ids}::uuid[]) AND "status" = 'DEAD' AND "alertedAt" IS NULL
    `;
    return rows.length;
  }

  private async alertStaleLeases(): Promise<boolean> {
    const graceMs = this.config.get<number>('ALERT_STALE_LEASE_GRACE_MS', 120_000);
    // Age measured in SQL against the reaper's own clock, never this host's.
    const found = await this.prisma.client.$queryRaw<{ stale: number; oldest: number | null }[]>`
      SELECT count(*)::int AS stale,
             floor(extract(epoch FROM now() - min("leaseExpiresAt")))::int AS oldest
        FROM "outbox_event"
       WHERE "status" = 'IN_FLIGHT'
         AND "leaseExpiresAt" < now() - make_interval(secs => ${graceMs / 1_000})
    `;
    const stale = found[0]?.stale ?? 0;
    if (stale === 0) {
      // The incident is over; the next one alerts at once.
      this.staleAlertedAt = null;
      return false;
    }

    const repeatMs = this.config.get<number>('ALERT_REPEAT_MS', 1_800_000);
    const now = this.clock.now().getTime();
    if (this.staleAlertedAt !== null && now - this.staleAlertedAt < repeatMs) return false;

    const alert: Alert = {
      kind: 'OUTBOX_STALE_LEASE',
      summary: `${String(stale)} background job(s) are stuck: their worker lease expired and nothing reclaimed it`,
      details: [
        `Oldest lease expired ${String(found[0]?.oldest ?? 0)}s ago.`,
        'This usually means no worker is running, or every worker is wedged. Check the worker process and Redis.',
      ],
      raisedAt: this.clock.now().toISOString(),
    };
    if (!(await this.deliver(alert))) return false;
    this.staleAlertedAt = now;
    return true;
  }

  /**
   * Sends to every sink; true when at least one accepted.
   *
   * One working sink is enough for a human to know, and requiring all of them
   * would let a broken webhook suppress the email that did arrive -- and then
   * resend it forever.
   */
  private async deliver(alert: Alert): Promise<boolean> {
    let delivered = false;
    for (const sink of this.sinks) {
      try {
        await sink.send(alert);
        delivered = true;
      } catch (cause) {
        this.logger.error(
          `Alert sink ${sink.name} failed for ${alert.kind}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    if (delivered) this.logger.warn(`ALERT SENT ${alert.kind}: ${alert.summary}`);
    else
      this.logger.error(
        `ALERT NOT DELIVERED ${alert.kind}: ${alert.summary}; will retry on the next pass.`,
      );
    return delivered;
  }
}
