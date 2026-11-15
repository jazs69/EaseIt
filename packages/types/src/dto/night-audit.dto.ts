/**
 * Night audit (CLAUDE.md section 3.3; NA-01 .. NA-07).
 *
 * ===========================================================================
 * A request can only *enqueue* a run and read its progress. The run itself is
 * executed by the worker, step by step, each step committed on its own. These
 * are the wire shapes for the enqueue and the progress read; nothing here
 * accepts a business date from the client -- a run always closes the
 * property's current business date, which the server owns.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

/** The eight canonical steps, in order (section 3.3). */
export const NIGHT_AUDIT_STEPS = [
  { step: 1, name: 'VALIDATE_PRECONDITIONS', label: 'Validate preconditions' },
  { step: 2, name: 'ROLL_NO_SHOWS', label: 'Roll no-shows' },
  { step: 3, name: 'POST_ROOM_CHARGES', label: 'Post room charges and taxes' },
  { step: 4, name: 'POST_RECURRING_CHARGES', label: 'Post recurring charges' },
  { step: 5, name: 'SETTLE_FOLIOS', label: 'Settle and close zero-balance folios' },
  { step: 6, name: 'SNAPSHOT_STATISTICS', label: 'Snapshot daily statistics' },
  { step: 7, name: 'ADVANCE_BUSINESS_DATE', label: 'Advance the business date' },
  { step: 8, name: 'EMIT_NOTIFICATIONS', label: 'Emit reports and notifications' },
] as const;

export const nightAuditRunStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);
export type NightAuditRunStatus = z.infer<typeof nightAuditRunStatusSchema>;

export const nightAuditStepViewSchema = z.object({
  step: z.number().int().min(1).max(8),
  name: z.string(),
  label: z.string(),
  /** NOT_STARTED when no row exists yet for the step. */
  status: z.enum(['NOT_STARTED', 'COMPLETED', 'FAILED']),
  /** Counts, exceptions and figures the step recorded. */
  outcome: z.record(z.string(), z.unknown()).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type NightAuditStepView = z.infer<typeof nightAuditStepViewSchema>;

export const nightAuditRunViewSchema = z.object({
  id: z.uuid(),
  businessDate: businessDateSchema,
  status: nightAuditRunStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  /** The last failure, typed message only. */
  lastError: z.string().nullable(),
  steps: z.array(nightAuditStepViewSchema),
});

export type NightAuditRunView = z.infer<typeof nightAuditRunViewSchema>;

export const nightAuditOverviewSchema = z.object({
  /** The property's open accounting day: what the next run would close. */
  businessDate: businessDateSchema,
  timezone: z.string(),
  runs: z.array(nightAuditRunViewSchema),
});

export type NightAuditOverview = z.infer<typeof nightAuditOverviewSchema>;

/**
 * Enqueue a run for the property's current business date. Idempotent: the
 * same day's run is returned if it exists, re-enqueued if it FAILED (it
 * resumes from its first unfinished step), and left alone if it COMPLETED.
 */
export const startNightAuditSchema = z.object({}).strict();
export type StartNightAuditCommand = z.infer<typeof startNightAuditSchema>;

export const startNightAuditResultSchema = z.object({
  run: nightAuditRunViewSchema,
  /** CREATED, RESUMED (a FAILED run re-enqueued), or EXISTING (nothing enqueued). */
  outcome: z.enum(['CREATED', 'RESUMED', 'EXISTING']),
});

export type StartNightAuditResult = z.infer<typeof startNightAuditResultSchema>;
