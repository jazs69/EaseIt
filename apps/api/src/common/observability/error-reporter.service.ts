/**
 * Error reporting for unexpected server errors (OB-05).
 *
 * ===========================================================================
 * A 500 that is not a typed `DomainError` is a bug, and a person should hear
 * about it without reading every log line. The exception filter hands each one
 * to `report()`, which:
 *
 * - counts it (`easeit_unhandled_errors_total{name}`);
 * - groups it by fingerprint (error name + route template + first line of the
 *   message, redacted), keeping the count, first and last seen, and one
 *   request and trace id to look up in the logs;
 * - and, every `ERROR_REPORT_INTERVAL_MS`, sends ONE digest of the groups seen
 *   since the last digest through the configured alert sinks (the email and
 *   webhook from OB-06). A fingerprint already sent is repeated at most once
 *   per `ALERT_REPEAT_MS`; its count still accumulates.
 *
 * Nothing is sent from the request path: `report()` only records. The digest
 * runs on a timer and never holds a request.
 *
 * In memory, per process: a crash between digests loses that window's
 * grouping. The errors themselves are still in the log, each with its request
 * id and trace id, which is the durable record. This is a report, not a
 * ledger, and a dependency like Sentry would be the next step up if wanted.
 * Only identifiers and redacted first lines travel: no stack, payload or
 * personal data.
 * ===========================================================================
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ALERT_SINKS, type Alert, type AlertSink } from '../../modules/platform/alerting/alert.js';
import { ClockService } from '../../modules/platform/clock.service.js';
import { redactText } from '../logging/redact.js';
import { MetricsService } from './metrics.service.js';

export interface ErrorReport {
  name: string;
  message: string;
  method: string;
  route: string;
  requestId: string;
  traceId: string | null;
}

interface Group {
  fingerprint: string;
  name: string;
  route: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  requestId: string;
  traceId: string | null;
}

const MAX_GROUPS = 200;

@Injectable()
export class ErrorReporter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErrorReporter.name);
  private readonly pending = new Map<string, Group>();
  private readonly lastSent = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly metrics: MetricsService,
    private readonly clock: ClockService,
    private readonly config: ConfigService,
    @Inject(ALERT_SINKS) private readonly sinks: readonly AlertSink[],
  ) {}

  onModuleInit(): void {
    if (this.sinks.length === 0) return;
    const every = this.config.get<number>('ERROR_REPORT_INTERVAL_MS', 60_000);
    this.timer = setInterval(() => {
      void this.flush();
    }, every);
    // Never keeps a process alive on its own.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Records one unexpected error. Synchronous and cheap: it is on the request path. */
  report(error: ErrorReport): void {
    this.metrics.unhandledErrors.inc({ name: error.name });
    const firstLine = redactText((error.message.split('\n')[0] ?? '').slice(0, 200));
    const fingerprint = `${error.name}|${error.method} ${error.route}|${firstLine}`;
    const now = this.clock.now().toISOString();
    const existing = this.pending.get(fingerprint);
    if (existing !== undefined) {
      existing.count += 1;
      existing.lastSeen = now;
      return;
    }
    if (this.pending.size >= MAX_GROUPS) return;
    this.pending.set(fingerprint, {
      fingerprint,
      name: error.name,
      route: `${error.method} ${error.route}`,
      message: firstLine,
      count: 1,
      firstSeen: now,
      lastSeen: now,
      requestId: error.requestId,
      traceId: error.traceId,
    });
  }

  /** Sends one digest of what is pending and due. Exposed for tests. */
  async flush(): Promise<number> {
    if (this.pending.size === 0 || this.sinks.length === 0) return 0;
    const repeatMs = this.config.get<number>('ALERT_REPEAT_MS', 1_800_000);
    const nowMs = this.clock.now().getTime();
    const due = [...this.pending.values()].filter(
      (group) => nowMs - (this.lastSent.get(group.fingerprint) ?? 0) >= repeatMs,
    );
    if (due.length === 0) return 0;

    const total = due.reduce((sum, group) => sum + group.count, 0);
    const alert: Alert = {
      kind: 'API_ERRORS',
      summary: `${String(total)} unexpected server error(s) in ${String(due.length)} kind(s)`,
      details: due.map(
        (group) =>
          `${String(group.count)}x ${group.name} on ${group.route}: ${group.message} ` +
          `(first ${group.firstSeen}, last ${group.lastSeen}, request ${group.requestId}` +
          `${group.traceId === null ? '' : `, trace ${group.traceId}`})`,
      ),
      raisedAt: this.clock.now().toISOString(),
    };

    let delivered = false;
    for (const sink of this.sinks) {
      try {
        await sink.send(alert);
        delivered = true;
      } catch (cause) {
        this.logger.error(
          `Error digest not accepted by ${sink.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    if (!delivered) return 0;
    for (const group of due) {
      this.lastSent.set(group.fingerprint, nowMs);
      this.pending.delete(group.fingerprint);
    }
    return due.length;
  }
}
