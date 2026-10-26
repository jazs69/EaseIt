/**
 * Outbox event contracts.
 *
 * ===========================================================================
 * One schema per event type, versioned, and validated twice.
 *
 * CLAUDE.md section 5 makes zod the single source of truth for every shape
 * that crosses a boundary, and an outbox row crosses the biggest boundary in
 * the system: it is written by one process and read by another, possibly a
 * deploy later. So a payload is validated **at enqueue**, so a malformed event
 * can never reach the table, and **again at handling**, because the worker
 * reading the row may be older or newer than the producer that wrote it.
 *
 * PAYLOADS CARRY NO PII AND NO SECRETS. A payload is a *reference to work* --
 * identifiers, a date range, a counter -- never a guest name, email, address,
 * government ID or card detail, and never a credential. The handler re-reads
 * whatever it needs from the database under the tenant scope the row names.
 * This is not merely tidiness: an outbox row outlives the request that made
 * it, is read by a second process, and ends up in logs and backlog dashboards,
 * so anything personal in it leaks much further than it would in a response.
 * ===========================================================================
 */

import { z } from 'zod';

/**
 * The event types the system knows how to handle.
 *
 * Phase A carries exactly one, and it is a self-test with no business
 * meaning. Real ARI event types land with the `channels` module once the
 * provider contract is known (CLAUDE.md section 2); inventing them now would
 * bake in a shape the OTAs have not agreed to.
 */
export const outboxEventTypeSchema = z.enum(['OUTBOX_SELF_TEST']);

export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>;

/**
 * How a row's `dedupeKey` constrains other rows. See the database comment on
 * `OutboxDedupeMode` for why one mode cannot serve both purposes.
 */
export const outboxDedupeModeSchema = z.enum(['COALESCE', 'UNIQUE_FOREVER']);

export type OutboxDedupeMode = z.infer<typeof outboxDedupeModeSchema>;

export const outboxStatusSchema = z.enum(['PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'DEAD']);

export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

/* -------------------------------------------------------------------------- */
/*  Payloads                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The self-test payload.
 *
 * `nonce` lets a test correlate the row it wrote with the handler run it
 * caused, without the handler needing to know anything about the test.
 *
 * `failTimes` and `failForever` exist so the retry and dead-letter paths can
 * be exercised deterministically. A test asking for two failures gets exactly
 * two, then a success -- which is the only way to assert backoff and terminal
 * handling without waiting for a real provider to misbehave. They are inert in
 * production because nothing enqueues this event type outside tests.
 */
export const outboxSelfTestPayloadSchema = z.object({
  nonce: z.string().min(1).max(64),
  /** Fail this many attempts, then succeed. */
  failTimes: z.number().int().min(0).max(20).default(0),
  /** Fail every attempt, to drive the row to DEAD. */
  failForever: z.boolean().default(false),
  /** Sleep this long inside the handler, to exercise timeouts and leases. */
  delayMs: z.number().int().min(0).max(60_000).default(0),
});

export type OutboxSelfTestPayload = z.infer<typeof outboxSelfTestPayloadSchema>;

/* -------------------------------------------------------------------------- */
/*  Registry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The current payload version per event type.
 *
 * A producer stamps this onto the row. A worker refuses a version it does not
 * recognise rather than guessing -- an unknown *newer* version means this
 * worker is behind a deploy and should leave the row for one that is current,
 * which is a retry, not a failure.
 */
export const OUTBOX_PAYLOAD_VERSION: Record<OutboxEventType, number> = {
  OUTBOX_SELF_TEST: 1,
};

/**
 * Payload schema per `(type, version)`.
 *
 * Keyed on both because the point of versioning is to let two shapes coexist
 * while a deploy rolls. When a payload changes, add a new entry rather than
 * editing the old one, and keep the old one until no rows carry it.
 */
export const OUTBOX_PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
  'OUTBOX_SELF_TEST:1': outboxSelfTestPayloadSchema,
};

export function outboxPayloadSchemaFor(
  eventType: OutboxEventType,
  payloadVersion: number,
): z.ZodType | undefined {
  return OUTBOX_PAYLOAD_SCHEMAS[`${eventType}:${String(payloadVersion)}`];
}

/* -------------------------------------------------------------------------- */
/*  Operator-facing views                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Backlog metrics.
 *
 * Deliberately separate from readiness. A backlog is a workload signal, not a
 * dependency failure: an API with ten thousand pending events is working
 * exactly as designed and must not be pulled out of a load balancer for it.
 * See `07-sync-and-failure-handling.md` and the health controller.
 */
export const outboxBacklogSchema = z.object({
  pending: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
  /** Age of the oldest row still waiting, in seconds. Null when none waits. */
  oldestPendingAgeSeconds: z.number().int().nonnegative().nullable(),
  /** Rows whose lease has expired and which the reaper will reclaim. */
  staleLeases: z.number().int().nonnegative(),
  /** Cumulative counters since this process started. */
  processedSinceBoot: z.number().int().nonnegative(),
  failedSinceBoot: z.number().int().nonnegative(),
  retriedSinceBoot: z.number().int().nonnegative(),
  recoveredSinceBoot: z.number().int().nonnegative(),
});

export type OutboxBacklog = z.infer<typeof outboxBacklogSchema>;
