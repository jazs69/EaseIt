/**
 * Everything the reservation drawer shows.
 *
 * ===========================================================================
 * One fetch, because the drawer is one view.
 *
 * The drawer used to render purely from `TimelineBlock`, the grid's own
 * placement payload. That was enough for a summary and is nowhere near enough
 * for a detail panel: the block carries no guest list, no company, no folio
 * lines, no notes, and no booked-on date, because a room x date grid has no
 * use for any of them.
 *
 * Widening `TimelineBlock` to cover it would be the wrong fix. The grid
 * returns one block per stay in the window — a hundred of them on a busy week
 * — and attaching every guest row and folio line to all of them to serve the
 * one a clerk might click is a hundredfold overfetch (CLAUDE.md section 5:
 * always select the fields you need).
 *
 * MONEY APPEARS TWICE, DELIBERATELY
 * `stay` is what the booking agreed: the quoted total, its tax, what has been
 * taken against it. `folio` is what has actually been posted to the ledger.
 * Before check-in there is no folio at all; after it, the folio holds only the
 * nights posted so far, so the two legitimately differ and a single "balance"
 * would have to silently pick one. They are shown as what they are.
 * ===========================================================================
 */

import { z } from 'zod';

import {
  bookingSourceSchema,
  businessDateSchema,
  mealPlanSchema,
  propertyIdSchema,
  reservationStatusSchema,
  roomIdSchema,
} from '../domain.js';
import { folioViewSchema } from './check-in.dto.js';
import { govtIdTypeSchema } from './create-reservation.dto.js';
import { reservationSubStatusSchema } from './property-dashboard.dto.js';

/* -------------------------------------------------------------------------- */
/*  Guests                                                                     */
/* -------------------------------------------------------------------------- */

export const reservationGuestDetailSchema = z.object({
  id: z.uuid(),
  /** 1 is the booker. The UI badges that one as primary. */
  ordinal: z.number().int().positive(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  govtIdType: govtIdTypeSchema.nullable(),
  /**
   * Masked, never the raw number (CLAUDE.md section 5).
   *
   * The drawer only needs to say whether an ID is on file and which kind; the
   * number itself has no reason to cross the wire to a browser.
   */
  govtIdMasked: z.string().nullable(),
  city: z.string().nullable(),
  countryCode: z.string().nullable(),
});

export type ReservationGuestDetail = z.infer<typeof reservationGuestDetailSchema>;

/* -------------------------------------------------------------------------- */
/*  Notes                                                                      */
/* -------------------------------------------------------------------------- */

export const reservationNoteSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  /** The byline as it was when the note was written. */
  authorName: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type ReservationNoteView = z.infer<typeof reservationNoteSchema>;

export const addReservationNoteSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

export type AddReservationNoteCommand = z.infer<typeof addReservationNoteSchema>;

/* -------------------------------------------------------------------------- */
/*  Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The agreed figures for the stay, in integer minor units (section 3.4).
 *
 * `netMinor` and `taxMinor` sum to `totalMinor` exactly — the net is derived by
 * subtracting the stored tax from the stored total rather than recomputing it
 * from a rate, so the three rows on screen always add up. A breakdown whose
 * rows do not reconcile is worse than no breakdown: somebody will reconcile an
 * invoice against it.
 */
export const stayMoneySchema = z.object({
  currency: z.string().length(3),
  /** Room charges before tax. */
  netMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
  paidMinor: z.number().int(),
  /** Derived, never stored (section 3.4). */
  balanceMinor: z.number().int(),
  /** Inclusive-tax properties quote a gross rate; exclusive ones add it on. */
  taxIsInclusive: z.boolean(),
});

export type StayMoney = z.infer<typeof stayMoneySchema>;

/* -------------------------------------------------------------------------- */
/*  Response                                                                   */
/* -------------------------------------------------------------------------- */

export const reservationDetailSchema = z.object({
  id: z.uuid(),
  propertyId: propertyIdSchema,
  bookingCode: z.string(),
  /** The channel's own reference, for an OTA booking. Null for direct. */
  otaBookingId: z.string().nullable(),

  status: reservationStatusSchema,
  subStatus: reservationSubStatusSchema.nullable(),

  source: bookingSourceSchema,
  isWalkIn: z.boolean(),
  /** When the booking was taken, as an instant. */
  bookedAt: z.iso.datetime({ offset: true }),

  /**
   * Whether a guest-facing magic link is live.
   *
   * A boolean, not a PIN: no reservation PIN or access token exists in this
   * system, so there is none to show or copy.
   */
  isMagicLinkActive: z.boolean(),

  stay: z.object({
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
    nights: z.number().int().positive(),
    checkInTime: z.string(),
    checkOutTime: z.string(),
    adults: z.number().int().nonnegative(),
    children: z.number().int().nonnegative(),
    infants: z.number().int().nonnegative(),
  }),

  room: z.object({
    roomTypeName: z.string(),
    roomId: roomIdSchema.nullable(),
    roomNumber: z.string().nullable(),
    housekeepingStatus: z.string().nullable(),
    /**
     * The board basis (EP, CP, MAP, AP).
     *
     * Labelled "board", not "rate plan": the `rates` module and its RatePlan
     * aggregate are not built (CLAUDE.md section 2), so calling this a rate
     * plan would name a thing that does not exist yet.
     */
    mealPlan: mealPlanSchema,
  }),

  guests: z.array(reservationGuestDetailSchema),

  company: z
    .object({
      id: z.uuid(),
      legalName: z.string(),
      gstin: z.string().nullable(),
    })
    .nullable(),

  money: z.object({
    stay: stayMoneySchema,
    /** The posted ledger. Null until a folio is opened at check-in. */
    folio: folioViewSchema.nullable(),
  }),

  /** The free-text note captured when the booking was taken. */
  bookingNote: z.string().nullable(),
  /** The authored internal log, newest first. */
  notes: z.array(reservationNoteSchema),

  /** What this reservation's state actually permits, decided server-side. */
  canCheckIn: z.boolean(),
  canCheckOut: z.boolean(),
});

export type ReservationDetail = z.infer<typeof reservationDetailSchema>;
