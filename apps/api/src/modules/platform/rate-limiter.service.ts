/**
 * Fixed-window request counter, held in this process's memory.
 *
 * ===========================================================================
 * Why in-memory, and when that stops being true.
 *
 * At the scale in CLAUDE.md section 1 — ten properties, ~50 staff, one
 * deployable API — there is exactly one process counting, so a local map is
 * both correct and the cheapest thing that works. CLAUDE.md section 6.4 asks
 * for a reason before reaching for more infrastructure, and here there is
 * none: Redis is already in the stack for BullMQ, but routing every login
 * attempt through it would buy nothing today.
 *
 * It becomes wrong the moment the API runs more than one replica, because each
 * replica would then allow the full quota. The fix at that point is to move
 * these counters into the Redis that is already there, not to raise the
 * limits. The call sites do not change — they ask this service, which is the
 * seam.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';

import { ClockService } from './clock.service.js';

interface Window {
  count: number;
  /** Epoch ms at which this window's count resets to zero. */
  resetAtMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may retry. Zero when allowed. */
  retryAfterSeconds: number;
  remaining: number;
}

/**
 * Above this many live keys, expired windows are swept before the next read.
 * Without it a login endpoint under a distributed scan would accumulate one
 * entry per source address forever, which is a memory leak with a hostile
 * party holding the tap.
 */
const SWEEP_THRESHOLD = 2_048;

@Injectable()
export class RateLimiterService {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly clock: ClockService) {}

  /**
   * Records one attempt against `key` and reports whether it is allowed.
   *
   * Counts the attempt even when refusing, so a caller that keeps hammering
   * keeps extending nothing — the window is fixed, not sliding — but also
   * never gets a free retry by racing.
   */
  consume(key: string, limit: number, windowSeconds: number): RateLimitDecision {
    const nowMs = this.clock.nowMs();

    if (this.windows.size > SWEEP_THRESHOLD) {
      this.sweep(nowMs);
    }

    const existing = this.windows.get(key);
    const window =
      existing === undefined || existing.resetAtMs <= nowMs
        ? { count: 0, resetAtMs: nowMs + windowSeconds * 1_000 }
        : existing;

    window.count += 1;
    this.windows.set(key, window);

    const allowed = window.count <= limit;

    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((window.resetAtMs - nowMs) / 1_000)),
      remaining: Math.max(0, limit - window.count),
    };
  }

  /**
   * Forgets `key`, so a successful operation does not leave the operator
   * part-way to a lockout. Called after a sign-in completes: it is wrong
   * failures that should accumulate, not use.
   */
  reset(key: string): void {
    this.windows.delete(key);
  }

  private sweep(nowMs: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAtMs <= nowMs) {
        this.windows.delete(key);
      }
    }
  }
}
