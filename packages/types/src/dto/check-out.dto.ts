/**
 * Checking a guest out.
 *
 * ===========================================================================
 * The request carries almost nothing, and that is the point.
 *
 * Checkout decides nothing the client could usefully supply. The reservation
 * identifies the stay, the balance is summed from `folio_line` server-side,
 * and the room to release is whatever `reservation_room` says it is. A client
 * that could pass a balance, a room or a folio status could also pass a wrong
 * one, so none of those cross the wire (CLAUDE.md section 5: server-owned
 * fields are server-owned).
 *
 * What is left is `reason`, for the same reason cancellation takes one: the
 * `audit_log` row has a `reason` column and every other reservation write
 * fills it, so an early departure or a disputed bill can be explained by the
 * clerk who did it rather than reconstructed later.
 * ===========================================================================
 */

import { z } from 'zod';

export const checkOutSchema = z.object({
  /**
   * Optional, and nullable rather than required.
   *
   * An ordinary checkout at the end of a stay needs no explanation, and a
   * forced reason field produces "checkout" a thousand times, which is worse
   * than nothing because it looks like data.
   */
  reason: z.string().trim().max(200).nullable().default(null),
});

export type CheckOutCommand = z.infer<typeof checkOutSchema>;

export const checkOutResultSchema = z.object({
  reservationId: z.uuid(),
  confirmationCode: z.string(),
  status: z.literal('CHECKED_OUT'),

  /**
   * Null when the stored value is null, never `now()`.
   *
   * A stay checked out by some other means can genuinely have no timestamp,
   * and substituting the current instant would report a departure that never
   * happened in a field the master report reads.
   */
  checkedOutAt: z.string().nullable(),

  /** The folio as it stands after checkout. Closed on a fresh checkout. */
  folioId: z.string().nullable(),
  folioStatus: z.enum(['OPEN', 'CLOSED', 'TRANSFERRED']).nullable(),

  /**
   * The balance that was verified to be zero, in minor units.
   *
   * Reported so the caller can show what was settled rather than taking it on
   * trust, and so an idempotent replay can be compared against the original.
   */
  balanceMinor: z.number().int(),
  currency: z.string(),

  /** The physical room handed back, and the status it was left in. */
  roomId: z.string().nullable(),
  roomNumber: z.string().nullable(),
  roomStatus: z.string().nullable(),

  /**
   * True when this request found the stay already checked out and changed
   * nothing.
   *
   * The same shape cancellation uses for its idempotent replay: a 200 with
   * `alreadyCheckedOut: true` means somebody else got there first, and no
   * second folio closure, room release or audit row was written.
   */
  alreadyCheckedOut: z.boolean(),

  /**
   * Always true. Checkout moves no money: it verifies the balance is zero and
   * closes the folio, and it never posts a payment, refund or adjustment to
   * force that. Stated in the response so a caller does not have to infer it.
   */
  financialsUnchanged: z.literal(true),
});

export type CheckOutResult = z.infer<typeof checkOutResultSchema>;
