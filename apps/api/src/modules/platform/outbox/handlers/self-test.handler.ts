/**
 * The fake handler.
 *
 * ===========================================================================
 * Calls nothing. Exists so the plumbing can be proven without a provider.
 *
 * Phase A implements the outbox and the worker, not an OTA integration. This
 * handler performs no network call of any kind: it reads its own payload,
 * optionally sleeps, optionally throws, and records what it did in an
 * in-memory ledger the tests inspect.
 *
 * It follows the pattern `platform/mail` already uses -- a real adapter
 * (`SmtpMailer`) beside a fake one (`LogMailer`) behind a shared interface --
 * so a real handler can replace it without the worker changing.
 *
 * The failure controls are what make retry, backoff and dead-lettering
 * testable deterministically. Asking for two failures gets exactly two, then a
 * success; that is the only way to assert the retry path without waiting for a
 * real provider to misbehave on cue.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import { outboxSelfTestPayloadSchema, type OutboxEventType } from '@repo/types';

import {
  OutboxPermanentError,
  type OutboxHandler,
  type OutboxHandlerContext,
} from '../outbox-handler.registry.js';

/** One handler run, as the tests read it back. */
export interface SelfTestRun {
  outboxEventId: string;
  propertyId: string;
  nonce: string;
  attempt: number;
  at: number;
  outcome: 'succeeded' | 'failed';
}

@Injectable()
export class OutboxSelfTestHandler implements OutboxHandler {
  readonly eventType: OutboxEventType = 'OUTBOX_SELF_TEST';

  private readonly logger = new Logger(OutboxSelfTestHandler.name);

  /**
   * Every run, in order.
   *
   * In-process and unbounded-ish, which is fine because nothing enqueues this
   * event type outside tests. A real handler would never keep this.
   */
  private readonly runs: SelfTestRun[] = [];

  /** How many times each nonce has been attempted, for `failTimes`. */
  private readonly attemptsByNonce = new Map<string, number>();

  async handle(context: OutboxHandlerContext): Promise<void> {
    // Parsed again here rather than trusting the worker. The worker does
    // validate, but a handler that assumes its input is the one thing a
    // handler should never assume.
    const payload = outboxSelfTestPayloadSchema.parse(context.payload);

    const seen = (this.attemptsByNonce.get(payload.nonce) ?? 0) + 1;
    this.attemptsByNonce.set(payload.nonce, seen);

    if (payload.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
    }

    const shouldFail = payload.failForever || seen <= payload.failTimes;

    this.runs.push({
      outboxEventId: context.outboxEventId,
      propertyId: context.propertyId,
      nonce: payload.nonce,
      attempt: context.attempt,
      at: Date.now(),
      outcome: shouldFail ? 'failed' : 'succeeded',
    });

    if (shouldFail) {
      if (payload.failForever) {
        // Transient on purpose: this drives the row through its whole retry
        // budget to DEAD, which is the path worth testing. A permanent error
        // would dead-letter on the first attempt and prove less.
        throw new Error(`self-test deliberate failure (attempt ${String(seen)})`);
      }
      throw new Error(`self-test transient failure ${String(seen)}/${String(payload.failTimes)}`);
    }

    this.logger.debug(
      `Self-test handled: nonce=${payload.nonce} attempt=${String(context.attempt)} ` +
        `property=${context.propertyId}`,
    );
  }

  /** Runs recorded for a nonce, for assertions. */
  runsFor(nonce: string): SelfTestRun[] {
    return this.runs.filter((run) => run.nonce === nonce);
  }

  get allRuns(): readonly SelfTestRun[] {
    return this.runs;
  }

  reset(): void {
    this.runs.length = 0;
    this.attemptsByNonce.clear();
  }

  /** Demonstrates the permanent path for anything that needs it later. */
  static permanent(message: string): OutboxPermanentError {
    return new OutboxPermanentError(message);
  }
}
