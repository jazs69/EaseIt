/**
 * Maps an event type to the code that performs it.
 *
 * A registry rather than a switch so a handler can be added without editing
 * the worker, and so an unregistered type is a loud, specific failure instead
 * of a silently skipped row.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { OutboxEventType } from '@repo/types';

/** What a handler is given. Identifiers and a validated payload, nothing else. */
export interface OutboxHandlerContext {
  outboxEventId: string;
  propertyId: string;
  /** Validated against the registered schema for this type and version. */
  payload: unknown;
  /** 1 for the first try. Handlers may log it; they must not branch on it. */
  attempt: number;
}

export interface OutboxHandler {
  readonly eventType: OutboxEventType;
  /**
   * Performs the side effect.
   *
   * **Must be safe to run twice.** Delivery is at-least-once: a worker that
   * dies after calling a provider but before recording success will be
   * redelivered the same event. See `outbox.service.ts` for the three ways to
   * make that safe.
   *
   * Throw to fail. A thrown `OutboxPermanentError` skips the remaining retry
   * budget and dead-letters immediately; anything else is treated as transient
   * and retried until the budget is exhausted.
   */
  handle(context: OutboxHandlerContext): Promise<void>;
}

/**
 * A failure that retrying cannot fix.
 *
 * A malformed payload, an unmapped room type, a permanently rejected request.
 * Retrying these five times with backoff wastes a budget that exists for
 * transient faults, and delays the dead-letter alert that an operator needs.
 */
export class OutboxPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxPermanentError';
  }
}

@Injectable()
export class OutboxHandlerRegistry {
  private readonly logger = new Logger(OutboxHandlerRegistry.name);
  private readonly handlers = new Map<string, OutboxHandler>();

  register(handler: OutboxHandler): void {
    if (this.handlers.has(handler.eventType)) {
      throw new Error(`Two handlers registered for outbox event ${handler.eventType}.`);
    }
    this.handlers.set(handler.eventType, handler);
    this.logger.log(`Registered outbox handler for ${handler.eventType}.`);
  }

  get(eventType: string): OutboxHandler | undefined {
    return this.handlers.get(eventType);
  }

  get registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }
}
