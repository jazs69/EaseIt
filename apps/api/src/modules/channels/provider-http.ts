/**
 * The HTTP leg every channel adapter shares: an explicit timeout, a circuit
 * breaker, and a `ProviderCall` record of every exchange (CLAUDE.md section
 * 5: "external calls always have an explicit timeout, bounded retries with
 * backoff, and a circuit breaker").
 *
 * Retries are deliberately NOT here. The outbox owns them, with jittered
 * backoff recorded in PostgreSQL; a second retry loop in the adapter would be
 * a second counter that disagrees with the first.
 *
 * The breaker is per adapter instance (one per provider, per process). After
 * `failureThreshold` consecutive retryable failures it opens for `openMs` and
 * every call fails fast as retryable without touching the network, so a
 * provider outage costs one quick failure per job rather than a timeout each,
 * and the provider is not hammered while it recovers. A failing OTA degrades
 * the sync layer, never the front desk: nothing on a request path calls this.
 */

import { ChannelProviderError, type ProviderCall, type SyncOperation } from './channel-adapter.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderRequest {
  operation: SyncOperation;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** False when the request or response carries personal data. */
  recordRequest: boolean;
  recordResponse: boolean;
}

export interface ProviderResponse {
  call: ProviderCall;
  body: unknown;
}

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly openMs: number,
    private readonly now: () => number,
  ) {}

  get isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  succeeded(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  failed(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openUntil = this.now() + this.openMs;
      this.failures = 0;
    }
  }
}

/** HTTP statuses a retry can fix: rate limiting and the provider's own faults. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class ProviderHttp {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs: number,
    private readonly breaker: CircuitBreaker,
    private readonly now: () => number,
    /** Reads the provider's short error text from a failed body. */
    private readonly describeError: (body: unknown) => string,
  ) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const started = this.now();
    const base = {
      operation: request.operation,
      method: request.method,
      path: request.path,
      requestBody: request.recordRequest ? (request.body ?? null) : null,
    };

    if (this.breaker.isOpen) {
      const call: ProviderCall = {
        ...base,
        responseStatus: null,
        responseBody: null,
        ok: false,
        error: 'Circuit open: the provider failed repeatedly; not called.',
        durationMs: 0,
      };
      throw new ChannelProviderError(call.error ?? 'circuit open', true, [call]);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${request.path}`, {
        method: request.method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          ...this.headers,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (cause) {
      // A timeout is "unknown", not "failed": the provider may have applied
      // it. Safe to retry only because every push is full state.
      this.breaker.failed();
      const reason =
        cause instanceof Error && cause.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      const call: ProviderCall = {
        ...base,
        responseStatus: null,
        responseBody: null,
        ok: false,
        error: `The provider was ${reason}.`,
        durationMs: this.now() - started,
      };
      throw new ChannelProviderError(call.error ?? reason, true, [call]);
    }

    let body: unknown = null;
    const text = await response.text().catch(() => '');
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { unparsed: text.slice(0, 500) };
      }
    }

    const durationMs = this.now() - started;
    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      if (retryable) this.breaker.failed();
      const error = `HTTP ${String(response.status)}: ${this.describeError(body).slice(0, 300)}`;
      const call: ProviderCall = {
        ...base,
        responseStatus: response.status,
        responseBody: request.recordResponse ? body : null,
        ok: false,
        error,
        durationMs,
      };
      throw new ChannelProviderError(error, retryable, [call]);
    }

    this.breaker.succeeded();
    return {
      body,
      call: {
        ...base,
        responseStatus: response.status,
        responseBody: request.recordResponse ? body : null,
        ok: true,
        error: null,
        durationMs,
      },
    };
  }
}
