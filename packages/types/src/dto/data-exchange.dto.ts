/**
 * IE-01 bulk import and IE-02 export: the wire contract.
 *
 * ===========================================================================
 * IMPORT fills an EXISTING property (properties themselves come from
 * onboarding; the portfolio is fixed) from up to three CSV documents, in one
 * request so a room can name a category created by the same import and a rate
 * can name both:
 *
 *   roomTypes  code,name,maxGuests,maxAdults,baseRate,sortOrder,description
 *   rooms      number,roomTypeCode,floor,notes
 *   rates      ratePlanCode,roomTypeCode,fromDate,toDate,amount
 *
 * Amounts are MAJOR units as written by a person ("3500" or "3500.00"),
 * converted exactly by `fromMajorUnitString`; never parsed as a float.
 * A rate row with both dates empty sets the plan's DEFAULT for that category
 * (creating the assignment); with dates it prices every night from `fromDate`
 * to `toDate` INCLUSIVE.
 *
 * `DRY_RUN` runs the whole import inside a transaction and rolls it back, so
 * the preview has been through every database constraint and cannot drift
 * from what a commit would do. `COMMIT` must quote the `digest` of a clean dry
 * run of the same documents: the operator commits exactly what they reviewed.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

/** 1 MiB per document; the API's body limit is 2 MiB for the whole request. */
export const MAX_IMPORT_DOCUMENT_CHARS = 1_000_000;
/** Rows per document. A 200-room hotel's rooms file is 201 lines. */
export const MAX_IMPORT_ROWS = 2_000;
/** Nights one dated rate row may cover. */
export const MAX_IMPORT_RATE_SPAN_DAYS = 400;

const documentSchema = z
  .string()
  .max(MAX_IMPORT_DOCUMENT_CHARS, 'A document may be at most 1,000,000 characters.')
  .optional();

export const importModeSchema = z.enum(['DRY_RUN', 'COMMIT']);
export type ImportMode = z.infer<typeof importModeSchema>;

export const importRequestSchema = z
  .object({
    mode: importModeSchema,
    roomTypes: documentSchema,
    rooms: documentSchema,
    rates: documentSchema,
    /** Required for COMMIT: the digest a clean dry run returned. */
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'That is not a dry-run digest.')
      .optional(),
  })
  .refine((v) => [v.roomTypes, v.rooms, v.rates].some((d) => d !== undefined && d.trim() !== ''), {
    message: 'Supply at least one document to import.',
    path: ['roomTypes'],
  })
  .refine((v) => v.mode !== 'COMMIT' || v.digest !== undefined, {
    message: 'A commit must quote the digest of the dry run it follows.',
    path: ['digest'],
  });

export type ImportRequest = z.infer<typeof importRequestSchema>;

export const importDocumentSchema = z.enum(['roomTypes', 'rooms', 'rates']);
export type ImportDocument = z.infer<typeof importDocumentSchema>;

/** What happened (or would happen) to one row. */
export const importRowOutcomeSchema = z.enum(['CREATE', 'UPDATE', 'UNCHANGED', 'ERROR']);
export type ImportRowOutcome = z.infer<typeof importRowOutcomeSchema>;

export const importRowResultSchema = z.object({
  document: importDocumentSchema,
  /** 1-based line in the document, counting the header as line 1. */
  line: z.number().int().positive(),
  /** The row's natural key as written: a code, a room number, plan/type/dates. */
  key: z.string(),
  outcome: importRowOutcomeSchema,
  /** Errors for ERROR rows; informational notes otherwise. */
  messages: z.array(z.string()),
});

export type ImportRowResult = z.infer<typeof importRowResultSchema>;

const countsSchema = z.object({
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
});

export const importResultSchema = z.object({
  mode: importModeSchema,
  /** True only for a COMMIT that wrote. A DRY_RUN never writes. */
  committed: z.boolean(),
  /** SHA-256 of the documents; quote it to commit. Present on every result. */
  digest: z.string(),
  /** False when any row is ERROR: such an import cannot be committed. */
  valid: z.boolean(),
  counts: z.object({ roomTypes: countsSchema, rooms: countsSchema, rates: countsSchema }),
  /** Every non-UNCHANGED row, plus every row with a message. */
  rows: z.array(importRowResultSchema),
  /** Property-level notes, e.g. that new categories have no inventory nights yet. */
  notes: z.array(z.string()),
});

export type ImportResult = z.infer<typeof importResultSchema>;

/* -------------------------------------------------------------------------- */
/*  Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Configuration datasets come out in exactly the import's columns, so an
 * export is also a template and a backup that can be imported back. The
 * operational datasets are windowed by date.
 */
export const exportDatasetSchema = z.enum([
  'room-types',
  'rooms',
  'rates',
  'reservations',
  'folio-lines',
  'guests',
]);
export type ExportDataset = z.infer<typeof exportDatasetSchema>;

/** Datasets that carry guest personal data; their export is audited as such. */
export const PERSONAL_DATA_DATASETS: readonly ExportDataset[] = ['reservations', 'guests'];

/** Days one operational export may span (as reports). */
export const MAX_EXPORT_WINDOW_DAYS = 370;

export const exportQuerySchema = z.object({
  /** Required for `rates`, `reservations` and `folio-lines`. */
  fromDate: businessDateSchema.optional(),
  toDate: businessDateSchema.optional(),
});

export type ExportQuery = z.infer<typeof exportQuerySchema>;
