/**
 * Folio reads and postings.
 *
 * ===========================================================================
 * Every figure on the billing page is summed from `folio_line`.
 *
 * There is no stored balance, no stored subtotal and no stored tax total.
 * CLAUDE.md section 3.4 forbids caching a derived balance in a mutable column,
 * and the absence is the feature: there is nothing here that can disagree with
 * the ledger it was computed from.
 *
 * Postings are append-only. A correction is a reversing line carrying
 * `reversesLineId`, never an update — a bill a guest is disputing is worth
 * less than nothing if the history behind it can be edited.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  currentDateInTimeZone,
  Permission,
  permissionsForRoles,
  ReservationStatus,
  type FolioBreakdown,
  type FolioPage,
  type FolioTransaction,
  type PostFolioChargeCommand,
  type PostFolioDiscountCommand,
  type PostFolioPaymentCommand,
  type PropertyId,
  type Role,
} from '@repo/types';

import {
  FolioAlreadyClosedError,
  ForbiddenError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';

const DAY_MS = 86_400_000;

/** Kinds that increase what the guest owes. */
const CHARGE_KINDS = ['ROOM_CHARGE', 'SERVICE_CHARGE', 'TAX'] as const;

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

interface LineRow {
  id: string;
  kind: string;
  description: string;
  amountMinor: number;
  chargeDate: Date;
  createdAt: Date;
  paymentMethod: string | null;
  derivedFromLineId: string | null;
  reversesLineId: string | null;
}

@Injectable()
export class FoliosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /* -------------------------------------------------------------------- */
  /*  Read                                                                 */
  /* -------------------------------------------------------------------- */

  /**
   * The billing page, addressed by the booking code a clerk can read aloud.
   *
   * By code rather than by folio id, because the drawer links here before a
   * folio necessarily exists: a confirmed stay has a booking code and no
   * folio, and the page still has to render its stay details and a zero
   * ledger rather than 404.
   *
   * The code is unique *per property*, so the lookup is scoped by the
   * caller's own grant — the same code at another hotel is a different
   * booking and must not be reachable (section 3.2).
   */
  async byBookingCode(
    userId: string,
    hotelId: string,
    bookingCode: string,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_READ);

    const reservation = await this.prisma.client.reservation.findFirst({
      where: { propertyId: property.id, confirmationCode: bookingCode },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        source: true,
        createdAt: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        infants: true,
        mealPlan: true,
        guestFirstName: true,
        guestLastName: true,
        currency: true,
        totalAmountMinor: true,
        taxAmountMinor: true,
        paidAmountMinor: true,
        rooms: {
          select: {
            roomType: { select: { name: true } },
            room: { select: { number: true } },
          },
        },
        folio: {
          select: {
            id: true,
            status: true,
            currency: true,
            lines: {
              select: {
                id: true,
                kind: true,
                description: true,
                amountMinor: true,
                chargeDate: true,
                createdAt: true,
                paymentMethod: true,
                derivedFromLineId: true,
                reversesLineId: true,
              },
              orderBy: [{ chargeDate: 'asc' }, { createdAt: 'asc' }],
            },
          },
        },
      },
    });

    if (reservation === null) throw new TenantScopeViolationError('Reservation');

    const assignment = reservation.rooms[0] ?? null;
    const roomNumber = assignment?.room?.number ?? null;
    const lines: LineRow[] = reservation.folio?.lines ?? [];
    const currency = reservation.folio?.currency ?? reservation.currency;
    const propertyToday = currentDateInTimeZone(property.timezone, this.clock.now());

    const transactions = this.toTransactions(lines, roomNumber);
    const breakdown = this.toBreakdown(lines, currency);

    return {
      folioId: reservation.folio?.id ?? null,
      folioStatus: (reservation.folio?.status ?? null) as FolioPage['folioStatus'],
      propertyId: property.id as PropertyId,

      reservation: {
        id: reservation.id,
        bookingCode: reservation.confirmationCode,
        guestName: `${reservation.guestFirstName} ${reservation.guestLastName}`.trim(),
        status: reservation.status,
        source: reservation.source,
        isWalkIn: reservation.source === 'WALK_IN',
        bookedAt: reservation.createdAt.toISOString(),

        arrivalDate: toBusinessDate(
          reservation.arrivalDate,
        ) as FolioPage['reservation']['arrivalDate'],
        departureDate: toBusinessDate(
          reservation.departureDate,
        ) as FolioPage['reservation']['departureDate'],
        checkInTime: property.checkInTime,
        checkOutTime: property.checkOutTime,
        nights: Math.max(
          1,
          Math.round(
            (reservation.departureDate.getTime() - reservation.arrivalDate.getTime()) / DAY_MS,
          ),
        ),
        roomCount: reservation.rooms.length,
        adults: reservation.adults,
        children: reservation.children,
        infants: reservation.infants,

        mealPlan: reservation.mealPlan,
        roomTypeName: assignment?.roomType.name ?? 'Unknown category',
        roomNumber,

        canCheckIn:
          reservation.status === ReservationStatus.CONFIRMED &&
          toBusinessDate(reservation.arrivalDate) <= propertyToday,
        canCheckOut: reservation.status === ReservationStatus.CHECKED_IN,
      },

      totals: {
        currency,
        /**
         * What has actually been posted, not what the booking agreed.
         *
         * Before check-in the folio is empty, so this is zero while the
         * reservation's own quoted total is not. Those are different facts and
         * this page is the ledger's view; the drawer shows the agreed figures
         * beside it.
         */
        grossTotalMinor: breakdown.subtotalMinor + breakdown.taxMinor,
        paidMinor: breakdown.paymentsReceivedMinor,
        balanceDueMinor: breakdown.balanceDueMinor,
      },

      transactions,
      breakdown,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Postings                                                             */
  /* -------------------------------------------------------------------- */

  /**
   * An outlet or incidental charge: food, laundry, a bottle of water.
   *
   * Tax is supplied by the caller rather than computed from the property's
   * room-tax percentage. An outlet item may be zero-rated or sit in a
   * different slab, and quietly applying the room rate to a laundry bill is
   * wrong in a way nobody notices until an audit (section 3.4).
   */
  async postCharge(
    userId: string,
    hotelId: string,
    folioId: string,
    command: PostFolioChargeCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_CHARGE);
    const folio = await this.loadOpenFolio(property.id, folioId);
    /**
     * The **business date**, not the calendar date.
     *
     * CLAUDE.md section 3.3: all financial postings reference the business
     * date, never `now()`. This defaulted to the property's calendar date and
     * the inconsistency was visible on the page — a room charge posted by
     * check-in landed on the open accounting day while a water bottle posted
     * seconds later landed two days ahead of it, so the same folio showed two
     * posting dates for one afternoon's work and neither the night audit nor
     * a day-end report would have reconciled.
     *
     * An explicit `chargeDate` still wins: a charge raised late for yesterday
     * is a real thing a desk does.
     */
    const chargeDate = command.chargeDate ?? toBusinessDate(property.businessDate);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const charge = await tx.folioLine.create({
        data: {
          propertyId: property.id,
          folioId: folio.id,
          kind: 'SERVICE_CHARGE',
          description: command.description,
          amountMinor: command.netAmountMinor,
          currency: folio.currency,
          chargeDate: toUtcMidnight(chargeDate),
          postedById: userId,
        },
        select: { id: true },
      });

      if (command.taxAmountMinor > 0) {
        // Its own line, referencing the charge it derives from, so an invoice
        // can show it (section 3.4).
        await tx.folioLine.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            kind: 'TAX',
            description: `Tax on ${command.description}`,
            amountMinor: command.taxAmountMinor,
            currency: folio.currency,
            chargeDate: toUtcMidnight(chargeDate),
            derivedFromLineId: charge.id,
            postedById: userId,
          },
        });
      }

      await this.writeAudit(tx, property.id, userId, folio.reservationId, 'FOLIO_CHARGE_POSTED', {
        description: command.description,
        netAmountMinor: command.netAmountMinor,
        taxAmountMinor: command.taxAmountMinor,
        chargeDate,
      });
    });

    return this.byBookingCode(userId, hotelId, folio.bookingCode);
  }

  /** Money received at the desk. */
  async postPayment(
    userId: string,
    hotelId: string,
    folioId: string,
    command: PostFolioPaymentCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);
    const folio = await this.loadOpenFolio(property.id, folioId);
    const businessDate = toBusinessDate(property.businessDate);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      await tx.folioLine.create({
        data: {
          propertyId: property.id,
          folioId: folio.id,
          kind: 'PAYMENT',
          description: `Payment (${command.method})`,
          // Negative, so the balance stays one plain sum. The CHECK constraint
          // refuses the other sign.
          amountMinor: -command.amountMinor,
          currency: folio.currency,
          // Posted to the business date, never `now()` (section 3.3) — a
          // payment taken at 00:30 belongs to the open accounting day.
          chargeDate: toUtcMidnight(businessDate),
          paymentMethod: command.method,
          remark: command.remark,
          postedById: userId,
        },
      });

      // The reservation's own mirror of what has been taken, kept in step
      // inside the same transaction as the line.
      await tx.reservation.update({
        where: { id: folio.reservationId },
        data: { paidAmountMinor: { increment: command.amountMinor } },
      });

      await this.writeAudit(tx, property.id, userId, folio.reservationId, 'FOLIO_PAYMENT_POSTED', {
        method: command.method,
        amountMinor: command.amountMinor,
        businessDate,
      });
    });

    return this.byBookingCode(userId, hotelId, folio.bookingCode);
  }

  /**
   * A discount, posted as a negative adjustment.
   *
   * `ADJUSTMENT` is the one kind the sign CHECK leaves unconstrained, because
   * a correction legitimately goes either way. A discount is not a payment —
   * conflating the two would overstate cash taken at the desk and break the
   * night audit's reconciliation.
   */
  async postDiscount(
    userId: string,
    hotelId: string,
    folioId: string,
    command: PostFolioDiscountCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_DISCOUNT);
    const folio = await this.loadOpenFolio(property.id, folioId);
    const businessDate = toBusinessDate(property.businessDate);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      await tx.folioLine.create({
        data: {
          propertyId: property.id,
          folioId: folio.id,
          kind: 'ADJUSTMENT',
          description: `Discount — ${command.reason}`,
          amountMinor: -command.amountMinor,
          currency: folio.currency,
          chargeDate: toUtcMidnight(businessDate),
          postedById: userId,
        },
      });

      await this.writeAudit(tx, property.id, userId, folio.reservationId, 'FOLIO_DISCOUNT_APPLIED', {
        reason: command.reason,
        amountMinor: command.amountMinor,
        businessDate,
      });
    });

    return this.byBookingCode(userId, hotelId, folio.bookingCode);
  }

  /* -------------------------------------------------------------------- */
  /*  Projections                                                          */
  /* -------------------------------------------------------------------- */

  /**
   * The transaction table.
   *
   * Tax lines are folded into the charge they derive from rather than listed
   * separately. A table that shows "Room tariff ₹2,700" and "GST ₹135" as two
   * rows, each with its own GROSS, double-counts the tax to anybody reading
   * down the column — and that column is what a guest checks.
   *
   * A tax line whose parent is missing (posted standalone, or whose parent was
   * reversed) is still listed on its own, because silently dropping a charge
   * is worse than an orphan row.
   */
  private toTransactions(lines: readonly LineRow[], roomNumber: string | null): FolioTransaction[] {
    const taxByParent = new Map<string, number>();
    for (const line of lines) {
      if (line.kind === 'TAX' && line.derivedFromLineId !== null) {
        taxByParent.set(
          line.derivedFromLineId,
          (taxByParent.get(line.derivedFromLineId) ?? 0) + line.amountMinor,
        );
      }
    }

    return lines
      .filter((line) => !(line.kind === 'TAX' && line.derivedFromLineId !== null))
      .map((line) => {
        const taxMinor = taxByParent.get(line.id) ?? 0;
        const netMinor = line.amountMinor;

        return {
          id: line.id,
          date: toBusinessDate(line.chargeDate) as FolioTransaction['date'],
          room: roomNumber,
          description: line.description,
          kind: line.kind as FolioTransaction['kind'],
          // From the sign, which the database already constrains.
          direction: line.amountMinor < 0 ? 'CREDIT' : 'DEBIT',
          netMinor,
          taxMinor,
          grossMinor: netMinor + taxMinor,
          paymentMethod: line.paymentMethod as FolioTransaction['paymentMethod'],
          reversesLineId: line.reversesLineId,
          postedAt: line.createdAt.toISOString(),
        } satisfies FolioTransaction;
      });
  }

  private toBreakdown(lines: readonly LineRow[], currency: string): FolioBreakdown {
    let subtotalMinor = 0;
    let taxMinor = 0;
    let paymentsReceivedMinor = 0;
    let refundsIssuedMinor = 0;
    let adjustmentsMinor = 0;

    for (const line of lines) {
      switch (line.kind) {
        case 'TAX':
          taxMinor += line.amountMinor;
          break;
        case 'ROOM_CHARGE':
        case 'SERVICE_CHARGE':
          subtotalMinor += line.amountMinor;
          break;
        case 'PAYMENT':
          // Stored negative; reported as the positive sum a clerk expects.
          paymentsReceivedMinor += -line.amountMinor;
          break;
        case 'REFUND':
          refundsIssuedMinor += line.amountMinor;
          break;
        default:
          // ADJUSTMENT, either direction. Folded into the subtotal, because a
          // discount reduces what is charged rather than adding to what was
          // paid — counting it as cash would overstate the till.
          adjustmentsMinor += line.amountMinor;
      }
    }

    const chargesMinor = subtotalMinor + adjustmentsMinor;

    /**
     * Half each, when the split applies.
     *
     * Intra-state supply only; inter-state is IGST and is not split. There is
     * no place-of-supply field yet, so this reports the split it is showing
     * and lets the UI fall back to a single GST figure. The odd paisa goes to
     * CGST, which is the conventional allocation and keeps
     * `cgst + sgst === tax` exactly.
     */
    const cgstMinor = taxMinor - Math.floor(taxMinor / 2);
    const sgstMinor = Math.floor(taxMinor / 2);

    return {
      currency,
      subtotalMinor: chargesMinor,
      taxMinor,
      cgstMinor,
      sgstMinor,
      taxIsSplit: taxMinor > 0,
      paymentsReceivedMinor,
      refundsIssuedMinor,
      // No deposit concept exists; reported as zero rather than hidden.
      depositsHeldMinor: 0,
      balanceDueMinor:
        chargesMinor + taxMinor - paymentsReceivedMinor + refundsIssuedMinor,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  private async writeAudit(
    tx: Prisma.TransactionClient,
    propertyId: string,
    userId: string,
    reservationId: string,
    event: string,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    // In the same transaction as the posting it records (section 3.4). No
    // guest PII in the snapshot (section 5).
    await tx.auditLog.create({
      data: {
        propertyId,
        actorUserId: userId,
        event,
        entityType: 'folio',
        entityId: reservationId,
        // `Prisma.JsonNull` writes a JSON null; a bare `null` would be read as
        // "leave the column unset", which under `exactOptionalPropertyTypes`
        // is a different type entirely. A posting has no prior state, and the
        // row should say so rather than be silently absent.
        before: Prisma.JsonNull,
        after,
        reason: null,
      },
    });
  }

  private async loadOpenFolio(
    propertyId: string,
    folioId: string,
  ): Promise<{
    id: string;
    currency: string;
    reservationId: string;
    bookingCode: string;
  }> {
    const folio = await this.prisma.client.folio.findFirst({
      where: { id: folioId, propertyId },
      select: {
        id: true,
        status: true,
        currency: true,
        reservationId: true,
        reservation: { select: { confirmationCode: true } },
      },
    });

    if (folio === null) throw new TenantScopeViolationError('Folio');
    if (folio.status !== 'OPEN') {
      // A closed folio is settled history. Posting to it would change a bill
      // the guest has already been given.
      throw new FolioAlreadyClosedError(folio.id);
    }

    return {
      id: folio.id,
      currency: folio.currency,
      reservationId: folio.reservationId,
      bookingCode: folio.reservation.confirmationCode,
    };
  }

  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<{
    id: string;
    timezone: string;
    businessDate: Date;
    checkInTime: string;
    checkOutTime: string;
  }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: {
        role: { select: { key: true } },
        property: {
          select: {
            id: true,
            timezone: true,
            businessDate: true,
            checkInTime: true,
            checkOutTime: true,
          },
        },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants
      .map((grant) => grant.role.key)
      .filter((key): key is Role => key !== null);

    if (!permissionsForRoles(roles).includes(required)) {
      throw new ForbiddenError(required);
    }

    return first.property;
  }
}

/** Kinds that add to what is owed, exported for the night audit to reuse. */
export const FOLIO_CHARGE_KINDS = CHARGE_KINDS;

/** Guards against an empty command reaching a posting path. */
export function assertPositive(amountMinor: number, field: string): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationFailedError({ [field]: 'Must be a positive integer in minor units.' });
  }
}
