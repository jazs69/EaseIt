/**
 * The folio and billing page.
 *
 * ===========================================================================
 * One ledger, read four ways.
 *
 * `FolioLine` is a single append-only table with a `kind` discriminator and a
 * signed `amountMinor` — charges positive, payments negative. Everything this
 * page shows is that one list projected differently: the transaction table is
 * the lines, the charges breakdown is the lines grouped by kind, the balance is
 * their sum, and the payments tab is the subset with a method.
 *
 * Nothing here is stored twice. CLAUDE.md section 3.4 forbids caching a folio
 * balance in a mutable column, and every total below is derived on read, so
 * there is no second number able to drift from the ledger it came from.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema, propertyIdSchema, reservationStatusSchema } from '../domain.js';
import { folioLineSchema } from './check-in.dto.js';
import { paymentMethodSchema } from './create-reservation.dto.js';

/* -------------------------------------------------------------------------- */
/*  A transaction row                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `DEBIT` increases what the guest owes, `CREDIT` reduces it.
 *
 * Derived from the sign rather than stored: the sign is already constrained by
 * `folio_line_sign_matches_kind`, so a second stored field could only disagree
 * with it.
 */
export const folioEntryDirectionSchema = z.enum(['DEBIT', 'CREDIT']);
export type FolioEntryDirection = z.infer<typeof folioEntryDirectionSchema>;

export const folioTransactionSchema = z.object({
  id: z.uuid(),
  /** The business date the line was posted against, never `now()`. */
  date: businessDateSchema,
  /** The room it was posted to, where the stay has one. */
  room: z.string().nullable(),
  description: z.string(),
  kind: folioLineSchema.shape.kind,
  direction: folioEntryDirectionSchema,

  /**
   * Net, tax and gross for this row, in integer minor units.
   *
   * A charge carries its own net and the tax derived from it; a tax line is
   * folded into its parent charge rather than listed separately, because a
   * table that shows "Room tariff ₹2,700" and "GST ₹135" as two rows and then
   * totals a GROSS column double-counts the tax to anyone scanning it.
   *
   * `netMinor + taxMinor === grossMinor` always holds.
   */
  netMinor: z.number().int(),
  taxMinor: z.number().int(),
  grossMinor: z.number().int(),

  /** Set on a payment or refund row. */
  paymentMethod: paymentMethodSchema.nullable(),
  /** Set on a correction, pointing at the line it reverses. */
  reversesLineId: z.uuid().nullable(),
  postedAt: z.iso.datetime({ offset: true }),
});

export type FolioTransaction = z.infer<typeof folioTransactionSchema>;

/* -------------------------------------------------------------------------- */
/*  Breakdown                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The bottom summary panel, every figure summed from the lines.
 *
 * **On CGST/SGST.** A folio line stores one tax amount, not a component split.
 * For an intra-state supply Indian GST is levied half as CGST and half as
 * SGST, so the halves below are derived from that one figure — which is
 * arithmetic, not an invention. An inter-state supply is IGST and is *not*
 * split; this platform has no place-of-supply field yet, so `taxIsSplit` says
 * whether the split is being shown and the UI can present a single GST figure
 * when it is not. Guessing the component split and printing it on an invoice
 * is the kind of thing that gets filed.
 */
export const folioBreakdownSchema = z.object({
  currency: z.string().length(3),

  /** Charges before tax. */
  subtotalMinor: z.number().int(),
  /** All tax posted against this folio. */
  taxMinor: z.number().int(),
  /** Half of `taxMinor` each, when the split applies. */
  cgstMinor: z.number().int(),
  sgstMinor: z.number().int(),
  taxIsSplit: z.boolean(),

  paymentsReceivedMinor: z.number().int(),
  refundsIssuedMinor: z.number().int(),
  /**
   * Always zero today, and reported rather than hidden.
   *
   * There is no deposit concept in the schema — a security deposit is a held
   * instrument, not a payment, and modelling it needs its own table. Showing
   * the row as zero is true; omitting it would imply the platform tracks
   * deposits somewhere else.
   */
  depositsHeldMinor: z.number().int(),

  /** Derived: charges + tax − payments. */
  balanceDueMinor: z.number().int(),
});

export type FolioBreakdown = z.infer<typeof folioBreakdownSchema>;

/* -------------------------------------------------------------------------- */
/*  Response                                                                   */
/* -------------------------------------------------------------------------- */

export const folioPageSchema = z.object({
  /** Null until a folio is opened, which happens at check-in. */
  folioId: z.uuid().nullable(),
  folioStatus: z.enum(['OPEN', 'CLOSED', 'TRANSFERRED']).nullable(),
  propertyId: propertyIdSchema,

  reservation: z.object({
    id: z.uuid(),
    bookingCode: z.string(),
    guestName: z.string(),
    status: reservationStatusSchema,
    source: z.string(),
    isWalkIn: z.boolean(),
    bookedAt: z.iso.datetime({ offset: true }),

    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
    checkInTime: z.string(),
    checkOutTime: z.string(),
    nights: z.number().int().positive(),
    roomCount: z.number().int().nonnegative(),
    adults: z.number().int().nonnegative(),
    children: z.number().int().nonnegative(),
    infants: z.number().int().nonnegative(),

    /** The board basis. Not a rate plan — that module is not built. */
    mealPlan: z.string(),
    roomTypeName: z.string(),
    roomNumber: z.string().nullable(),

    canCheckIn: z.boolean(),
    canCheckOut: z.boolean(),
  }),

  /** Headline figures, from the same lines as everything else. */
  totals: z.object({
    currency: z.string().length(3),
    grossTotalMinor: z.number().int(),
    paidMinor: z.number().int(),
    balanceDueMinor: z.number().int(),
  }),

  transactions: z.array(folioTransactionSchema),
  breakdown: folioBreakdownSchema,
});

export type FolioPage = z.infer<typeof folioPageSchema>;

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                  */
/* -------------------------------------------------------------------------- */

export const postFolioChargeSchema = z.object({
  description: z.string().trim().min(1).max(200),
  /** Charge before tax, in minor units. Server-side it is never a float. */
  netAmountMinor: z.number().int().positive(),
  /**
   * Tax on this charge, supplied explicitly.
   *
   * Not computed from a rate here: an outlet charge may be zero-rated, or
   * taxed at a different slab from the room tariff, and silently applying the
   * property's room-tax percentage to a laundry bill would be wrong in a way
   * nobody notices until an audit (CLAUDE.md section 3.4).
   */
  taxAmountMinor: z.number().int().nonnegative().default(0),
  /** Defaults to the property's business date. */
  chargeDate: businessDateSchema.nullable().default(null),
});

export type PostFolioChargeCommand = z.infer<typeof postFolioChargeSchema>;

export const postFolioPaymentSchema = z.object({
  method: paymentMethodSchema,
  amountMinor: z.number().int().positive(),
  remark: z.string().trim().max(200).nullable().default(null),
});

export type PostFolioPaymentCommand = z.infer<typeof postFolioPaymentSchema>;

export const postFolioDiscountSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  amountMinor: z.number().int().positive(),
});

export type PostFolioDiscountCommand = z.infer<typeof postFolioDiscountSchema>;
