/**
 * Timeout, bounded retries, a circuit breaker and a small cache around one
 * GST provider (GP-04; CLAUDE.md section 5: "External calls ... always have an
 * explicit timeout, bounded retries with backoff, and a circuit breaker").
 *
 * ===========================================================================
 * - **Timeout** per attempt, by AbortSignal.
 * - **Retries**: at most `maxAttempts` (2) in total, only for a retryable
 *   failure (network, timeout, 429, 5xx), with jittered backoff. A 4xx is
 *   permanent for this request and is not retried.
 * - **Breaker**: after `failureThreshold` consecutive failed lookups it opens
 *   for `openMs`; while open nothing is sent and the caller gets the
 *   UNVERIFIED fallback at once. The first lookup after `openMs` is the
 *   half-open probe: success closes it, failure re-opens it.
 * - **Cache**: a definite answer (found or not found) is kept per GSTIN for
 *   `cacheTtlMs`, bounded to `cacheSize` entries. Lookups are metered; the
 *   booking form and the save both look the same number up.
 *
 * "Not found" is a success for the breaker: the provider answered.
 * Everything is in memory, per process; that is enough at ten properties.
 * ===========================================================================
 */

import type { GstProvider, TaxpayerOutcome } from './provider.js';
import { GstProviderError } from './provider.js';

export interface ResilienceOptions {
  timeoutMs: number;
  maxAttempts: number;
  failureThreshold: number;
  openMs: number;
  cacheTtlMs: number;
  cacheSize: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type ResilientOutcome =
  TaxpayerOutcome | { kind: 'unavailable'; reason: 'circuit_open' | 'failed'; detail: string };

export class ResilientGstLookup {
  private consecutiveFailures = 0;
  private openUntil = 0;
  private readonly cache = new Map<string, { outcome: TaxpayerOutcome; expiresAt: number }>();

  constructor(
    private readonly provider: GstProvider,
    private readonly options: ResilienceOptions,
  ) {}

  /** For logs and health: whether lookups are currently being skipped. */
  isOpen(): boolean {
    return this.options.now() < this.openUntil;
  }

  async lookup(gstin: string): Promise<ResilientOutcome> {
    const now = this.options.now();
    const cached = this.cache.get(gstin);
    if (cached !== undefined && cached.expiresAt > now) return cached.outcome;
    if (cached !== undefined) this.cache.delete(gstin);

    if (now < this.openUntil) {
      return { kind: 'unavailable', reason: 'circuit_open', detail: 'circuit open' };
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const outcome = await this.attempt(gstin);
        this.consecutiveFailures = 0;
        this.remember(gstin, outcome);
        return outcome;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof GstProviderError ? error.retryable : true;
        if (!retryable || attempt === this.options.maxAttempts) break;
        // 200-400 ms, then more if maxAttempts were ever raised.
        await this.options.sleep(200 * attempt + Math.floor(Math.random() * 200));
      }
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.openUntil = this.options.now() + this.options.openMs;
      this.consecutiveFailures = 0;
    }
    return {
      kind: 'unavailable',
      reason: 'failed',
      detail: lastError instanceof Error ? lastError.message : 'unknown error',
    };
  }

  private async attempt(gstin: string): Promise<TaxpayerOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs);
    try {
      return await this.provider.lookup(gstin, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(gstin: string, outcome: TaxpayerOutcome): void {
    if (this.cache.size >= this.options.cacheSize) {
      // Oldest insertion first: Map iterates in insertion order.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(gstin, { outcome, expiresAt: this.options.now() + this.options.cacheTtlMs });
  }
}
