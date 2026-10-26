/**
 * The side effects of a check-in, in one place.
 *
 * ===========================================================================
 * Two pathways, one implementation.
 *
 * A guest can be checked in as the booking is created ("check in now" on the
 * create modal) or later from the desk. Both have to end in the same state:
 * the room occupied, a folio open, the arrival night and its tax posted, any
 * advance recorded, and an audit row written.
 *
 * Writing that twice is how the two drift until one forgets to open a folio
 * and a front desk has an in-house guest it cannot charge. So both call this,
 * inside their own transaction — it takes a `tx` and never opens one, because
 * the create path is already mid-transaction when it gets here and a nested
 * transaction would commit the folio independently of the booking it belongs
 * to.
 * ===========================================================================
 */

import type { PaymentMethod, Prisma } from '@repo/database';
import type { FolioView } from '@repo/types';

/** Room states that mean somebody is in there. */
export const OCCUPIED_ROOM_STATES = ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'] as const;
/** Room states that are ready to receive a guest. */
export const CLEAN_ROOM_STATES = ['VACANT_CLEAN', 'INSPECTED'] as const;

export function isCleanRoomState(status: string): boolean {
  return (CLEAN_ROOM_STATES as readonly string[]).includes(status);
}

export function isOccupiedRoomState(status: string): boolean {
  return (OCCUPIED_ROOM_STATES as readonly string[]).includes(status);
}

export function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function toBusinessDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface CheckInPostingInput {
  propertyId: string;
  reservationId: string;
  staffUserId: string;
  /**
   * The property's business date — never `now()` (section 3.3).
   *
   * Which accounting day the money lands in. Used for the payment.
   */
  businessDate: string;
  /**
   * The night the room charge is for.
   *
   * ===========================================================================
   * **A room charge is dated to its night, not to the business date.**
   *
   * These coincide when the night audit runs nightly, which is why one field
   * looked like enough. They do not coincide when it has not run: a guest
   * arriving on the 18th against a business date still on the 16th had their
   * arrival night posted to the 16th — a night they were not in the room.
   *
   * That is not only mislabelled, it defeats the guard built to prevent it.
   * `folio_line_one_room_charge_per_date` is unique on (folio, chargeDate) for
   * room charges precisely so check-in and the night audit cannot both charge
   * one night. Keyed on the business date instead, check-in posts the 16th and
   * the audit later posts the 18th, and the guest is charged twice for one
   * night with the index none the wiser.
   *
   * The folio page showed the symptom first: four tariff rows on a three-night
   * stay, because the projection could not match a posted charge dated outside
   * the stay to any night inside it.
   * ===========================================================================
   */
  roomChargeDate: string;
  currency: string;
  /** The arrival night's tariff, exclusive of tax, in minor units. */
  roomChargeMinor: number;
  /** The arrival night's tax, posted as its own line (section 3.4). */
  taxMinor: number;
  payment: { method: string; amountMinor: number; remark: string | null } | null;
  room: { id: string; number: string; status: string } | null;
  previousStatus: string;
  previousRoomId: string | null;
  keyCardsIssued: number;
  roomNotCleanAcknowledged: boolean;
}

/**
 * Occupy the room, open the folio, post night one, write the audit row.
 *
 * Returns the folio as the API publishes it, with the balance summed from the
 * lines rather than stored anywhere.
 */
export async function postCheckIn(
  tx: Prisma.TransactionClient,
  input: CheckInPostingInput,
): Promise<FolioView> {
  const paymentDate = toUtcMidnight(input.businessDate);
  const chargeDate = toUtcMidnight(input.roomChargeDate);

  // Occupancy transitions the existing `RoomStatus` enum rather than a
  // parallel `occupancyStatus` column. One stored field means there is one
  // answer to "is anyone in room 103"; two means they can disagree, and the
  // housekeeping board and the calendar would each believe a different one.
  if (input.room !== null) {
    await tx.room.update({
      where: { id: input.room.id },
      data: {
        status: isCleanRoomState(input.room.status) ? 'OCCUPIED_CLEAN' : 'OCCUPIED_DIRTY',
      },
    });
  }

  const folio = await tx.folio.upsert({
    where: { reservationId: input.reservationId },
    create: {
      propertyId: input.propertyId,
      reservationId: input.reservationId,
      currency: input.currency,
      status: 'OPEN',
    },
    update: { status: 'OPEN' },
    select: { id: true, status: true, currency: true },
  });

  /**
   * Night one, posted exactly once.
   *
   * Section 3.3 step 3 gives the night audit the job of posting room charges
   * per business date, and this posts the arrival night — run both and night
   * one is charged twice. `folio_line_one_room_charge_per_date` refuses the
   * second insert outright, and this read lets the legitimate case (the audit
   * got there first) proceed instead of raising. The tax line is only posted
   * alongside a charge that was actually inserted, so a skipped charge cannot
   * leave an orphan tax line behind it.
   */
  const existingRoomCharge = await tx.folioLine.findFirst({
    where: {
      folioId: folio.id,
      kind: 'ROOM_CHARGE',
      chargeDate,
      reversesLineId: null,
    },
    select: { id: true },
  });

  if (existingRoomCharge === null && input.roomChargeMinor > 0) {
    const charge = await tx.folioLine.create({
      data: {
        propertyId: input.propertyId,
        folioId: folio.id,
        kind: 'ROOM_CHARGE',
        description:
          input.room === null
            ? `Room tariff — ${input.roomChargeDate}`
            : `Room ${input.room.number} tariff — ${input.roomChargeDate}`,
        amountMinor: input.roomChargeMinor,
        currency: input.currency,
        chargeDate,
        postedById: input.staffUserId,
      },
      select: { id: true },
    });

    if (input.taxMinor > 0) {
      // Its own line, referencing the charge it derives from — never folded
      // into the base amount (section 3.4), because an invoice has to show it.
      await tx.folioLine.create({
        data: {
          propertyId: input.propertyId,
          folioId: folio.id,
          kind: 'TAX',
          description: `GST on room tariff — ${input.roomChargeDate}`,
          amountMinor: input.taxMinor,
          currency: input.currency,
          chargeDate,
          derivedFromLineId: charge.id,
          postedById: input.staffUserId,
        },
      });
    }
  }

  if (input.payment !== null) {
    await tx.folioLine.create({
      data: {
        propertyId: input.propertyId,
        folioId: folio.id,
        kind: 'PAYMENT',
        description: `Payment at check-in (${input.payment.method})`,
        // Negative, so the balance stays one plain sum with no branching on
        // kind — and a branching sum is where a payment eventually gets added
        // instead of subtracted. The CHECK constraint refuses the other sign.
        amountMinor: -input.payment.amountMinor,
        currency: input.currency,
        // The open accounting day, not the night: money received at 00:30
        // belongs to the day the books are on (section 3.3).
        chargeDate: paymentDate,
        paymentMethod: input.payment.method as PaymentMethod,
        remark: input.payment.remark,
        postedById: input.staffUserId,
      },
    });
  }

  // In the same transaction as the change it records (section 3.4). Written
  // afterwards it would be a log that disagrees with the database the first
  // time a transaction rolled back. No guest PII on either side (section 5).
  await tx.auditLog.create({
    data: {
      propertyId: input.propertyId,
      actorUserId: input.staffUserId,
      event: 'RESERVATION_CHECKED_IN',
      entityType: 'reservation',
      entityId: input.reservationId,
      before: { status: input.previousStatus, roomId: input.previousRoomId },
      after: {
        status: 'CHECKED_IN',
        roomId: input.room?.id ?? null,
        keyCardsIssued: input.keyCardsIssued,
        roomNotCleanAcknowledged: input.roomNotCleanAcknowledged,
      },
      reason: input.roomNotCleanAcknowledged
        ? 'Front desk acknowledged the room was not clean.'
        : null,
    },
  });

  const lines = await tx.folioLine.findMany({
    where: { folioId: folio.id },
    select: {
      id: true,
      kind: true,
      description: true,
      amountMinor: true,
      chargeDate: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  return toFolioView(folio, lines);
}

/** Charges, payments and balance, all summed from the lines. */
export function toFolioView(
  folio: { id: string; status: string; currency: string },
  lines: {
    id: string;
    kind: string;
    description: string;
    amountMinor: number;
    chargeDate: Date;
  }[],
): FolioView {
  const chargesMinor = lines
    .filter((line) => line.amountMinor > 0)
    .reduce((sum, line) => sum + line.amountMinor, 0);
  const paymentsMinor = lines
    .filter((line) => line.amountMinor < 0)
    .reduce((sum, line) => sum + line.amountMinor, 0);

  return {
    id: folio.id,
    status: folio.status as FolioView['status'],
    currency: folio.currency,
    lines: lines.map((line) => ({
      id: line.id,
      kind: line.kind as FolioView['lines'][number]['kind'],
      description: line.description,
      amountMinor: line.amountMinor,
      chargeDate: toBusinessDateString(
        line.chargeDate,
      ) as FolioView['lines'][number]['chargeDate'],
    })),
    chargesMinor,
    paymentsMinor,
    // One plain sum. The sign already carries the meaning (section 3.4).
    balanceMinor: chargesMinor + paymentsMinor,
  };
}
