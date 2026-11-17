/**
 * Direct billing: the city ledger (GP-07).
 *
 * ===========================================================================
 * How a stay is billed to a company.
 *
 * A stay attached to a company can have its folio balance moved onto that
 * company's account. On the guest folio this is a PAYMENT line with method
 * `CITY_LEDGER`, so the folio settles to zero, checks out, closes and is
 * invoiced to the company as usual. In the same transaction, a TRANSFER entry
 * on `company_ledger_entry` records what the company now owes. The company
 * later pays against its account with PAYMENT entries.
 *
 * A company's balance is the sum of its entries, and is never stored
 * (CLAUDE.md section 3.4). Aging allocates payments to the oldest open
 * transfer first, and ages what remains from the stay's invoice date, or from
 * the transfer date when no invoice has been issued yet.
 *
 * No credit limits: that is a policy decision not yet made.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema, type BusinessDate } from '../domain.js';
import { paymentMethodSchema } from './create-reservation.dto.js';

const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_-]{16,64}$/,
    'Must be 16-64 characters of letters, digits, hyphen or underscore.',
  );

/* -------------------------------------------------------------------------- */
/*  Commands                                                                  */
/* -------------------------------------------------------------------------- */

/** Move (part of) a folio's balance onto its company's account. */
export const billToCompanySchema = z.object({
  amountMinor: z.number().int().positive(),
  remark: z.string().trim().max(200).nullable().default(null),
  idempotencyKey: idempotencyKeySchema,
});

export type BillToCompanyCommand = z.infer<typeof billToCompanySchema>;

/** A company's payment against its account. Never more than it owes. */
export const recordCompanyPaymentSchema = z.object({
  method: paymentMethodSchema,
  amountMinor: z.number().int().positive(),
  /** The cheque number, UTR or transaction id, for reconciling with the bank. */
  reference: z.string().trim().max(100).nullable().default(null),
  remark: z.string().trim().max(200).nullable().default(null),
  idempotencyKey: idempotencyKeySchema,
});

export type RecordCompanyPaymentCommand = z.infer<typeof recordCompanyPaymentSchema>;

/* -------------------------------------------------------------------------- */
/*  Aging                                                                     */
/* -------------------------------------------------------------------------- */

export const agingBucketsSchema = z.object({
  /** 0-30 days old. */
  currentMinor: z.number().int(),
  days31To60Minor: z.number().int(),
  days61To90Minor: z.number().int(),
  over90Minor: z.number().int(),
});

export type AgingBuckets = z.infer<typeof agingBucketsSchema>;

export interface AgingTransfer {
  id: string;
  amountMinor: number;
  /** The date the debt ages from: the invoice date, else the transfer date. */
  ageDate: BusinessDate;
  /** Tie-breaker for transfers aging from the same date. */
  postingDate: BusinessDate;
}

export interface OpenItem {
  id: string;
  ageDate: BusinessDate;
  ageDays: number;
  outstandingMinor: number;
}

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Applies `paidMinor` (the sum of the company's payments, positive) to the
 * oldest transfers first, and ages what remains as of `asOf`.
 *
 * Integers only. The open items always sum to `max(0, transfers - paid)`,
 * which equals the balance, because a payment is never accepted beyond what
 * is owed.
 */
export function ageReceivables(
  transfers: readonly AgingTransfer[],
  paidMinor: number,
  asOf: BusinessDate,
): { openItems: OpenItem[]; aging: AgingBuckets } {
  const ordered = [...transfers].sort(
    (a, b) =>
      a.ageDate.localeCompare(b.ageDate) ||
      a.postingDate.localeCompare(b.postingDate) ||
      a.id.localeCompare(b.id),
  );
  let unapplied = Math.max(0, paidMinor);
  const openItems: OpenItem[] = [];
  const aging: AgingBuckets = {
    currentMinor: 0,
    days31To60Minor: 0,
    days61To90Minor: 0,
    over90Minor: 0,
  };
  for (const transfer of ordered) {
    const applied = Math.min(unapplied, transfer.amountMinor);
    unapplied -= applied;
    const outstandingMinor = transfer.amountMinor - applied;
    if (outstandingMinor <= 0) continue;
    const ageDays = Math.max(0, daysBetween(transfer.ageDate, asOf));
    openItems.push({ id: transfer.id, ageDate: transfer.ageDate, ageDays, outstandingMinor });
    if (ageDays <= 30) aging.currentMinor += outstandingMinor;
    else if (ageDays <= 60) aging.days31To60Minor += outstandingMinor;
    else if (ageDays <= 90) aging.days61To90Minor += outstandingMinor;
    else aging.over90Minor += outstandingMinor;
  }
  return { openItems, aging };
}

/* -------------------------------------------------------------------------- */
/*  Responses                                                                 */
/* -------------------------------------------------------------------------- */

export const companyAccountSummarySchema = z.object({
  companyId: z.uuid(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  gstin: z.string(),
  balanceMinor: z.number().int(),
  aging: agingBucketsSchema,
  /** The oldest date an open item ages from. Null when nothing is owed. */
  oldestOpenDate: businessDateSchema.nullable(),
  lastPaymentDate: businessDateSchema.nullable(),
});

export type CompanyAccountSummary = z.infer<typeof companyAccountSummarySchema>;

export const directBillingOverviewSchema = z.object({
  /** The property's business date: what "days old" is measured against. */
  asOf: businessDateSchema,
  currency: z.string().length(3),
  /** Every company with ledger activity, largest balance first. */
  accounts: z.array(companyAccountSummarySchema),
  totals: z.object({ balanceMinor: z.number().int(), aging: agingBucketsSchema }),
});

export type DirectBillingOverview = z.infer<typeof directBillingOverviewSchema>;

export const companyLedgerEntrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['TRANSFER', 'PAYMENT']),
  postingDate: businessDateSchema,
  /** Signed: a transfer adds to what is owed, a payment reduces it. */
  amountMinor: z.number().int(),
  runningBalanceMinor: z.number().int(),
  reservationId: z.uuid().nullable(),
  bookingCode: z.string().nullable(),
  guestName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: businessDateSchema.nullable(),
  method: paymentMethodSchema.nullable(),
  reference: z.string().nullable(),
  remark: z.string().nullable(),
});

export type CompanyLedgerEntry = z.infer<typeof companyLedgerEntrySchema>;

export const companyStatementSchema = z.object({
  asOf: businessDateSchema,
  currency: z.string().length(3),
  company: z.object({
    id: z.uuid(),
    legalName: z.string(),
    tradeName: z.string().nullable(),
    gstin: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  balanceMinor: z.number().int(),
  aging: agingBucketsSchema,
  /** Oldest first. */
  entries: z.array(companyLedgerEntrySchema),
  openItems: z.array(
    z.object({
      entryId: z.uuid(),
      bookingCode: z.string().nullable(),
      invoiceNumber: z.string().nullable(),
      ageDate: businessDateSchema,
      ageDays: z.number().int().nonnegative(),
      outstandingMinor: z.number().int().positive(),
    }),
  ),
});

export type CompanyStatement = z.infer<typeof companyStatementSchema>;
