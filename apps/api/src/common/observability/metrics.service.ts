/**
 * The process's metrics (OB-05), rendered for `GET /api/v1/metrics`.
 *
 * Request metrics are labelled by the route TEMPLATE
 * (`/api/v1/properties/:hotelId/folios/:folioId`), never the URL, so the
 * label set stays bounded and no id, booking code or other identifier
 * becomes a label. Outbox figures are read from PostgreSQL at scrape time
 * through the same service the health endpoint uses.
 */

import { Injectable } from '@nestjs/common';

import { OutboxMetricsService } from '../../modules/platform/outbox/outbox-metrics.service.js';
import { Counter, Gauge, Histogram, renderAll } from './metrics.js';

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

@Injectable()
export class MetricsService {
  readonly httpRequests = new Counter(
    'easeit_http_requests_total',
    'HTTP requests by method, route template and status.',
  );
  readonly httpDuration = new Histogram(
    'easeit_http_request_duration_seconds',
    'HTTP request duration by method and route template.',
    LATENCY_BUCKETS,
  );
  readonly externalCalls = new Counter(
    'easeit_external_calls_total',
    'Outbound calls to third parties by provider and outcome (ok, http_4xx, http_5xx, error).',
  );
  readonly externalDuration = new Histogram(
    'easeit_external_call_duration_seconds',
    'Outbound call duration by provider.',
    LATENCY_BUCKETS,
  );
  readonly unhandledErrors = new Counter(
    'easeit_unhandled_errors_total',
    'Requests that failed with an unexpected server error, by error name.',
  );
  private readonly outboxGauge = new Gauge('easeit_outbox_rows', 'Outbox rows by state.');
  private readonly outboxOldest = new Gauge(
    'easeit_outbox_oldest_pending_age_seconds',
    'Age of the oldest pending outbox row; 0 when none waits.',
  );
  private readonly memory = new Gauge('easeit_process_resident_memory_bytes', 'Resident set size.');
  private readonly heap = new Gauge('easeit_process_heap_used_bytes', 'V8 heap in use.');
  private readonly uptime = new Gauge(
    'easeit_process_uptime_seconds',
    'Seconds since the process started.',
  );
  private readonly scrapeErrors = new Counter(
    'easeit_metrics_collect_errors_total',
    'Failures reading a metric source at scrape time (the rest still render).',
  );

  constructor(private readonly outbox: OutboxMetricsService) {}

  recordHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe(seconds, { method, route });
  }

  recordExternal(provider: string, outcome: string, seconds: number): void {
    this.externalCalls.inc({ provider, outcome });
    this.externalDuration.observe(seconds, { provider });
  }

  async render(): Promise<string> {
    const mem = process.memoryUsage();
    this.memory.set(mem.rss);
    this.heap.set(mem.heapUsed);
    this.uptime.set(Math.round(process.uptime()));
    try {
      const backlog = await this.outbox.backlog();
      this.outboxGauge.set(backlog.pending, { state: 'pending' });
      this.outboxGauge.set(backlog.inFlight, { state: 'in_flight' });
      this.outboxGauge.set(backlog.dead, { state: 'dead' });
      this.outboxGauge.set(backlog.staleLeases, { state: 'stale_lease' });
      this.outboxOldest.set(backlog.oldestPendingAgeSeconds ?? 0);
    } catch {
      // The database is down: the HTTP and process metrics still render,
      // and this counter says why the outbox ones are stale.
      this.scrapeErrors.inc({ source: 'outbox' });
    }
    return renderAll([
      this.httpRequests,
      this.httpDuration,
      this.externalCalls,
      this.externalDuration,
      this.unhandledErrors,
      this.outboxGauge,
      this.outboxOldest,
      this.memory,
      this.heap,
      this.uptime,
      this.scrapeErrors,
    ]);
  }
}
