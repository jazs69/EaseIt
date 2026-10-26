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
  type CorrectFolioChargeCommand,
  type CorrectRoomChargesCommand,
  type PostFolioChargeCommand,
  type PostFolioDiscountCommand,
  type PostFolioPaymentCommand,
  type PropertyId,
  type Role,
  type TaxSlab,
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
import { PropertyTaxService } from '../properties/property-tax.service.js';
import { inclusiveRatePercentFor } from '../properties/tax-engine.js';

const DAY_MS = 86_400_000;

/** Kinds that increase what the guest owes. */
const CHARGE_KINDS = ['ROOM_CHARGE', 'SERVICE_CHARGE', 'TAX'] as const;

/**
 * What a line is, for the Summary tab's rollup.
 *
 * Derived from `kind`, not from the description: a clerk can edit a
 * description, and a rollup that keys on free text starts dropping rows out of
 * the total the first time somebody renames one.
 */
function groupOf(kind: string): FolioTransaction['group'] {
  if (kind === 'ROOM_CHARGE') return 'ROOM_TARIFF';
  if (kind === 'SERVICE_CHARGE') return 'SERVICE';
  if (kind === 'PAYMENT' || kind === 'REFUND') return 'MONEY';
  return 'OTHER';
}

/**
 * The rate a posted charge actually carried, as a plain percentage.
 *
 * ===========================================================================
 * A correction is re-rated at the original line's rate, not today's.
 *
 * This used to read the property's single `taxRatePercent`. Under a banded
 * table that is wrong twice over: the rate depends on the nightly tariff, so
 * there is no one property rate to read; and a slab the GST Council changed
 * last month must not retroactively re-rate a charge posted before it. Pulling
 * the rate out of the line itself gets both right — the adjustment splits at
 * exactly the rate the charge it corrects was posted at, so the corrected
 * line's net and tax still reconcile with each other.
 *
 * It is also self-contained: a correction needs no slab lookup at all, which
 * removes a database read from a path that already holds a transaction open.
 *
 * Two decimal places because that is the precision a slab stores. A line
 * posted at 18% gives back exactly 18, not 17.999999999999996.
 * ===========================================================================
 */
function impliedRatePercent(netMinor: number, taxMinor: number): number {
  if (netMinor === 0 || taxMinor === 0) return 0;
  return Math.round((taxMinor / netMinor) * 10_000) / 100;
}

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
    private readonly tax: PropertyTaxService,
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
        isTaxExempt: true,
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

    /**
     * Posted lines, plus what is agreed but not yet charged.
     *
     * ===========================================================================
     * **Scheduled rows are derived, never written.**
     *
     * The brief that prompted this asked for an "auto-heal backfill": when the
     * ledger is empty, have this GET insert the agreed tariff and any recorded
     * payment. That is refused, and the reason is not pedantry about HTTP verbs:
     *
     *   * Two clerks opening the page at once would each run the backfill, and
     *     the guest would be charged twice. `folio_line_one_room_charge_per_date`
     *     catches a duplicate *room charge*, but a lump-sum "Booking Price" line
     *     and a payment line would both go through.
     *   * The posting date would be whenever somebody happened to look, not the
     *     business date the charge belongs to (section 3.3).
     *   * Section 3.4 requires an audit row in the same transaction as every
     *     money mutation, naming the actor. "Opened a page" is not an actor
     *     posting a charge, and recording it as one would be a lie in the one
     *     table whose whole purpose is to be trustworthy.
     *
     * Deriving the same rows costs nothing and is honest: the figures a clerk
     * needs appear immediately, marked as scheduled, and converge on the posted
     * ones as check-in and the night audit do the actual charging. The
     * underlying hole — an advance that never reached the ledger — is fixed in
     * the booking path, where the money actually arrives.
     * ===========================================================================
     */
    const scheduled = this.toScheduledRows(
      {
        arrivalDate: reservation.arrivalDate,
        departureDate: reservation.departureDate,
        totalAmountMinor: reservation.totalAmountMinor,
        taxAmountMinor: reservation.taxAmountMinor,
        paidAmountMinor: reservation.paidAmountMinor,
        isTaxExempt: reservation.isTaxExempt,
        roomTypeName: assignment?.roomType.name ?? 'Room',
      },
      lines,
      roomNumber,
      await this.tax.slabsFor(
        property.id,
        // The legacy flat column, handed over only as a fallback for a
        // property with no slab rows. Precedence lives in PropertyTaxService.
        property.taxRatePercent === null ? null : Number(property.taxRatePercent),
      ),
    );

    const transactions = [...this.toTransactions(lines, roomNumber), ...scheduled].sort(
      (a, b) => (a.date === b.date ? a.postedAt.localeCompare(b.postedAt) : a.date.localeCompare(b.date)),
    );
    const breakdown = this.toBreakdown(transactions, currency);

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
        hasUnpostedCharges: transactions.some((entry) => !entry.isPosted),
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

  /**
   * Money received at the desk, by booking code.
   *
   * ===========================================================================
   * Opens the folio if there is not one yet, and that is not a contradiction.
   *
   * A read must never post to the books — see the note in `byBookingCode`. But
   * a clerk pressing "Collect payment" is the opposite situation: a person
   * with a name, taking money, with intent, who gets an audit row for it. The
   * folio is the container that money goes into, so refusing to create one
   * would mean telling a front desk it cannot accept cash until somebody has
   * checked the guest in.
   *
   * That matters beyond tidiness. 838 bookings predate the ledger and have no
   * folio; without this, every one of them has a dead "Collect payment"
   * button.
   *
   * Only the container is created. No charges are invented: nights are still
   * charged when they are consumed.
   * ===========================================================================
   */
  async postPaymentByBooking(
    userId: string,
    hotelId: string,
    bookingCode: string,
    command: PostFolioPaymentCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);

    const reservation = await this.prisma.client.reservation.findFirst({
      where: { propertyId: property.id, confirmationCode: bookingCode },
      select: { id: true, currency: true, folio: { select: { id: true } } },
    });
    if (reservation === null) throw new TenantScopeViolationError('Reservation');

    const folioId =
      reservation.folio?.id ??
      (
        await this.prisma.client.folio.create({
          data: {
            propertyId: property.id,
            reservationId: reservation.id,
            currency: reservation.currency,
            status: 'OPEN',
          },
          select: { id: true },
        })
      ).id;

    return this.postPayment(userId, hotelId, folioId, command);
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
   * Correct a posted charge to a new gross.
   *
   * ===========================================================================
   * **By posting the difference, never by updating the row.**
   *
   * Section 3.4: folio lines are immutable; a mistake is corrected with a line
   * that references the original. The brief that asked for this proposed
   * `prisma.folioTransaction.update({ data: { grossAmount, netAmount,
   * taxAmount } })`, which is precisely what that invariant exists to prevent.
   * A guest disputing a ₹3,000 charge has to be able to see that it was posted
   * at ₹2,733 and corrected by a named clerk at a known time; a row that has
   * been overwritten to read ₹3,000 cannot answer the question, and neither
   * can an auditor reading it a year later.
   *
   * So the difference is posted as an `ADJUSTMENT` pointing at the original,
   * with its own tax line for the tax share of the difference. The table folds
   * both into the charge's row, so the clerk sees the corrected gross; the
   * ledger keeps the original posting and every correction to it.
   *
   * A reversal-plus-repost would also preserve history, and is not used here:
   * `folio_line_one_room_charge_per_date` permits one non-reversing room
   * charge per date, so a replacement at the same date would be refused by the
   * database. Adjusting the difference leaves that guard intact — which is the
   * guard that stops the night audit double-charging a night.
   * ===========================================================================
   */
  async correctCharge(
    userId: string,
    hotelId: string,
    folioId: string,
    lineId: string,
    command: CorrectFolioChargeCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_CHARGE);
    const folio = await this.loadOpenFolio(property.id, folioId);

    const line = await this.prisma.client.folioLine.findFirst({
      where: { id: lineId, folioId: folio.id, propertyId: property.id },
      select: {
        id: true,
        kind: true,
        description: true,
        amountMinor: true,
        chargeDate: true,
        paymentMethod: true,
        derivedTax: { select: { id: true, amountMinor: true } },
        derivedFrom: { select: { id: true } },
      },
    });

    if (line === null) throw new TenantScopeViolationError('Folio line');

    // A correction corrects the original line, not another correction.
    if (line.derivedFrom !== null) {
      throw new ValidationFailedError({
        lineId: 'This line is itself a correction. Correct the original instead.',
      });
    }

    /**
     * Which direction the money goes, taken from the line rather than the
     * caller.
     *
     * A credit is stored negative so the balance stays one plain sum, and the
     * sign is constrained by `folio_line_sign_matches_kind`. The caller sends
     * a magnitude — a clerk types 5000, not -5000 — and the sign comes from
     * here, so a mistyped sign cannot flip a payment into a charge.
     */
    const isCredit = line.kind === 'PAYMENT';

    /**
     * What is already on this row, and what the difference needs to be.
     *
     * Integer minor units throughout — no `gross / 1.05` on a float
     * anywhere (section 3.4). The tax share of the difference is computed as
     * `delta - round(delta / (1 + rate))`, so net and tax still sum to the
     * corrected gross exactly rather than being a paisa apart.
     */
    const existingTaxMinor = line.derivedTax.reduce((sum, tax) => sum + tax.amountMinor, 0);
    const adjustments = await this.prisma.client.folioLine.findMany({
      where: { derivedFromLineId: line.id, kind: 'ADJUSTMENT' },
      select: { id: true, amountMinor: true },
    });
    const adjustmentTaxMinor =
      adjustments.length === 0
        ? 0
        : ((
            await this.prisma.client.folioLine.aggregate({
              where: {
                derivedFromLineId: { in: adjustments.map((entry) => entry.id) },
                kind: 'TAX',
              },
              _sum: { amountMinor: true },
            })
          )._sum.amountMinor ?? 0);

    const currentGrossMinor =
      line.amountMinor +
      existingTaxMinor +
      adjustments.reduce((sum, entry) => sum + entry.amountMinor, 0) +
      adjustmentTaxMinor;
    /**
     * The gross the clerk is asking for, whichever field they typed into.
     *
     * Editing NET means "the pre-tax price is this" — tax and gross are
     * computed forward from it. Editing GROSS means "the all-in price is this"
     * — net and tax come out of it. Both are resolved to a target gross here,
     * so the posting path below has one thing to reason about.
     *
     * Integer minor units, and the forward direction rounds the tax rather
     * than the net, so net + tax is exactly the gross it reports.
     */
    const targetGrossMinor = (() => {
      if (command.grossAmountMinor !== undefined) {
        return isCredit ? -command.grossAmountMinor : command.grossAmountMinor;
      }

      const net = command.netAmountMinor ?? 0;
      if (isCredit) return -net;
      const rate = impliedRatePercent(line.amountMinor, existingTaxMinor);
      if (rate <= 0) return net;
      return net + Math.round((net * rate) / 100);
    })();

    const deltaGrossMinor = targetGrossMinor - currentGrossMinor;

    if (deltaGrossMinor === 0) {
      // Nothing to post. Returning the page unchanged is the honest answer to
      // "correct this to the value it already has".
      return this.byBookingCode(userId, hotelId, folio.bookingCode);
    }

    const ratePercent = impliedRatePercent(line.amountMinor, existingTaxMinor);
    // Tax only where the original line actually carried some. A charge posted
    // tax-free stays tax-free when corrected, and a credit never carries tax.
    const taxable = !isCredit && existingTaxMinor !== 0 && ratePercent > 0;

    const deltaNetMinor = taxable
      ? Math.round(deltaGrossMinor / (1 + ratePercent / 100))
      : deltaGrossMinor;
    const deltaTaxMinor = deltaGrossMinor - deltaNetMinor;

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const adjustment = await tx.folioLine.create({
        data: {
          propertyId: property.id,
          folioId: folio.id,
          /**
           * The kind of the thing being corrected, not always ADJUSTMENT.
           *
           * Correcting a payment is still cash: posting it as an ADJUSTMENT
           * would move the difference out of "payments received" and into
           * "charges", understating the till and breaking the night audit's
           * reconciliation. The sign CHECK also requires a PAYMENT to be
           * negative, which a magnitude-plus-sign-from-the-line gives it.
           */
          kind: isCredit ? 'PAYMENT' : 'ADJUSTMENT',
          ...(isCredit && line.paymentMethod !== null
            ? { paymentMethod: line.paymentMethod }
            : {}),
          description:
            command.reason === null
              ? `Correction — ${line.description}`
              : `Correction — ${line.description} (${command.reason})`,
          amountMinor: deltaNetMinor,
          currency: folio.currency,
          // The date of the charge being corrected, not today: the correction
          // belongs to the night it adjusts (section 3.3).
          chargeDate: line.chargeDate,
          derivedFromLineId: line.id,
          postedById: userId,
        },
        select: { id: true },
      });

      if (deltaTaxMinor !== 0) {
        await tx.folioLine.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            kind: 'TAX',
            description: `Tax on correction — ${line.description}`,
            amountMinor: deltaTaxMinor,
            currency: folio.currency,
            chargeDate: line.chargeDate,
            // Hung off the adjustment, not the charge. Pointing it at the
            // charge made the charge's own tax indistinguishable from the
            // correction's, so `originalGrossMinor` reported the corrected tax
            // against the original net — a figure never charged to anyone. The
            // tree is now charge -> {its tax, its corrections} and
            // correction -> {its tax}, which keeps "what was actually posted"
            // answerable.
            derivedFromLineId: adjustment.id,
            postedById: userId,
          },
        });
      }

      if (isCredit) {
        // The reservation mirrors what has been taken. Corrected in the same
        // transaction as the line, or the two disagree the moment one fails.
        await tx.reservation.update({
          where: { id: folio.reservationId },
          data: { paidAmountMinor: { increment: -deltaGrossMinor } },
        });
      }

      await this.writeAudit(tx, property.id, userId, folio.reservationId, 'FOLIO_CHARGE_CORRECTED', {
        lineId: line.id,
        kind: line.kind,
        fromGrossMinor: currentGrossMinor,
        toGrossMinor: targetGrossMinor,
        deltaNetMinor,
        deltaTaxMinor,
        reason: command.reason,
      });
    });

    return this.byBookingCode(userId, hotelId, folio.bookingCode);
  }

  /**
   * Correct the whole stay's room charges together.
   *
   * ===========================================================================
   * One transaction, because the Summary row is one row.
   *
   * The consolidated "Booking Price" row covers several ledger lines, so
   * editing it has to correct all of them or none. N separate calls would
   * leave a stay corrected for three nights and not the other four after a
   * mid-way failure, and neither tab would show that.
   *
   * Each night takes a share of the difference in proportion to what it was
   * charged — a stay with an upgraded night keeps that night proportionally
   * larger — and the rounding remainder goes on the first night so the parts
   * sum to exactly the requested total (section 3.4).
   *
   * Refuses when any night is still scheduled: those figures come from the
   * reservation's agreed total, not the ledger, and changing them is a
   * re-quote. Correcting only the posted part and reporting a total nobody
   * asked for would be worse than saying no.
   * ===========================================================================
   */
  async correctRoomCharges(
    userId: string,
    hotelId: string,
    folioId: string,
    command: CorrectRoomChargesCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_CHARGE);
    const folio = await this.loadOpenFolio(property.id, folioId);

    const reservation = await this.prisma.client.reservation.findUnique({
      where: { id: folio.reservationId },
      select: { arrivalDate: true, departureDate: true, isTaxExempt: true },
    });
    if (reservation === null) throw new TenantScopeViolationError('Reservation');

    const nights = Math.max(
      1,
      Math.round(
        (reservation.departureDate.getTime() - reservation.arrivalDate.getTime()) / DAY_MS,
      ),
    );

    const charges = await this.prisma.client.folioLine.findMany({
      where: {
        folioId: folio.id,
        kind: 'ROOM_CHARGE',
        reversesLineId: null,
        derivedFromLineId: null,
      },
      select: { id: true, amountMinor: true, chargeDate: true, description: true },
      orderBy: { chargeDate: 'asc' },
    });

    if (charges.length === 0) {
      throw new ValidationFailedError({
        folioId: 'No room charges have been posted on this folio yet.',
      });
    }
    if (charges.length < nights) {
      throw new ValidationFailedError({
        folioId:
          `Only ${String(charges.length)} of ${String(nights)} nights are posted. ` +
          'Correct a posted night from the Itemized tab; the rest follow the agreed tariff.',
      });
    }

    // What the rollup currently shows: the charges, their tax, and every
    // correction already folded into them.
    const ids = charges.map((charge) => charge.id);
    const children = await this.prisma.client.folioLine.findMany({
      where: { derivedFromLineId: { in: ids } },
      select: { id: true, kind: true, amountMinor: true, derivedFromLineId: true },
    });
    const adjustmentIds = new Set(
      children.filter((child) => child.kind === 'ADJUSTMENT').map((child) => child.id),
    );
    const grandchildren = await this.prisma.client.folioLine.findMany({
      where: { derivedFromLineId: { in: [...adjustmentIds] }, kind: 'TAX' },
      select: { amountMinor: true },
    });

    const ownTaxMinor = children
      .filter((child) => child.kind === 'TAX')
      .reduce((sum, child) => sum + child.amountMinor, 0);
    // The posted nights before tax. Used for the implied rate below and for
    // apportioning the correction across nights further down.
    const baseNetMinor = charges.reduce((sum, charge) => sum + charge.amountMinor, 0);
    const currentGrossMinor =
      baseNetMinor +
      ownTaxMinor +
      children
        .filter((child) => child.kind === 'ADJUSTMENT')
        .reduce((sum, child) => sum + child.amountMinor, 0) +
      grandchildren.reduce((sum, child) => sum + child.amountMinor, 0);

    // The rate the nights were posted at, recovered from the nights
    // themselves. A banded table has no single property rate to read, and a
    // slab changed since must not re-rate what is already in the ledger.
    const ratePercent = impliedRatePercent(baseNetMinor, ownTaxMinor);
    const taxable = !reservation.isTaxExempt && ownTaxMinor !== 0 && ratePercent > 0;

    const targetGrossMinor =
      command.grossAmountMinor ??
      (taxable
        ? (command.netAmountMinor ?? 0) +
          Math.round(((command.netAmountMinor ?? 0) * ratePercent) / 100)
        : (command.netAmountMinor ?? 0));

    const deltaGrossMinor = targetGrossMinor - currentGrossMinor;
    if (deltaGrossMinor === 0) {
      return this.byBookingCode(userId, hotelId, folio.bookingCode);
    }

    /**
     * Each night's share, proportional to what it was charged.
     *
     * The remainder lands on the first night rather than being dropped, so the
     * shares sum to exactly the requested difference. Dividing and rounding
     * each independently leaves the stay a paisa or two off the total a clerk
     * just typed, and that total is what they will check.
     */
    const shares = charges.map((charge) =>
      baseNetMinor === 0
        ? Math.trunc(deltaGrossMinor / charges.length)
        : Math.trunc((deltaGrossMinor * charge.amountMinor) / baseNetMinor),
    );
    const allocated = shares.reduce((sum, share) => sum + share, 0);
    shares[0] = (shares[0] ?? 0) + (deltaGrossMinor - allocated);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      for (const [index, charge] of charges.entries()) {
        const shareGrossMinor = shares[index] ?? 0;
        if (shareGrossMinor === 0) continue;

        const shareNetMinor = taxable
          ? Math.round(shareGrossMinor / (1 + ratePercent / 100))
          : shareGrossMinor;
        const shareTaxMinor = shareGrossMinor - shareNetMinor;

        const adjustment = await tx.folioLine.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            kind: 'ADJUSTMENT',
            description:
              command.reason === null
                ? `Correction — ${charge.description}`
                : `Correction — ${charge.description} (${command.reason})`,
            amountMinor: shareNetMinor,
            currency: folio.currency,
            // The night being corrected, not today (section 3.3).
            chargeDate: charge.chargeDate,
            derivedFromLineId: charge.id,
            postedById: userId,
          },
          select: { id: true },
        });

        if (shareTaxMinor !== 0) {
          await tx.folioLine.create({
            data: {
              propertyId: property.id,
              folioId: folio.id,
              kind: 'TAX',
              description: `Tax on correction — ${charge.description}`,
              amountMinor: shareTaxMinor,
              currency: folio.currency,
              chargeDate: charge.chargeDate,
              // Hung off the adjustment, so each night's own tax stays
              // identifiable — see `correctCharge`.
              derivedFromLineId: adjustment.id,
              postedById: userId,
            },
          });
        }
      }

      await this.writeAudit(
        tx,
        property.id,
        userId,
        folio.reservationId,
        'FOLIO_ROOM_CHARGES_CORRECTED',
        {
          nights: charges.length,
          fromGrossMinor: currentGrossMinor,
          toGrossMinor: targetGrossMinor,
          deltaGrossMinor,
          reason: command.reason,
        },
      );
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
    const correctionByParent = new Map<string, number>();
    const correctionTaxByParent = new Map<string, number>();
    const correctionCount = new Map<string, number>();

    for (const line of lines) {
      if (line.derivedFromLineId === null) continue;
      if (line.kind === 'TAX') {
        taxByParent.set(
          line.derivedFromLineId,
          (taxByParent.get(line.derivedFromLineId) ?? 0) + line.amountMinor,
        );
      } else {
        // A correction to the line it points at — an ADJUSTMENT for a charge,
        // a PAYMENT or REFUND for a money movement. Folded into that row, so
        // the table shows the corrected figure, while the ledger keeps both
        // the original posting and every correction to it.
        correctionByParent.set(
          line.derivedFromLineId,
          (correctionByParent.get(line.derivedFromLineId) ?? 0) + line.amountMinor,
        );
        correctionCount.set(
          line.derivedFromLineId,
          (correctionCount.get(line.derivedFromLineId) ?? 0) + 1,
        );
      }
    }

    /**
     * A correction's own tax, re-attributed to the charge it corrects.
     *
     * It hangs off the adjustment so the charge's original tax stays
     * identifiable, but the *row* still has to show it or the row's gross
     * would be short by the tax on every correction. One hop, resolved here
     * rather than stored twice.
     */
    const adjustmentParent = new Map<string, string>();
    for (const line of lines) {
      if (line.kind === 'ADJUSTMENT' && line.derivedFromLineId !== null) {
        adjustmentParent.set(line.id, line.derivedFromLineId);
      }
    }

    for (const line of lines) {
      if (line.kind !== 'TAX' || line.derivedFromLineId === null) continue;
      const charge = adjustmentParent.get(line.derivedFromLineId);
      if (charge === undefined) continue;
      // Into the row's TAX, not its NET. Folding it into net left the tax
      // column reporting only the original charge's tax, so a corrected row
      // showed a gross of 3,000 against 58.33 of tax — which is not the split
      // on any amount, and is exactly the kind of figure somebody reconciles
      // an invoice against.
      correctionTaxByParent.set(
        charge,
        (correctionTaxByParent.get(charge) ?? 0) + line.amountMinor,
      );
    }

    return lines
      .filter((line) => line.derivedFromLineId === null)
      .map((line) => {
        const ownTaxMinor = taxByParent.get(line.id) ?? 0;
        const taxMinor = ownTaxMinor + (correctionTaxByParent.get(line.id) ?? 0);
        const netMinor = line.amountMinor + (correctionByParent.get(line.id) ?? 0);
        // What was actually posted, before any correction folded in.
        const chargeOnlyGrossMinor = line.amountMinor + ownTaxMinor;

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
          isPosted: true,
          group: groupOf(line.kind),
          // A posted charge may be corrected; money received may not — that is
          // a refund, not an edit of a number.
          // Charges and money movements alike. A mistyped payment is as
          // real a mistake as a mistyped tariff, and both are corrected the
          // same way: by posting the difference, never by overwriting.
          isCorrectable: line.derivedFromLineId === null,
          originalGrossMinor: chargeOnlyGrossMinor,
          correctionCount: correctionCount.get(line.id) ?? 0,
          paymentMethod: line.paymentMethod as FolioTransaction['paymentMethod'],
          reversesLineId: line.reversesLineId,
          postedAt: line.createdAt.toISOString(),
        } satisfies FolioTransaction;
      });
  }

  /**
   * What is agreed but not yet charged.
   *
   * One row per night still unposted, plus a credit for any advance the
   * reservation records that the ledger has not received. Both are derived and
   * neither is written — see the note at the call site for why a read must not
   * post to the books.
   *
   * Nights already in the ledger are skipped by date, so a mid-stay folio
   * shows night one as posted and the rest as scheduled rather than listing
   * every night twice.
   */
  private toScheduledRows(
    reservation: {
      arrivalDate: Date;
      departureDate: Date;
      totalAmountMinor: number;
      taxAmountMinor: number;
      paidAmountMinor: number;
      isTaxExempt: boolean;
      roomTypeName: string;
    },
    lines: readonly LineRow[],
    roomNumber: string | null,
    taxSlabs: readonly TaxSlab[],
  ): FolioTransaction[] {
    const rows: FolioTransaction[] = [];

    const nights = Math.max(
      1,
      Math.round(
        (reservation.departureDate.getTime() - reservation.arrivalDate.getTime()) / DAY_MS,
      ),
    );

    const postedRoomDates = new Set(
      lines
        .filter((line) => line.kind === 'ROOM_CHARGE' && line.reversesLineId === null)
        .map((line) => toBusinessDate(line.chargeDate)),
    );

    /**
     * The nightly split, with the rounding remainder on the first night.
     *
     * Dividing a total by nights and rounding each one independently leaves the
     * sum a paisa or two off the agreed figure, and the guest checks that sum
     * (section 3.4). The remainder is carried rather than dropped.
     */
    /**
     * The tax inside the agreed total.
     *
     * ===========================================================================
     * Taken from the booking when it recorded one; derived from the property's
     * configured rate when it did not.
     *
     * 881 of 882 reservations carry `taxAmountMinor = 0` — almost all because
     * they predate tax being computed, not because they are exempt. Reporting
     * a blank tax column against a property that charges 5% GST tells a clerk
     * nothing useful and tells an auditor something false, so the split is
     * derived for those.
     *
     * **Inclusive**, because the agreed total is what the guest was quoted:
     * tax comes out of the gross rather than being added on top, so the
     * balance a guest owes does not move because a split was computed.
     *
     * `isTaxExempt` is what stops a genuinely exempt stay being taxed by this
     * derivation. Before it was persisted the two cases were indistinguishable.
     *
     * **Banded on the nightly tariff, not the stay total.** The slab is chosen
     * from the total divided by nights, because that is the figure GST bands
     * on. Banding on the total would push a four-night ₹3,000 room into a
     * ₹12,000 slab and over-derive its tax by six points — on a figure that
     * then gets printed next to the one the guest agreed to.
     * ===========================================================================
     */
    const agreedTaxMinor = (() => {
      if (reservation.isTaxExempt) return 0;
      if (reservation.taxAmountMinor > 0) return reservation.taxAmountMinor;

      // Resolved from the net the total implies, not from the total divided by
      // nights: a gross nightly figure can sit above a slab boundary its net
      // does not, and rating on it would over-derive the tax by a whole band.
      const ratePercent = inclusiveRatePercentFor(
        reservation.totalAmountMinor,
        nights,
        taxSlabs,
      );
      if (ratePercent <= 0) return 0;

      // Integer minor units throughout. `gross - round(gross / (1 + rate))`
      // keeps net + tax === gross exactly, which rounding each half
      // independently does not (section 3.4).
      const net = Math.round(reservation.totalAmountMinor / (1 + ratePercent / 100));
      return reservation.totalAmountMinor - net;
    })();

    const nightlyTotal = Math.floor(reservation.totalAmountMinor / nights);
    const nightlyTax = Math.floor(agreedTaxMinor / nights);
    const totalRemainder = reservation.totalAmountMinor - nightlyTotal * nights;
    const taxRemainder = agreedTaxMinor - nightlyTax * nights;

    for (let offset = 0; offset < nights; offset += 1) {
      const date = toBusinessDate(
        new Date(reservation.arrivalDate.getTime() + offset * DAY_MS),
      );
      if (postedRoomDates.has(date)) continue;

      const grossMinor = nightlyTotal + (offset === 0 ? totalRemainder : 0);
      const taxMinor = nightlyTax + (offset === 0 ? taxRemainder : 0);

      rows.push({
        // Prefixed, so a scheduled row can never be mistaken for a line id and
        // sent to an endpoint that expects one.
        id: `scheduled-room-${date}`,
        date: date as FolioTransaction['date'],
        room: roomNumber,
        description: `${reservation.roomTypeName} tariff — ${date}`,
        kind: 'ROOM_CHARGE',
        direction: 'DEBIT',
        netMinor: grossMinor - taxMinor,
        taxMinor,
        grossMinor,
        isPosted: false,
        group: 'ROOM_TARIFF',
        isCorrectable: false,
        originalGrossMinor: grossMinor,
        correctionCount: 0,
        paymentMethod: null,
        reversesLineId: null,
        postedAt: `${date}T00:00:00.000Z`,
      });
    }

    /**
     * An advance the reservation records that the ledger has not received.
     *
     * Only for bookings taken before the booking path started posting its
     * advances — 838 of them at the time of writing. For anything booked since,
     * the payment is a real line and this difference is zero, so the row
     * disappears on its own rather than needing to be cleaned up.
     */
    const postedPayments = lines
      .filter((line) => line.kind === 'PAYMENT')
      .reduce((sum, line) => sum + -line.amountMinor, 0);
    const unrecorded = reservation.paidAmountMinor - postedPayments;

    if (unrecorded > 0) {
      const date = toBusinessDate(reservation.arrivalDate);
      rows.push({
        id: 'scheduled-advance',
        date: date as FolioTransaction['date'],
        room: roomNumber,
        description: 'Advance recorded at booking — not yet posted',
        kind: 'PAYMENT',
        direction: 'CREDIT',
        netMinor: -unrecorded,
        taxMinor: 0,
        grossMinor: -unrecorded,
        isPosted: false,
        group: 'MONEY',
        isCorrectable: false,
        originalGrossMinor: -unrecorded,
        correctionCount: 0,
        paymentMethod: null,
        reversesLineId: null,
        postedAt: `${date}T00:00:00.000Z`,
      });
    }

    return rows;
  }

  /**
   * The bottom summary, summed from the rows the page is actually showing.
   *
   * From `transactions` rather than raw lines, so the scheduled nights are
   * included: a stay arriving tomorrow would otherwise report a total of zero
   * beside a table listing its tariff, and a clerk reading a zero balance on a
   * booking that owes money is exactly the failure this exists to prevent.
   *
   * `postedSubtotalMinor` keeps the ledger-only figure beside it, because that
   * is the number an invoice may be raised from.
   */
  private toBreakdown(
    transactions: readonly FolioTransaction[],
    currency: string,
  ): FolioBreakdown {
    let subtotalMinor = 0;
    let postedSubtotalMinor = 0;
    let taxMinor = 0;
    let paymentsReceivedMinor = 0;
    let refundsIssuedMinor = 0;

    for (const entry of transactions) {
      // A charge row already carries the tax derived from it, folded in by
      // `toTransactions`, so net and tax are taken from the row rather than
      // from a separate TAX line that no longer appears.
      if (entry.kind === 'PAYMENT') {
        // Stored negative; reported as the positive sum a clerk expects.
        paymentsReceivedMinor += -entry.grossMinor;
        continue;
      }
      if (entry.kind === 'REFUND') {
        refundsIssuedMinor += entry.grossMinor;
        continue;
      }

      // ROOM_CHARGE, SERVICE_CHARGE, TAX posted standalone, and ADJUSTMENT —
      // the last in either direction, folded into charges because a discount
      // reduces what is billed rather than adding to what was taken. Counting
      // it as cash would overstate the till and break the audit's
      // reconciliation.
      subtotalMinor += entry.netMinor;
      taxMinor += entry.taxMinor;
      if (entry.isPosted) {
        postedSubtotalMinor += entry.netMinor;
      }
    }

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
      subtotalMinor,
      postedSubtotalMinor,
      taxMinor,
      cgstMinor,
      sgstMinor,
      taxIsSplit: taxMinor > 0,
      paymentsReceivedMinor,
      refundsIssuedMinor,
      // No deposit concept exists; reported as zero rather than hidden.
      depositsHeldMinor: 0,
      balanceDueMinor:
        subtotalMinor + taxMinor - paymentsReceivedMinor + refundsIssuedMinor,
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
    taxRatePercent: Prisma.Decimal | null;
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
            taxRatePercent: true,
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
