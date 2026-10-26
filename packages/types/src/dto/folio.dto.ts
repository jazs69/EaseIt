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
  /**
   * A row key, not necessarily a `folio_line` id.
   *
   * Posted rows carry their line's uuid. Scheduled rows are derived, so they
   * carry a synthetic key prefixed `scheduled-` — deliberately not a uuid, so
   * one can never be mistaken for a line id and sent to an endpoint that
   * expects one. A `z.uuid()` here rejected the whole response the first time
   * a scheduled row appeared, which is the client-side contract check doing
   * exactly its job.
   */
  id: z.string().min(1),
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

  /**
   * Whether this row is in the ledger, or only scheduled.
   *
   * A night is charged when it is consumed — by check-in for the arrival
   * night, by night audit step 3 for each night after (CLAUDE.md section 3.3).
   * So a stay that arrives next week has an agreed tariff and no posted
   * charges, and a stay mid-way through has some of each.
   *
   * Unposted rows are derived from the reservation and are **not** written to
   * `folio_line`. They are what the guest has agreed to pay, shown so the
   * table is never an empty void and the totals are never a misleading zero —
   * but marked, because a scheduled charge is a forecast and a posted one is
   * a fact, and an invoice may only be raised from the second.
   */
  isPosted: z.boolean(),

  /** Set on a payment or refund row. */
  paymentMethod: paymentMethodSchema.nullable(),
  /** Set on a correction, pointing at the line it reverses. */
  reversesLineId: z.uuid().nullable(),
  /**
   * Whether this row's gross may be corrected inline.
   *
   * True for a posted charge. False for a payment — money received is not
   * adjusted by editing a number, it is refunded — and false for a scheduled
   * row, which is a forecast with no ledger line behind it to correct.
   */
  isCorrectable: z.boolean(),
  /** Gross actually posted, before any correction folded into this row. */
  originalGrossMinor: z.number().int(),
  /** How many corrections have been folded in. */
  correctionCount: z.number().int().nonnegative(),
  /**
   * What this row is, for grouping.
   *
   * The Summary tab rolls every `ROOM_TARIFF` row into one "Booking Price";
   * the Itemized tab leaves them alone. Carried from the server rather than
   * inferred from the description, which a clerk can edit.
   */
  group: z.enum(['ROOM_TARIFF', 'SERVICE', 'MONEY', 'OTHER']),
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

  /** Charges before tax, scheduled and posted together. */
  subtotalMinor: z.number().int(),
  /** The posted subset, which is what an invoice may be raised from. */
  postedSubtotalMinor: z.number().int(),
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
    /**
     * True when any part of the stay is still only scheduled.
     *
     * The UI says so rather than presenting a forecast as a settled bill.
     */
    hasUnpostedCharges: z.boolean(),
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

/**
 * Correcting a posted charge.
 *
 * ===========================================================================
 * The new gross, not a patch of the old row.
 *
 * `folio_line` is append-only (CLAUDE.md section 3.4): a mistake is corrected
 * by posting a line that references the original, never by updating it. So the
 * server works out the difference between what was charged and what should
 * have been, and posts that — the original stays exactly as it was recorded.
 *
 * This matters to the one person the folio exists for. A guest disputing a
 * ₹3,000 charge needs to see that it was posted at ₹2,733 and corrected by a
 * named clerk at a known time; a row that simply reads ₹3,000 cannot answer
 * the question.
 * ===========================================================================
 */
export const correctFolioChargeSchema = z
  .object({
    /**
     * The corrected gross, tax included, in integer minor units.
     *
     * For a credit row this is the corrected amount of money received; the
     * sign is supplied by the server from the line's own kind, so a clerk
     * types 5000 rather than -5000.
     */
    grossAmountMinor: z.number().int().nonnegative().optional(),
    /**
     * The corrected net, tax exclusive.
     *
     * The other direction: a clerk who knows the pre-tax price. Tax and gross
     * are computed forward from it. Only meaningful on a taxable debit — a
     * credit has no tax, so net and gross are the same number and supplying
     * either is the same instruction.
     */
    netAmountMinor: z.number().int().nonnegative().optional(),
    reason: z.string().trim().max(200).nullable().default(null),
  })
  .refine(
    (value) =>
      (value.grossAmountMinor === undefined) !== (value.netAmountMinor === undefined),
    {
      // Both would be a contradiction the moment they disagree about tax, and
      // the server would have to silently pick one. Neither is a no-op dressed
      // up as a request.
      message: 'Supply exactly one of grossAmountMinor or netAmountMinor.',
    },
  );

export type CorrectFolioChargeCommand = z.infer<typeof correctFolioChargeSchema>;

/**
 * Correcting the whole stay's room charges at once.
 *
 * ===========================================================================
 * The consolidated "Booking Price" row, edited.
 *
 * The Summary tab rolls every nightly tariff into one row, so editing that row
 * means correcting several ledger lines together. Doing it as N separate calls
 * would not be atomic: a failure halfway leaves the stay corrected for three
 * nights and not the other four, and the guest's bill is then wrong in a way
 * nobody can see from either tab.
 *
 * The difference is distributed across the nights in proportion to what each
 * was charged, with the rounding remainder on the first night so the parts sum
 * to exactly the requested total (CLAUDE.md section 3.4).
 *
 * **Only when every night in the rollup is posted.** A stay whose later nights
 * are still scheduled has no ledger lines for them — those figures come from
 * the reservation's agreed total, and changing that is a re-quote, not a folio
 * correction. The server refuses rather than silently correcting the posted
 * part and reporting a total the clerk did not ask for.
 * ===========================================================================
 */
export const correctRoomChargesSchema = z
  .object({
    /** The corrected gross for the whole stay, tax included. */
    grossAmountMinor: z.number().int().nonnegative().optional(),
    /** The corrected net for the whole stay, tax exclusive. */
    netAmountMinor: z.number().int().nonnegative().optional(),
    reason: z.string().trim().max(200).nullable().default(null),
  })
  .refine(
    (value) =>
      (value.grossAmountMinor === undefined) !== (value.netAmountMinor === undefined),
    { message: 'Supply exactly one of grossAmountMinor or netAmountMinor.' },
  );

export type CorrectRoomChargesCommand = z.infer<typeof correctRoomChargesSchema>;

export const postFolioDiscountSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  amountMinor: z.number().int().positive(),
});

export type PostFolioDiscountCommand = z.infer<typeof postFolioDiscountSchema>;
