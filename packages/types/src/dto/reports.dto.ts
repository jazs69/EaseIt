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

/* -------------------------------------------------------------------------- */
/*  Master report                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Which date column the window filters against.
 *
 * ===========================================================================
 * A master report is asked four different questions by four different people,
 * and they are not the same query.
 *
 * Finance reconciling a day's takings wants stays that *checked out* in it.
 * The front desk wants arrivals. Sales measuring campaign performance wants
 * bookings *made* in it, which is a different column entirely — `createdAt`,
 * an instant, not a calendar date. Occupancy wants every stay that *touched*
 * the window, which is an overlap test rather than a containment one.
 *
 * Defaulting to `CHECKOUT` because that is the settled-revenue view, and a
 * report whose default silently meant something else is how two people quote
 * different numbers from the same screen.
 * ===========================================================================
 */
export const masterReportDimensionSchema = z.enum(['CHECKOUT', 'CHECKIN', 'BOOKED', 'STAY']);

export type MasterReportDimension = z.infer<typeof masterReportDimensionSchema>;

export const MASTER_REPORT_DIMENSION_LABELS: Record<MasterReportDimension, string> = {
  CHECKOUT: 'Checkout date',
  CHECKIN: 'Checkin date',
  STAY: 'Stay through',
  BOOKED: 'Booking made date',
};

/** Menu order: the two containment tests, then overlap, then the booking date. */
export const MASTER_REPORT_DIMENSION_ORDER: readonly MasterReportDimension[] = [
  'CHECKOUT',
  'CHECKIN',
  'STAY',
  'BOOKED',
];

/**
 * Per-column filters.
 *
 * Applied in the database, not in the browser. A property with three years of
 * history has more rows than a page holds, so a client-side filter would
 * narrow only the page the reader happens to be on and quietly report a total
 * for the wrong set — the single most misleading thing a report can do.
 */
export const masterReportFiltersSchema = z.object({
  bookingId: z.string().max(80).optional(),
  guest: z.string().max(80).optional(),
  source: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  roomType: z.string().max(80).optional(),
  room: z.string().max(40).optional(),
});

export const masterReportQuerySchema = masterReportFiltersSchema.extend({
  /** Omitted means the property's own business date, never the server's day. */
  startDate: businessDateSchema.optional(),
  endDate: businessDateSchema.optional(),
  dateDimension: masterReportDimensionSchema.default('CHECKOUT'),
  page: z.coerce.number().int().positive().default(1),
  /**
   * Capped at 200.
   *
   * The table is horizontally scrollable with up to forty columns; a thousand
   * rows of it is not something anyone reads, and the cap keeps one careless
   * request from pulling a property's whole history into a browser. Export
   * exists for the whole set.
   */
  limit: z.coerce.number().int().min(1).max(200).default(10),
  format: reportFormatSchema.default('json'),
  /**
   * Which columns to return, comma-separated.
   *
   * The server narrows the response and the CSV to these, so an export matches
   * what the operator is looking at rather than carrying forty columns they
   * deliberately hid. Unknown or unavailable keys are dropped rather than
   * refused — a preference saved by an older browser should degrade, not 400.
   */
  columns: z
    .string()
    .max(2000)
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(',')
            .map((key) => key.trim())
            .filter((key) => key !== ''),
    ),
});

export type MasterReportQuery = z.infer<typeof masterReportQuerySchema>;

/**
 * One row.
 *
 * Every optional column is nullable rather than absent, so the viewer renders
 * a dash for "this booking has none" without having to distinguish it from
 * "this column was not requested" — which the `columns` list already answers.
 */
export const masterReportRowSchema = z.object({
  /** The reservation's uuid, for navigating to its folio. */
  reservationId: z.string(),
  bookingId: z.string(),

  /* Booking */
  bookedOn: businessDateSchema,
  bookedAtTime: z.string().nullable(),
  source: z.string(),
  status: z.string(),
  otaBookingId: z.string().nullable(),
  companyGstin: z.string().nullable(),
  cancelDate: businessDateSchema.nullable(),
  bookingReference: z.string().nullable(),
  segment: z.string().nullable(),
  scantyBaggage: z.string().nullable(),
  complimentary: z.string().nullable(),
  complimentaryRemarks: z.string().nullable(),
  otaPrepaidMinor: z.number().int(),

  /* Stay */
  rooms: z.string().nullable(),
  roomTypes: z.string().nullable(),
  ratePlans: z.string(),
  roomCount: z.number().int().nonnegative(),
  roomNights: z.number().int().nonnegative(),
  arrival: businessDateSchema,
  departure: businessDateSchema,
  scheduledCheckInTime: z.string().nullable(),
  scheduledCheckOutTime: z.string().nullable(),
  actualCheckIn: z.string().nullable(),
  actualCheckOut: z.string().nullable(),
  leadTimeDays: z.number().int(),

  /* Guest */
  guest: z.string(),
  adults: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),
  infants: z.number().int().nonnegative(),
  customerIdentification: z.string().nullable(),
  customerEmail: z.string().nullable(),
  customerPhone: z.string().nullable(),
  customerAddressLine1: z.string().nullable(),
  customerAddressLine2: z.string().nullable(),
  customerCity: z.string().nullable(),
  customerState: z.string().nullable(),
  customerCountry: z.string().nullable(),
  customerZipcode: z.string().nullable(),
  specialRequests: z.string().nullable(),

  /* Financial */
  totalMinor: z.number().int(),
  balanceMinor: z.number().int(),
  bookingAmountMinor: z.number().int(),
  roomRevenueMinor: z.number().int(),
  roomTaxMinor: z.number().int(),
  taxPercent: z.number(),
  serviceGrossMinor: z.number().int(),
  serviceTaxMinor: z.number().int(),
  serviceNetMinor: z.number().int(),
  otaCommissionMinor: z.number().int(),
  otaTaxMinor: z.number().int(),
  otaNetMinor: z.number().int(),
  promoMinor: z.number().int(),
  customFolioId: z.string().nullable(),

  /* Payment */
  paidMinor: z.number().int(),
  onlinePaymentMinor: z.number().int(),
  offlinePaymentMinor: z.number().int(),
  refundMinor: z.number().int(),
  depositMinor: z.number().int(),
  externalSourcePayment: z.number().int(),
  externalCardPayment: z.number().int(),
  cardLast4: z.string().nullable(),
  paymentIssuer: z.string().nullable(),
  transactionType: z.string().nullable(),
  couponCode: z.string().nullable(),
});

export type MasterReportRow = z.infer<typeof masterReportRowSchema>;

/**
 * Totals across the **whole filtered set**, not the page on screen.
 *
 * Keyed by column, because the visible columns are chosen at request time and
 * a fixed shape would mean adding a field here every time a summable column
 * joins the catalogue. `bookingCount` sits outside the map: it is what the
 * figures *cover*, not one of them.
 *
 * This is the only honest way to pin a total row under a paginated table. A
 * sum of the ten visible rows labelled "Total" is a number nobody asked for:
 * the reader sees "Total 5,600" under a report of four hundred bookings and
 * has no way to tell it is page one.
 */
export const masterReportTotalsSchema = z.object({
  bookingCount: z.number().int().nonnegative(),
  byColumn: z.record(z.string(), z.number()),
});

export type MasterReportTotals = z.infer<typeof masterReportTotalsSchema>;

export const masterReportResponseSchema = z.object({
  propertyId: propertyIdSchema,
  propertyName: z.string(),
  propertyCode: z.string(),
  currency: z.string().length(3),
  startDate: businessDateSchema,
  endDate: businessDateSchema,
  generatedFor: businessDateSchema,
  dateDimension: masterReportDimensionSchema,

  /** Exactly the columns requested, resolved and ordered by the catalogue. */
  columns: z.array(reportColumnSchema),
  rows: z.array(masterReportRowSchema),
  totals: masterReportTotalsSchema,
  pagination: z.object({
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    pageCount: z.number().int().nonnegative(),
  }),
  notes: z.array(z.string()),
});

export type MasterReportResponse = z.infer<typeof masterReportResponseSchema>;
