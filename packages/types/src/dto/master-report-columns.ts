/**
 * The master report's column catalogue.
 *
 * ===========================================================================
 * All 65 specified columns, and every one of them now has a source.
 *
 * Eighteen of these had nowhere to read from — OTA settlement, promotions,
 * deposits, card instrument detail, cancellation and the front-desk flags —
 * and were carried here disabled, each naming the module it waited on. The
 * `20261019140000_master_report_columns` migration gave them real columns, so
 * the picker now offers all 65 and every one populates from the database like
 * any other figure.
 *
 * The `available` and `blockedBy` fields stay in the shape. They are the
 * mechanism that keeps a column from being offered before it can be filled,
 * and the next specified column with no source should use it rather than
 * rendering a dash on every row — a picker that offers a field and then shows
 * nothing teaches an operator the software is broken, where a greyed-out one
 * naming its reason teaches them what is missing.
 *
 * `defaultVisible` is the preset a fresh browser gets, and what "Reset to
 * default" restores. It stays at sixteen columns: enough to reconcile a day
 * without scrolling sideways through sixty-five.
 * ===========================================================================
 */

import { z } from 'zod';

export const masterReportCategorySchema = z.enum([
  'BOOKING',
  'STAY',
  'GUEST',
  'FINANCIAL',
  'PAYMENT',
]);

export type MasterReportCategory = z.infer<typeof masterReportCategorySchema>;

export const MASTER_REPORT_CATEGORY_LABELS: Record<MasterReportCategory, string> = {
  BOOKING: 'Booking detail',
  STAY: 'Stay & room details',
  GUEST: 'Guest details',
  FINANCIAL: 'Financials',
  PAYMENT: 'Payments',
};

export const MASTER_REPORT_CATEGORY_ORDER: readonly MasterReportCategory[] = [
  'BOOKING',
  'STAY',
  'GUEST',
  'FINANCIAL',
  'PAYMENT',
];

export interface MasterReportColumnDef {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'money' | 'percent' | 'date';
  category: MasterReportCategory;
  /** False when nothing in this schema can fill it. */
  available: boolean;
  /** Why not, for the picker to show. Null when available. */
  blockedBy: string | null;
  /** In the preset a fresh browser sees. */
  defaultVisible: boolean;
  /** Summed in the totals row. Only ever a money or count column. */
  totalled?: boolean;
}

export const MASTER_REPORT_COLUMN_DEFS: readonly MasterReportColumnDef[] = [
  /* -- Booking detail --------------------------------------------------- */
  { key: 'bookedOn', label: 'Booking date', kind: 'date', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: true },
  { key: 'source', label: 'Source', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: true },
  { key: 'status', label: 'Booking status', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: true },
  { key: 'cancelDate', label: 'Cancel date', kind: 'date', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'bookingId', label: 'Booking ID', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: true },
  { key: 'otaBookingId', label: 'OTA booking ID', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'bookedAtTime', label: 'Booking time', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'bookingReference', label: 'Booking reference ID', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'segment', label: 'Segment', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'companyGstin', label: 'Company GST no.', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'scantyBaggage', label: 'Scanty baggage', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'otaPrepaidMinor', label: 'OTA prepaid amount', kind: 'money', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'complimentaryRemarks', label: 'Complimentary remarks', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },
  { key: 'complimentary', label: 'Complimentary', kind: 'text', category: 'BOOKING', available: true, blockedBy: null, defaultVisible: false },

  /* -- Stay & room ------------------------------------------------------ */
  { key: 'arrival', label: 'Check in date', kind: 'date', category: 'STAY', available: true, blockedBy: null, defaultVisible: true },
  { key: 'departure', label: 'Check out date', kind: 'date', category: 'STAY', available: true, blockedBy: null, defaultVisible: true },
  { key: 'roomNights', label: 'Room nights', kind: 'number', category: 'STAY', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'rooms', label: 'Room no.(s)', kind: 'text', category: 'STAY', available: true, blockedBy: null, defaultVisible: true },
  { key: 'roomTypes', label: 'Room types', kind: 'text', category: 'STAY', available: true, blockedBy: null, defaultVisible: true },
  { key: 'ratePlans', label: 'Rate plans', kind: 'text', category: 'STAY', available: true, blockedBy: null, defaultVisible: true },
  { key: 'roomCount', label: 'No. of rooms', kind: 'number', category: 'STAY', available: true, blockedBy: null, defaultVisible: true, totalled: true },
  { key: 'scheduledCheckInTime', label: 'Check in time', kind: 'text', category: 'STAY', available: true, blockedBy: null, defaultVisible: false },
  { key: 'scheduledCheckOutTime', label: 'Check out time', kind: 'text', category: 'STAY', available: true, blockedBy: null, defaultVisible: false },
  { key: 'actualCheckIn', label: 'Actual check in', kind: 'text', category: 'STAY', available: true, blockedBy: null, defaultVisible: false },
  { key: 'actualCheckOut', label: 'Actual check out', kind: 'text', category: 'STAY', available: true, blockedBy: null, defaultVisible: false },
  { key: 'leadTimeDays', label: 'Pre booking window', kind: 'number', category: 'STAY', available: true, blockedBy: null, defaultVisible: true },

  /* -- Guest ------------------------------------------------------------ */
  { key: 'guest', label: 'Guest', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: true },
  { key: 'adults', label: 'Adults', kind: 'number', category: 'GUEST', available: true, blockedBy: null, defaultVisible: true, totalled: true },
  { key: 'children', label: 'Children', kind: 'number', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'infants', label: 'Infants', kind: 'number', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'customerIdentification', label: 'Customer identification', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerEmail', label: 'Customer email', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerPhone', label: 'Customer phone', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerAddressLine1', label: 'Customer address line 1', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerAddressLine2', label: 'Customer address line 2', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerCity', label: 'Customer city', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerState', label: 'Customer state', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerCountry', label: 'Customer country', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'customerZipcode', label: 'Customer zipcode', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },
  { key: 'specialRequests', label: 'Special requests', kind: 'text', category: 'GUEST', available: true, blockedBy: null, defaultVisible: false },

  /* -- Financials ------------------------------------------------------- */
  { key: 'totalMinor', label: 'Total amount', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: true, totalled: true },
  { key: 'balanceMinor', label: 'Balance due', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: true, totalled: true },
  { key: 'bookingAmountMinor', label: 'Booking amount', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'roomRevenueMinor', label: 'Cumulative room revenue', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'roomTaxMinor', label: 'Cumulative room taxes', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'taxPercent', label: 'Tax %', kind: 'percent', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false },
  { key: 'serviceGrossMinor', label: 'Service amount', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'serviceTaxMinor', label: 'Service taxes', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'serviceNetMinor', label: 'Service amount excluding taxes', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'otaCommissionMinor', label: 'OTA commission', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'otaTaxMinor', label: 'OTA tax', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'otaNetMinor', label: 'OTA net amount', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'promoMinor', label: 'Promo amount', kind: 'money', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'customFolioId', label: 'Custom folio ID', kind: 'text', category: 'FINANCIAL', available: true, blockedBy: null, defaultVisible: false },

  /* -- Payments --------------------------------------------------------- */
  { key: 'paidMinor', label: 'Payment made', kind: 'money', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: true, totalled: true },
  { key: 'depositMinor', label: 'Deposit made', kind: 'money', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'onlinePaymentMinor', label: 'Online payment', kind: 'money', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'offlinePaymentMinor', label: 'Offline payment', kind: 'money', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'refundMinor', label: 'Refund', kind: 'money', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'externalSourcePayment', label: 'External source payment', kind: 'money', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'externalCardPayment', label: 'External card payment', kind: 'money', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false, totalled: true },
  { key: 'cardLast4', label: 'Card last4', kind: 'text', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false },
  { key: 'transactionType', label: 'Transaction type', kind: 'text', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false },
  { key: 'paymentIssuer', label: 'Payment issuer', kind: 'text', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false },
  { key: 'couponCode', label: 'Applied coupon code or offer', kind: 'text', category: 'PAYMENT', available: true, blockedBy: null, defaultVisible: false },
];

/** Only the columns that can actually be filled. */
export const MASTER_REPORT_AVAILABLE_COLUMNS: readonly MasterReportColumnDef[] =
  MASTER_REPORT_COLUMN_DEFS.filter((column) => column.available);

export const MASTER_REPORT_DEFAULT_COLUMNS: readonly string[] =
  MASTER_REPORT_COLUMN_DEFS.filter((column) => column.defaultVisible).map(
    (column) => column.key,
  );

/**
 * Alternate names the resolver accepts for the same column.
 *
 * ===========================================================================
 * The specification named these columns with its own identifiers, which differ
 * from the keys already in use — `bookingDate` for `bookedOn`, `guestName` for
 * `guest`, `numberOfRooms` for `roomCount`, and so on.
 *
 * Renaming the keys was the other option and the wrong one: they are already
 * in saved browser preferences, in shared report URLs and in the exported CSV
 * headers, so a rename would silently drop a colleague's saved layout and
 * break every link anyone had sent. Accepting both names costs one lookup and
 * breaks nothing.
 *
 * The *labels* are unchanged either way — those were already the specified
 * human-readable names, which is what a reader of the report sees.
 * ===========================================================================
 */
export const MASTER_REPORT_COLUMN_ALIASES: Record<string, string> = {
  /* Booking detail */
  bookingDate: 'bookedOn',
  bookingStatus: 'status',
  bookingTime: 'bookedAtTime',
  bookingReferenceId: 'bookingReference',
  companyGstNo: 'companyGstin',
  otaPrepaidAmount: 'otaPrepaidMinor',
  isComplimentary: 'complimentary',

  /* Stay & room */
  checkInDate: 'arrival',
  checkOutDate: 'departure',
  roomNumbers: 'rooms',
  numberOfRooms: 'roomCount',
  checkInTime: 'scheduledCheckInTime',
  checkOutTime: 'scheduledCheckOutTime',
  preBookingWindow: 'leadTimeDays',

  /* Guest */
  guestName: 'guest',
  customerId: 'customerIdentification',
  addressLine1: 'customerAddressLine1',
  addressLine2: 'customerAddressLine2',
  city: 'customerCity',
  state: 'customerState',
  country: 'customerCountry',
  zipcode: 'customerZipcode',

  /* Financials */
  totalAmount: 'totalMinor',
  balanceDue: 'balanceMinor',
  bookingAmount: 'bookingAmountMinor',
  cumulativeRoomRevenue: 'roomRevenueMinor',
  cumulativeRoomTaxes: 'roomTaxMinor',
  taxPercentage: 'taxPercent',
  serviceAmount: 'serviceGrossMinor',
  serviceTaxes: 'serviceTaxMinor',
  serviceAmountExclTaxes: 'serviceNetMinor',
  otaCommission: 'otaCommissionMinor',
  otaTax: 'otaTaxMinor',
  otaNetAmount: 'otaNetMinor',
  promoAmount: 'promoMinor',

  /* Payments */
  paymentMade: 'paidMinor',
  depositMade: 'depositMinor',
  onlinePayment: 'onlinePaymentMinor',
  offlinePayment: 'offlinePaymentMinor',
  refundAmount: 'refundMinor',
  appliedCouponCode: 'couponCode',
};

/** Resolves either naming to the canonical key. */
export function canonicalMasterReportKey(key: string): string {
  return MASTER_REPORT_COLUMN_ALIASES[key] ?? key;
}

const BY_KEY = new Map(MASTER_REPORT_COLUMN_DEFS.map((column) => [column.key, column]));

export function masterReportColumn(key: string): MasterReportColumnDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Narrows a requested column list to what can be served, in catalogue order.
 *
 * Unknown and unavailable keys are dropped rather than refused: a saved
 * preference from a browser that remembers a column since withdrawn should
 * degrade to showing the rest, not 400 the whole report. An empty result falls
 * back to the default preset, because a table with no columns is not a table.
 *
 * Order comes from the catalogue, never from the request, so two people with
 * the same columns selected see them in the same sequence.
 */
export function resolveMasterReportColumns(
  requested: readonly string[] | undefined,
): MasterReportColumnDef[] {
  const resolved =
    requested === undefined || requested.length === 0
      ? MASTER_REPORT_COLUMN_DEFS.filter((column) => column.defaultVisible)
      : (() => {
          // Either naming is accepted, so the specification's identifiers work
          // verbatim alongside the keys already in saved layouts and URLs.
          const wanted = new Set(requested.map(canonicalMasterReportKey));
          return MASTER_REPORT_COLUMN_DEFS.filter(
            (column) => column.available && wanted.has(column.key),
          );
        })();

  const columns =
    resolved.length > 0
      ? resolved
      : MASTER_REPORT_COLUMN_DEFS.filter((column) => column.defaultVisible);

  return leadWithBookingId(columns);
}

/**
 * Moves the booking ID to the front, wherever the catalogue lists it.
 *
 * ===========================================================================
 * Three things downstream assume the first column identifies the row.
 *
 * The table makes the first data column sticky so a reader scrolling forty
 * columns sideways can still tell which booking they are on; the CSV writes
 * the "Total (n bookings)" label into the first cell; and the first column is
 * the one rendered as a link to the folio. All three are wrong if the leading
 * column happens to be "Booking date".
 *
 * The catalogue itself keeps the specified order — Booking date, Source,
 * Booking status, Cancel date, Booking ID — because that is the order the
 * *picker* groups by, and an operator looking for a field should find it where
 * the specification put it. Only the resolved table order is adjusted.
 * ===========================================================================
 */
function leadWithBookingId(columns: readonly MasterReportColumnDef[]): MasterReportColumnDef[] {
  const identifier = columns.find((column) => column.key === 'bookingId');
  if (identifier === undefined) {
    // Unreachable through the picker, which locks it on. A caller hitting the
    // endpoint directly can omit it, and then the first column it did ask for
    // leads — the table still renders, it simply has no row handle.
    return [...columns];
  }
  return [identifier, ...columns.filter((column) => column.key !== 'bookingId')];
}
