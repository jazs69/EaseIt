/**
 * The injected clock (CLAUDE.md section 5).
 *
 * `new Date()` and `Date.now()` do not appear in domain code. Everything that
 * needs the time asks this service, which is the only reason a test can prove
 * that a one-time code expires after exactly ten minutes, or that a resend is
 * refused one second inside its cooldown, without actually waiting.
 *
 * It returns instants only. Calendar values — a property's business date, a
 * stay date — are never derived from the server's own day: they come from the
 * property's IANA timezone through the helpers in @repo/types
 * (CLAUDE.md section 3.3).
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class ClockService {
  /** The current instant, always UTC. */
  now(): Date {
    return new Date();
  }

  /** Milliseconds since the epoch. */
  nowMs(): number {
    return this.now().getTime();
  }

  /** `now + seconds`, for expiry and cooldown arithmetic. */
  plusSeconds(seconds: number): Date {
    return new Date(this.nowMs() + seconds * 1_000);
  }
}
