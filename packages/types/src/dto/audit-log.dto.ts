/**
 * The audit log viewer (AD-03).
 *
 * Read-only. Every row is written by the service that made the change, in the
 * same transaction as the change (AD-02); this contract only reads them back,
 * scoped to one property and filtered by who, what and when.
 *
 * Dates filter on the **property's** calendar: `from` and `to` are local
 * dates turned into instants with the property's own timezone on the server,
 * never with the browser's or the server's zone.
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

/** Free-text identifiers stored by the writers: `RESERVATION_CANCELLED`, `folio`. */
const auditKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'Letters, digits, and _ . : - only');

export const listAuditLogQuerySchema = z
  .object({
    /** One staff member's changes. `system` selects changes with no human actor (night audit). */
    actor: z.union([z.uuid(), z.literal('system')]).optional(),
    entityType: auditKeySchema.optional(),
    entityId: z.uuid().optional(),
    event: auditKeySchema.optional(),
    /** Inclusive, property-local. */
    from: businessDateSchema.optional(),
    /** Inclusive, property-local. */
    to: businessDateSchema.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: '`from` must not be after `to`',
    path: ['to'],
  });

export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;

const actorSchema = z.object({ id: z.uuid(), name: z.string() });

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  event: z.string(),
  entityType: z.string(),
  entityId: z.uuid(),
  /** Null for a system actor such as the night audit. */
  actor: actorSchema.nullable(),
  /** The stored snapshots, as written. Shape varies by event. */
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
});

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogPageSchema = z.object({
  items: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
  /** The property's timezone, so the screen shows times as the hotel does. */
  timeZone: z.string(),
});

export type AuditLogPage = z.infer<typeof auditLogPageSchema>;

/** What the filter controls can offer: only values that occur at this property. */
export const auditLogFacetsSchema = z.object({
  actors: z.array(actorSchema),
  entityTypes: z.array(z.string()),
  events: z.array(z.string()),
});

export type AuditLogFacets = z.infer<typeof auditLogFacetsSchema>;
