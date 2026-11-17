/**
 * Invoices (FO-14).
 *
 * ===========================================================================
 * An invoice is a frozen copy of a closed folio, numbered.
 *
 * It is raised only once the folio is CLOSED (settled at zero, refusing every
 * posting), so the lines it prints can no longer change underneath it. The
 * document below is stored as issued: a later edit to the hotel's address or
 * a company's name does not rewrite an invoice a guest already holds.
 *
 * Money is integer minor units throughout (section 3.4). CGST and SGST are
 * the folio breakdown's split of the total tax — the same figures the folio
 * page shows — because hotel accommodation is supplied where the hotel is,
 * which makes it intra-state supply.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';
import { storedPaymentMethodSchema } from './create-reservation.dto.js';

export const invoicePartySchema = z.object({
  name: z.string(),
  /** The registered name, where it differs from `name`. */
  legalName: z.string().nullable(),
  gstin: z.string().length(15).nullable(),
  addressLines: z.array(z.string()),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

export type InvoiceParty = z.infer<typeof invoicePartySchema>;

/** One charge, discount or adjustment, with the tax derived from it folded in. */
export const invoiceLineSchema = z.object({
  date: businessDateSchema,
  description: z.string(),
  kind: z.enum(['ROOM_CHARGE', 'SERVICE_CHARGE', 'TAX', 'ADJUSTMENT']),
  netMinor: z.number().int(),
  taxMinor: z.number().int(),
  grossMinor: z.number().int(),
  /** The rate the line was posted at, from its own net and tax. */
  taxRatePercent: z.number(),
});

export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/** Money received or returned. Both positive; `kind` says which way. */
export const invoicePaymentSchema = z.object({
  date: businessDateSchema,
  kind: z.enum(['PAYMENT', 'REFUND']),
  method: storedPaymentMethodSchema.nullable(),
  amountMinor: z.number().int().nonnegative(),
});

export type InvoicePayment = z.infer<typeof invoicePaymentSchema>;

export const invoiceSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  /** Indian financial year, `2026-27`. */
  fiscalYear: z.string(),
  /** "Tax Invoice" only when the hotel's GSTIN is configured. */
  title: z.enum(['Tax Invoice', 'Invoice']),
  invoiceDate: businessDateSchema,
  issuedAt: z.iso.datetime({ offset: true }),
  currency: z.string().length(3),

  seller: invoicePartySchema,
  billTo: invoicePartySchema.extend({ kind: z.enum(['GUEST', 'COMPANY']) }),

  stay: z.object({
    bookingCode: z.string(),
    guestName: z.string(),
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
    nights: z.number().int().positive(),
    roomNumber: z.string().nullable(),
    roomTypeName: z.string(),
  }),

  lines: z.array(invoiceLineSchema),
  payments: z.array(invoicePaymentSchema),

  totals: z.object({
    subtotalMinor: z.number().int(),
    taxMinor: z.number().int(),
    cgstMinor: z.number().int(),
    sgstMinor: z.number().int(),
    totalMinor: z.number().int(),
    /** Money received, excluding anything billed to the company account. */
    paidMinor: z.number().int(),
    refundedMinor: z.number().int(),
    /**
     * Owed by the bill-to after this invoice: the amount billed to the
     * company's account (GP-07), and zero for a stay paid in full. The folio
     * itself is always settled at zero before an invoice is raised.
     */
    balanceMinor: z.number().int(),
  }),
});

export type Invoice = z.infer<typeof invoiceSchema>;

/** What the folio page carries about its invoice. */
export const invoiceRefSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  invoiceDate: businessDateSchema,
  issuedAt: z.iso.datetime({ offset: true }),
});

export type InvoiceRef = z.infer<typeof invoiceRefSchema>;
