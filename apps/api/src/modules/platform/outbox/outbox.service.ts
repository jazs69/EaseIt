/**
 * The transactional outbox: recording a side effect inside the transaction
 * that caused it.
 *
 * ===========================================================================
 * This service does exactly one thing to the outside world: nothing.
 *
 * `enqueue` is a single INSERT (or coalescing UPDATE) on the caller's own
 * transaction handle. No Redis, no HTTP, no mail, no clock reads that matter.
 * That is the whole point: CLAUDE.md section 3.1 forbids those inside a
 * transaction, so the only safe thing to do *inside* one is write a row
 * promising to do the work later.
 *
 * THE IDEMPOTENCY THAT THIS BUYS, AND THE ONE IT DOES NOT
 *
 * **The enqueue is genuinely idempotent**, and that is a real guarantee. The
 * row shares the business transaction, so either the reservation and its
 * outbox row both commit or neither does. There is no window in which a
 * booking exists with no promise to publish it, and none in which a promise
 * exists for a booking that rolled back. A duplicate enqueue is refused by a
 * partial unique index, not by a read-then-write race.
 *
 * **The external operation is not idempotent, and cannot be made so from
 * here.** Once the worker calls a provider and the call times out, we do not
 * know whether it was applied: a timeout means *unknown*, not *failed*. There
 * is no transaction spanning PostgreSQL and someone else's API, so this outbox
 * delivers **at-least-once, never exactly-once**. Exactly-once has to be
 * bought in the handler, by one of:
 *
 *   - **full-state writes** -- push the whole window rather than a delta, so
 *     re-sending produces the same remote state (the research on Agoda's
 *     full-overwrite ARI semantics is exactly this), or
 *   - **a provider-side idempotency key**, where the provider offers one, or
 *   - **an acknowledgement the provider owns**, like Channex's revision feed
 *     where the consumer acknowledges after saving.
 *
 * A handler that satisfies none of these is unsafe to retry, and no amount of
 * care in this file fixes that.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  outboxPayloadSchemaFor,
  OUTBOX_PAYLOAD_VERSION,
  type OutboxDedupeMode,
  type OutboxEventType,
} from '@repo/types';
import type { Prisma } from '@repo/database';

import { ValidationFailedError } from '../../../common/errors/domain-error.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

/** The subset of a Prisma client this service needs, so a `tx` satisfies it. */
export interface OutboxWriter {
  outboxEvent: {
    create: (args: { data: Prisma.OutboxEventUncheckedCreateInput; select: { id: true } }) => Promise<{ id: string }>;
    updateMany: (args: {
      where: Prisma.OutboxEventWhereInput;
      data: Prisma.OutboxEventUncheckedUpdateManyInput;
    }) => Promise<{ count: number }>;
  };
}

export interface EnqueueInput {
  propertyId: string;
  eventType: OutboxEventType;
  /** Validated against the registered schema for this type and version. */
  payload: unknown;
  /**
   * Groups rows that mean the same work.
   *
   * For a coalescible event this is the *scope* of the work -- for a future ARI
   * push, something like `ari:<roomTypeId>:<from>:<to>`. For a unique-forever
   * event it is the identity of the thing that must happen once, such as
   * `confirmation-email:<reservationId>`.
   */
  dedupeKey: string;
  dedupeMode?: OutboxDedupeMode;
  maxAttempts?: number;
  /** Earliest publication time. Omit for "as soon as possible". */
  availableAt?: Date;
}

export interface EnqueueResult {
  id: string | null;
  /** What the call actually did, which the caller may want to log. */
  outcome: 'created' | 'coalesced' | 'suppressed';
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an event on the caller's transaction.
   *
   * Pass the `tx` from `prisma.$transaction(async (tx) => ...)`. Passing the
   * root client works and is correct for a standalone enqueue, but then the
   * atomicity guarantee above does not apply -- there is no business change to
   * be atomic with.
   */
  async enqueue(writer: OutboxWriter, input: EnqueueInput): Promise<EnqueueResult> {
    const version = OUTBOX_PAYLOAD_VERSION[input.eventType];
    const schema = outboxPayloadSchemaFor(input.eventType, version);

    if (schema === undefined) {
      // Unreachable while the registry and the enum agree; asserted so that
      // adding an event type without a schema fails at the first enqueue
      // rather than in a worker at 3am.
      throw new ValidationFailedError({
        eventType: `No payload schema registered for ${input.eventType} v${String(version)}.`,
      });
    }

    const parsed = schema.safeParse(input.payload);
    if (!parsed.success) {
      /**
       * Rejected here, before the row exists.
       *
       * A malformed payload that reaches the table is a job that can only ever
       * fail, consuming its whole retry budget on the way to a dead letter and
       * paging someone about a bug that was visible at the call site. The
       * field paths are safe to surface; the *values* are not, and are not
       * included.
       */
      throw new ValidationFailedError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            `payload.${issue.path.join('.') || 'root'}`,
            issue.message,
          ]),
        ),
      );
    }

    const mode: OutboxDedupeMode = input.dedupeMode ?? 'COALESCE';
    const data = {
      propertyId: input.propertyId,
      eventType: input.eventType,
      payloadVersion: version,
      payload: parsed.data as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey,
      dedupeMode: mode,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
    };

    if (mode === 'COALESCE') {
      /**
       * Coalescing: the latest intent wins.
       *
       * An UPDATE first, then an INSERT if nothing was updated. Deliberately
       * not an upsert: the partial unique index this relies on is conditional
       * (`WHERE dedupeMode = 'COALESCE' AND status = 'PENDING'`), and Prisma's
       * upsert cannot target a conditional index.
       *
       * The UPDATE refreshes the payload and brings `availableAt` forward, so
       * five enqueues before the worker drains become one push carrying the
       * newest state -- which is the entire reason this mode exists.
       *
       * Both statements run on the caller's transaction, so the sequence is
       * atomic with the business change. A concurrent transaction racing the
       * same key is serialised by the unique index: the loser's INSERT raises
       * a unique violation, which the caller's retry policy handles exactly as
       * it already handles 23505 elsewhere.
       */
      const updated = await writer.outboxEvent.updateMany({
        where: {
          propertyId: input.propertyId,
          dedupeKey: input.dedupeKey,
          dedupeMode: 'COALESCE',
          status: 'PENDING',
        },
        data: {
          payload: data.payload,
          payloadVersion: version,
          availableAt: input.availableAt ?? new Date(),
          // The retry budget resets with the new intent: this is a fresh
          // instruction, not another go at the previous one.
          attempts: 0,
          lastError: null,
          lastErrorAt: null,
        },
      });

      if (updated.count > 0) {
        return { id: null, outcome: 'coalesced' };
      }
    }

    try {
      const row = await writer.outboxEvent.create({ data, select: { id: true } });
      return { id: row.id, outcome: 'created' };
    } catch (cause) {
      /**
       * A unique violation on a UNIQUE_FOREVER key means the work is already
       * recorded -- which is success, not failure.
       *
       * This is the whole point of that mode: "send this confirmation once".
       * A second call saying the same thing has nothing to do. Swallowing the
       * violation here is safe precisely because the index guarantees the
       * first row exists; it is not a blind catch.
       */
      if (mode === 'UNIQUE_FOREVER' && isUniqueViolation(cause)) {
        this.logger.debug(
          `Outbox event suppressed as already recorded: ${input.eventType} key=${input.dedupeKey}`,
        );
        return { id: null, outcome: 'suppressed' };
      }
      throw cause;
    }
  }

  /** Convenience for an enqueue with no business transaction to join. */
  enqueueStandalone(input: EnqueueInput): Promise<EnqueueResult> {
    return this.enqueue(this.prisma.client as unknown as OutboxWriter, input);
  }
}

/**
 * Prisma's unique-constraint code.
 *
 * `P2002` is the client's code for it; the underlying SQLSTATE is 23505. Both
 * are checked because a raw query surfaces the latter while the query builder
 * surfaces the former, and this service is reachable through either.
 */
function isUniqueViolation(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false;
  const code = (cause as { code?: unknown }).code;
  return code === 'P2002' || code === '23505';
}
