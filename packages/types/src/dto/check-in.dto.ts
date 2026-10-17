/**
 * Front-desk check-in.
 *
 * ===========================================================================
 * Two pathways, one engine.
 *
 * A guest can be checked in at the moment the booking is created (the "check
 * in now" box on the create modal) or later, at the desk, from a CONFIRMED
 * reservation. Both end in the same state: status CHECKED_IN, the room
 * occupied, a folio open with the first night posted, and an audit row.
 *
 * They are deliberately not two implementations. A second code path for the
 * same state transition is how the two drift until one of them forgets to open
 * a folio — so the create path calls the same service as the desk path.
 * ===========================================================================
 */

import { z } from 'zod';

import {
  businessDateSchema,
  propertyIdSchema,
  reservationStatusSchema,
  roomIdSchema,
} from '../domain.js';
import { govtIdTypeSchema, paymentMethodSchema } from './create-reservation.dto.js';

/* -------------------------------------------------------------------------- */
/*  Request                                                                    */
/* -------------------------------------------------------------------------- */

export const checkInRequestSchema = z.object({
  /**
   * Reassign the room at check-in.
   *
   * Common: a booking held a room type, and the clerk picks the actual room as
   * the guest arrives. Omitted keeps whatever the reservation already holds.
   */
  roomId: roomIdSchema.nullable().default(null),

  /**
   * Identity captured at the desk, where it was not recorded at booking.
   *
   * Indian hotels are legally required to record a government photo ID for
   * every guest. The service refuses a check-in without one — see
   * `CheckInBlocker` below, which tells the UI *which* requirement is missing
   * rather than failing with a generic validation error.
   */
  primaryGuestIdType: govtIdTypeSchema.nullable().default(null),
  primaryGuestIdNumber: z.string().trim().max(40).nullable().default(null),

  keyCardsIssued: z.number().int().min(0).max(10).default(2),

  /** Advance or deposit taken as the guest arrives. */
  initialPayment: z
    .object({
      method: paymentMethodSchema,
      amountMinor: z.number().int().positive(),
      remark: z.string().trim().max(200).nullable().default(null),
    })
    .nullable()
    .default(null),

  registrationCardSigned: z.boolean().default(false),

  /**
   * Proceed even though the room is not clean.
   *
   * Not a silent override: the acknowledgement is recorded on the audit row,
   * so "who let a guest into a dirty room" has an answer. Without it a dirty
   * room blocks the check-in.
   */
  acknowledgeRoomNotClean: z.boolean().default(false),
});

export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Pre-flight                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why a check-in cannot proceed yet.
 *
 * Returned as data rather than thrown, because every one of these is fixable at
 * the desk in the next thirty seconds. CLAUDE.md section 5: expected-and-
 * recoverable is a result, not an exception — `canCheckIn()` returns a reason,
 * it does not throw.
 */
export const checkInBlockerSchema = z.enum([
  'ALREADY_CHECKED_IN',
  'ALREADY_CHECKED_OUT',
  'CANCELLED',
  'NO_SHOW',
  'NOT_CONFIRMED',
  'ARRIVAL_IN_FUTURE',
  'NO_ROOM_ASSIGNED',
  'ROOM_OCCUPIED',
  'ROOM_OUT_OF_ORDER',
  'ROOM_NOT_CLEAN',
  'MISSING_GOVT_ID',
]);

export type CheckInBlocker = z.infer<typeof checkInBlockerSchema>;

export const CHECK_IN_BLOCKER_MESSAGES: Record<CheckInBlocker, string> = {
  ALREADY_CHECKED_IN: 'This guest is already checked in.',
  ALREADY_CHECKED_OUT: 'This stay has already been checked out.',
  CANCELLED: 'This reservation was cancelled.',
  NO_SHOW: 'This reservation was marked a no-show.',
  NOT_CONFIRMED: 'Only a confirmed reservation can be checked in.',
  ARRIVAL_IN_FUTURE: 'Arrival is in the future. Check in on the arrival date.',
  NO_ROOM_ASSIGNED: 'Assign a room before checking the guest in.',
  ROOM_OCCUPIED: 'That room is still occupied.',
  ROOM_OUT_OF_ORDER: 'That room is out of order and cannot be occupied.',
  ROOM_NOT_CLEAN: 'That room has not been cleaned. Acknowledge to continue.',
  MISSING_GOVT_ID: 'A government photo ID is required before check-in.',
};

/** Blockers the clerk can override with an explicit acknowledgement. */
export const OVERRIDABLE_BLOCKERS: readonly CheckInBlocker[] = ['ROOM_NOT_CLEAN'];

/**
 * Everything the check-in modal needs, without committing to anything.
 *
 * Fetched when the modal opens so it can show the balance, the rooms that are
 * actually free, and what is missing — rather than discovering all three on a
 * failed submit.
 */
export const checkInPreflightSchema = z.object({
  reservationId: z.uuid(),
  bookingCode: z.string(),
  guestName: z.string(),
  guestPhone: z.string().nullable(),
  status: reservationStatusSchema,

  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().positive(),
  businessDate: businessDateSchema,

  roomTypeId: z.uuid(),
  roomTypeName: z.string(),
  assignedRoomId: roomIdSchema.nullable(),
  assignedRoomNumber: z.string().nullable(),

  /** Clean, vacant rooms of the same category, for reassignment. */
  availableRooms: z.array(
    z.object({
      id: roomIdSchema,
      number: z.string(),
      housekeepingStatus: z.string(),
      isClean: z.boolean(),
    }),
  ),

  govtIdType: govtIdTypeSchema.nullable(),
  /** Masked. The raw number is never returned (section 5). */
  govtIdMasked: z.string().nullable(),
  hasGovtId: z.boolean(),

  totalAmountMinor: z.number().int(),
  paidAmountMinor: z.number().int(),
  balanceAmountMinor: z.number().int(),
  currency: z.string().length(3),

  /** Empty means the check-in will succeed as things stand. */
  blockers: z.array(checkInBlockerSchema),
});

export type CheckInPreflight = z.infer<typeof checkInPreflightSchema>;

/* -------------------------------------------------------------------------- */
/*  Result                                                                     */
/* -------------------------------------------------------------------------- */

export const folioLineSchema = z.object({
  id: z.uuid(),
  kind: z.enum([
    'ROOM_CHARGE',
    'TAX',
    'SERVICE_CHARGE',
    'PAYMENT',
    'REFUND',
    'ADJUSTMENT',
  ]),
  description: z.string(),
  /** Signed minor units: charges positive, payments negative. */
  amountMinor: z.number().int(),
  chargeDate: businessDateSchema,
});

export type FolioLineView = z.infer<typeof folioLineSchema>;

export const folioViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(['OPEN', 'CLOSED', 'TRANSFERRED']),
  currency: z.string().length(3),
  lines: z.array(folioLineSchema),
  /**
   * Derived by summing `lines`, never stored (section 3.4).
   *
   * Returned so the UI does not have to re-add them, but it is a projection of
   * the array beside it — not a separate fact.
   */
  chargesMinor: z.number().int(),
  paymentsMinor: z.number().int(),
  balanceMinor: z.number().int(),
});

export type FolioView = z.infer<typeof folioViewSchema>;

export const checkInResultSchema = z.object({
  reservationId: z.uuid(),
  propertyId: propertyIdSchema,
  bookingCode: z.string(),
  guestName: z.string(),
  status: reservationStatusSchema,
  roomNumber: z.string().nullable(),
  checkedInAt: z.iso.datetime({ offset: true }),
  keyCardsIssued: z.number().int(),
  folio: folioViewSchema,
  /** Recorded on the audit row when the room was not clean. */
  roomNotCleanAcknowledged: z.boolean(),
});

export type CheckInResult = z.infer<typeof checkInResultSchema>;
