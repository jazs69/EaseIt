/**
 * Property reports.
 *
 * ===========================================================================
 * The catalogue carries each report's **availability**, and that is the most
 * important thing in this file.
 *
 * Nine reports are specified. Five can be computed from tables that exist.
 * Four cannot: they need folios, posted charges, tax lines, cashier shifts or
 * rate plans, none of which are built. The difference is not cosmetic — a
 * guest-ledger report rendered today would show every tax as ₹0.00, and a
 * general manager would file that zero as a fact about the business rather
 * than a fact about the schema.
 *
 * So `availability` travels with each report and the UI reads it. A blocked
 * report says which module it waits on instead of rendering a grid of zeros,
 * and the endpoint refuses it rather than returning an empty success.
 *
 * Every money figure is integer minor units with its currency, and every date
 * is a calendar date rather than an instant (CLAUDE.md sections 3.3 and 3.4).
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema, propertyIdSchema } from '../domain.js';

/* -------------------------------------------------------------------------- */
/*  Catalogue                                                                 */
/* -------------------------------------------------------------------------- */

export const reportTypeSchema = z.enum([
  'master',
  'flash-manager',
  'guest-ledger',
  'room-revenue',
  'sales',
  'room-inventory',
  'shift',
  'bar-pricing',
  'folio',
]);

export type ReportType = z.infer<typeof reportTypeSchema>;

/**
 * `available` means every figure in it comes from a real column.
 *
 * `blockedBy` is prose for the operator, naming the module they are waiting
 * on. It is not an error message — nothing went wrong, the feature is simply
 * downstream of work that has not happened.
 */
export const reportAvailabilitySchema = z.object({
  available: z.boolean(),
  blockedBy: z.string().nullable(),
});

export const reportDefinitionSchema = z.object({
  type: reportTypeSchema,
  title: z.string(),
  description: z.string(),
  /** Drives the "Most used" pill. */
  isMostUsed: z.boolean(),
  availability: reportAvailabilitySchema,
});

export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

/**
 * The catalogue, in display order.
 *
 * Shared rather than duplicated per app: the directory page, the viewer and
 * the API all need to agree on which reports exist and which are blocked, and
 * three copies of that list would drift the first time one changed.
 */
export const REPORT_CATALOGUE: readonly ReportDefinition[] = [
  {
    type: 'master',
    title: 'Master report',
    description:
      'Get all the details of bookings, customer information, payments, and taxes in a single report.',
    isMostUsed: true,
    availability: {
      available: true,
      // Honest about the gap inside an otherwise-real report.
      blockedBy: null,
    },
  },
  {
    type: 'flash-manager',
    title: 'Flash manager report',
    description:
      'Summary of today, month-to-date, and year-to-date occupancy, ADR, RevPAR, Taxes, and other essential metrics.',
    isMostUsed: false,
    availability: { available: true, blockedBy: null },
  },
  {
    type: 'guest-ledger',
    title: 'Guest ledger report',
    description:
      'Shows the change in outstanding balance owed by in-house guests after considering revenue, taxes, payments, transfers, and direct billing.',
    isMostUsed: false,
    availability: {
      available: false,
      blockedBy:
        'Needs the folios module. A guest ledger is the movement of a folio balance broken into revenue, tax, payment and transfer — there is no Folio table, so every line of it would be zero.',
    },
  },
  {
    type: 'room-revenue',
    title: 'Room revenue report',
    description:
      'A detailed view of the room revenue, services revenue, taxes, payments, and refunds grouped by booking id. A helpful report for daily auditing.',
    isMostUsed: false,
    availability: {
      available: false,
      blockedBy:
        'Needs the folios module for service revenue, tax lines and refunds. Room revenue alone is already in the Sales report; the other four columns have no source.',
    },
  },
  {
    type: 'sales',
    title: 'Sales report',
    description:
      'Date-wise performance report of the hotel. Occupancy, ADR, RevPAR, Revenue, payments, and other vital metrics.',
    isMostUsed: false,
    availability: { available: true, blockedBy: null },
  },
  {
    type: 'room-inventory',
    title: 'Room inventory report',
    description:
      'Date-wise room inventory metrics like Total rooms, available rooms, blocked rooms, and sold rooms.',
    isMostUsed: false,
    availability: { available: true, blockedBy: null },
  },
  {
    type: 'shift',
    title: 'Shift report',
    description:
      'Transactions handled by each front-desk user, grouped by shift with shift, user and grand totals.',
    isMostUsed: false,
    availability: {
      available: false,
      blockedBy:
        'Needs cashier shifts and per-transaction attribution. Nothing records which user took a payment or when a shift opened and closed, so there is no way to group by either.',
    },
  },
  {
    type: 'bar-pricing',
    title: 'BAR pricing report',
    description:
      'The BAR Pricing Report provides a detailed view of rates for default occupancy as set at the room level.',
    isMostUsed: false,
    availability: { available: true, blockedBy: null },
  },
  {
    type: 'folio',
    title: 'Folio report',
    description:
      'A quick snapshot of guest folio balances and payments made. Useful for end-of-the-day balancing.',
    isMostUsed: false,
    availability: {
      available: false,
      blockedBy:
        'Needs the folios module. A folio balance is the sum of its immutable lines; the provisional paid/total pair on a reservation is not a folio and must not be presented as one.',
    },
  },
];

export const REPORT_BY_TYPE: Record<ReportType, ReportDefinition> = Object.fromEntries(
  REPORT_CATALOGUE.map((report) => [report.type, report]),
) as Record<ReportType, ReportDefinition>;

/* -------------------------------------------------------------------------- */
/*  Query                                                                     */
/* -------------------------------------------------------------------------- */

export const reportFormatSchema = z.enum(['json', 'csv']);
export type ReportFormat = z.infer<typeof reportFormatSchema>;

export const reportQuerySchema = z.object({
  /** Omitted means the property's own business date, never the server's day. */
  startDate: businessDateSchema.optional(),
  endDate: businessDateSchema.optional(),
  format: reportFormatSchema.default('json'),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Result                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One column of a report.
 *
 * `align` and `kind` travel with the data so the viewer does not have to guess
 * from the values: a column of room counts and a column of paise both arrive
 * as numbers, and only the server knows which is money.
 */
export const reportColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'number', 'money', 'percent', 'date']),
});

export type ReportColumn = z.infer<typeof reportColumnSchema>;

/**
 * A generic row: column key to primitive.
 *
 * Deliberately not a per-report discriminated union. Nine report shapes would
 * mean nine schemas, nine mappers and nine table components for what is, at
 * the UI, one sortable grid — and the column metadata above already carries
 * the typing the renderer needs. The *server* still builds each report from a
 * typed query; this is the wire shape only.
 */
export const reportRowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.null()]),
);

export type ReportRow = z.infer<typeof reportRowSchema>;

export const reportResponseSchema = z.object({
  type: reportTypeSchema,
  title: z.string(),
  propertyId: propertyIdSchema,
  propertyName: z.string(),
  propertyCode: z.string(),
  currency: z.string().length(3),
  /** The window actually used, after defaulting. */
  startDate: businessDateSchema,
  endDate: businessDateSchema,
  generatedFor: businessDateSchema,

  columns: z.array(reportColumnSchema),
  rows: z.array(reportRowSchema),
  /** Column totals, where a total is meaningful. Keyed like a row. */
  totals: reportRowSchema.nullable(),
  rowCount: z.number().int().nonnegative(),

  /**
   * Caveats a reader needs before acting on the numbers.
   *
   * For example: revenue is spread evenly across a stay's nights until the
   * rates module can say what each night actually sold for. Printed under the
   * table rather than buried in a tooltip — a figure with a known
   * approximation in it should carry that approximation wherever it goes.
   */
  notes: z.array(z.string()),
});

export type ReportResponse = z.infer<typeof reportResponseSchema>;
