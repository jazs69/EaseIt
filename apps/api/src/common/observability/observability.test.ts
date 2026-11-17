/** OB-05: trace context, the metrics text format, the traced fetch and the error digest. */

import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Alert, AlertSink } from '../../modules/platform/alerting/alert.js';
import type { ClockService } from '../../modules/platform/clock.service.js';
import { ErrorReporter } from './error-reporter.service.js';
import { Counter, Gauge, Histogram, renderAll } from './metrics.js';
import type { MetricsService } from './metrics.service.js';
import {
  currentTrace,
  formatTraceparent,
  outboundTraceparent,
  parseTraceparent,
  runInTrace,
  traceForRequest,
} from './trace.js';
import { tracedFetch } from './traced-fetch.js';

const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const P = '00f067aa0ba902b7';

describe('W3C trace context', () => {
  it('continues a valid incoming traceparent with a new span', () => {
    const trace = traceForRequest(`00-${T}-${P}-01`, 'req-1');
    expect(trace.traceId).toBe(T);
    expect(trace.spanId).not.toBe(P);
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.sampled).toBe(true);
  });

  it('starts a new trace for a missing, malformed, unknown-version or all-zero header', () => {
    for (const header of [
      undefined,
      'garbage',
      `01-${T}-${P}-01`,
      `00-${'0'.repeat(32)}-${P}-01`,
      `00-${T}-${'0'.repeat(16)}-01`,
    ]) {
      expect(parseTraceparent(header)).toBeNull();
      expect(traceForRequest(header, null).traceId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('formats round-trip, and outbound calls get a child of the current trace', () => {
    expect(parseTraceparent(formatTraceparent(T, P, false))).toEqual({
      traceId: T,
      sampled: false,
    });
    expect(outboundTraceparent()).toBeNull();
    runInTrace({ traceId: T, spanId: P, requestId: 'r', sampled: true }, () => {
      expect(currentTrace()?.traceId).toBe(T);
      const child = outboundTraceparent() ?? '';
      expect(child).toMatch(new RegExp(`^00-${T}-[0-9a-f]{16}-01$`));
      expect(child).not.toContain(P);
    });
  });
});

describe('Prometheus text exposition', () => {
  it('renders counters, gauges and histograms with escaped, sorted labels', () => {
    const c = new Counter('t_requests_total', 'help');
    c.inc({ route: '/a', method: 'GET' });
    c.inc({ method: 'GET', route: '/a' });
    c.inc({ route: 'quote"d' });
    const g = new Gauge('t_rows', 'rows');
    g.set(3, { state: 'dead' });
    const h = new Histogram('t_seconds', 'sec', [0.1, 1]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(5);
    const text = renderAll([c, g, h]);
    expect(text).toContain('# TYPE t_requests_total counter');
    expect(text).toContain('t_requests_total{method="GET",route="/a"} 2');
    expect(text).toContain('t_requests_total{route="quote\\"d"} 1');
    expect(text).toContain('t_rows{state="dead"} 3');
    expect(text).toContain('t_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('t_seconds_bucket{le="1"} 2');
    expect(text).toContain('t_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('t_seconds_count 3');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('tracedFetch', () => {
  it('adds a child traceparent inside a trace and records the outcome', async () => {
    const seen: RequestInit[] = [];
    const recorded: string[] = [];
    const fetchImpl = tracedFetch(
      'razorpay',
      { recordExternal: (provider, outcome) => recorded.push(`${provider}:${outcome}`) },
      (_url, init) => {
        seen.push(init);
        return Promise.resolve(new Response('{}', { status: 503 }));
      },
    );
    await runInTrace({ traceId: T, spanId: P, requestId: null, sampled: true }, () =>
      fetchImpl('https://x', { method: 'GET', headers: { accept: 'application/json' } }),
    );
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers['traceparent']).toMatch(new RegExp(`^00-${T}-`));
    expect(headers['accept']).toBe('application/json');
    expect(recorded).toEqual(['razorpay:http_5xx']);
  });

  it('records a thrown fetch as error and rethrows', async () => {
    const recorded: string[] = [];
    const fetchImpl = tracedFetch(
      'gst_sandbox',
      { recordExternal: (p, o) => recorded.push(`${p}:${o}`) },
      () => Promise.reject(new TypeError('fetch failed')),
    );
    await expect(fetchImpl('https://x', {})).rejects.toThrow('fetch failed');
    expect(recorded).toEqual(['gst_sandbox:error']);
  });
});

describe('ErrorReporter', () => {
  function setup(sinkOk = true) {
    let now = Date.parse('2026-11-17T10:00:00Z');
    const sent: Alert[] = [];
    const sink: AlertSink = {
      name: 'test',
      send: (alert) =>
        sinkOk ? (sent.push(alert), Promise.resolve()) : Promise.reject(new Error('down')),
    };
    const metrics = { unhandledErrors: new Counter('e', 'e') } as unknown as MetricsService;
    const clock = { now: () => new Date(now) } as ClockService;
    const reporter = new ErrorReporter(
      metrics,
      clock,
      new ConfigService({ ALERT_REPEAT_MS: 1_800_000 }),
      [sink],
    );
    const report = (message = 'boom') =>
      reporter.report({
        name: 'TypeError',
        message,
        method: 'GET',
        route: '/api/v1/x',
        requestId: 'r1',
        traceId: T,
      });
    return { reporter, sent, report, metrics, advance: (ms: number) => (now += ms) };
  }

  it('groups by fingerprint and sends one digest with counts and ids, nothing from report()', async () => {
    const { reporter, sent, report, metrics } = setup();
    report();
    report();
    report('other');
    expect(sent).toHaveLength(0);
    expect(await reporter.flush()).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('API_ERRORS');
    expect(sent[0]?.summary).toBe('3 unexpected server error(s) in 2 kind(s)');
    expect(sent[0]?.details.join('\n')).toContain(`trace ${T}`);
    expect((metrics.unhandledErrors as Counter).get({ name: 'TypeError' })).toBe(3);
  });

  it('redacts the message it carries', async () => {
    const { reporter, sent, report } = setup();
    report('could not mail asha@example.com');
    await reporter.flush();
    expect(sent[0]?.details[0]).toContain('[email]');
    expect(sent[0]?.details[0]).not.toContain('asha@');
  });

  it('a fingerprint repeats only after the cooldown; a failed send keeps it pending', async () => {
    const { reporter, sent, report, advance } = setup();
    report();
    await reporter.flush();
    report();
    expect(await reporter.flush()).toBe(0);
    advance(1_800_001);
    expect(await reporter.flush()).toBe(1);
    expect(sent).toHaveLength(2);

    const down = setup(false);
    down.report();
    expect(await down.reporter.flush()).toBe(0);
    expect(await down.reporter.flush()).toBe(0);
  });

  it('starts no timer without a sink', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const metrics = { unhandledErrors: new Counter('e', 'e') } as unknown as MetricsService;
    new ErrorReporter(
      metrics,
      { now: () => new Date() } as ClockService,
      new ConfigService({}),
      [],
    ).onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
