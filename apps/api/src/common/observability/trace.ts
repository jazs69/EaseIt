/**
 * W3C Trace Context for requests and outbound calls (OB-05).
 *
 * ===========================================================================
 * Every request belongs to a trace. An incoming `traceparent` header
 * (`00-<32 hex trace id>-<16 hex parent span>-<2 hex flags>`, version 00 only,
 * all-zero ids refused) is continued; anything else starts a new trace. The
 * request's own span id is new either way.
 *
 * The request answers with its `traceparent` and `x-request-id`, so a client
 * or a load balancer log can be joined to this process's log. Every log line
 * written while handling it carries the trace id (`RedactingLogger`), and
 * every outbound HTTP call made inside it (Razorpay, the GST provider, the
 * alert webhook) carries a child `traceparent` (`tracedFetch`), so a slow
 * provider call can be found from the request that made it.
 *
 * No tracing backend is required: the ids are correlation keys in logs and
 * headers. An OpenTelemetry collector can be added later without changing
 * them, because they already are W3C Trace Context.
 * ===========================================================================
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  requestId: string | null;
  sampled: boolean;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** The trace a request continues, from its `traceparent`, or null to start one. */
export function parseTraceparent(header: unknown): { traceId: string; sampled: boolean } | null {
  if (typeof header !== 'string') return null;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (match === null) return null;
  const [, traceId = '', parent = '', flags = '00'] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(parent)) return null;
  return { traceId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

/** A request's trace: the incoming one continued, or a new one. */
export function traceForRequest(header: unknown, requestId: string | null): TraceContext {
  const incoming = parseTraceparent(header);
  return {
    traceId: incoming?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    requestId,
    sampled: incoming?.sampled ?? true,
  };
}

const store = new AsyncLocalStorage<TraceContext>();

export function runInTrace<T>(trace: TraceContext, work: () => T): T {
  return store.run(trace, work);
}

export function currentTrace(): TraceContext | null {
  return store.getStore() ?? null;
}

/** The header for an outbound call: same trace, a new child span. Null outside a trace. */
export function outboundTraceparent(): string | null {
  const trace = currentTrace();
  return trace === null ? null : formatTraceparent(trace.traceId, newSpanId(), trace.sampled);
}
