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

import { Injectable, Logger } from '@nestjs/common';
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
  type PaymentByKeyResult,
  type PostFolioPaymentCommand,
  type CloseFolioCommand,
  type PostFolioRefundCommand,
  type BillToCompanyCommand,
  type PropertyId,
  type Role,
  type TaxSlab,
} from '@repo/types';

import {
  FolioAlreadyClosedError,
  ForbiddenError,
  IdempotencyKeyReusedError,
  OutstandingBalanceError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { Prisma } from '@repo/database';

import { isLockTimeout, ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { uniqueViolationMentions } from '../../common/errors/unique-violation.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { ClockService } from '../platform/clock.service.js';
import { PropertyTaxService } from '../properties/property-tax.service.js';
import { inclusiveRatePercentFor } from '../properties/tax-engine.js';

const DAY_MS = 86_400_000;

/** The DTO's key shape, mirrored so a malformed key never reaches a query. */
const PAYMENT_KEY_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/** A replayed refund key is the same refund only if the money is the same (FO-12). */
function assertSameRefundIntent(
  existing: { folioId: string; amountMinor: number; kind: string; reversesLineId: string | null },
  folioId: string,
  paymentLineId: string,
  command: { amountMinor: number },
): void {
  const differing: string[] = [];
  if (existing.folioId !== folioId) differing.push('folioId');
  if (existing.kind !== 'REFUND') differing.push('kind');
  if (existing.reversesLineId !== paymentLineId) differing.push('paymentLineId');
  if (existing.amountMinor !== command.amountMinor) differing.push('amountMinor');
  if (differing.length > 0) throw new IdempotencyKeyReusedError(differing);
}

/**
 * What is left to refund on one payment: received (the payment plus any
 * PAYMENT correction to it, stored negative) less every REFUND against it.
 * The same rule `toTransactions` reports as `refundableMinor`.
 */
function refundableFrom(
  paymentId: string,
  lines: readonly {
    id: string;
    kind: string;
    amountMinor: number;
    derivedFromLineId: string | null;
    reversesLineId: string | null;
  }[],
): number {
  let received = 0;
  let refunded = 0;
  for (const line of lines) {
    if (
      line.kind === 'PAYMENT' &&
      (line.id === paymentId || line.derivedFromLineId === paymentId)
    ) {
      received -= line.amountMinor;
    } else if (line.kind === 'REFUND' && line.reversesLineId === paymentId) {
      refunded += line.amountMinor;
    }
  }
  return Math.max(0, received - refunded);
}

async function refundableOf(
  tx: Prisma.TransactionClient,
  propertyId: string,
  paymentId: string,
): Promise<number> {
  const lines = await tx.folioLine.findMany({
    where: {
      propertyId,
      OR: [
        { id: paymentId },
        { derivedFromLineId: paymentId, kind: 'PAYMENT' },
        { reversesLineId: paymentId, kind: 'REFUND' },
      ],
    },
    select: {
      id: true,
      kind: true,
      amountMinor: true,
      derivedFromLineId: true,
      reversesLineId: true,
    },
  });
  return refundableFrom(paymentId, lines);
}

/** Stays that will never be charged for an unposted night, so none is forecast. */
const STAYS_NOT_ACCRUING: ReadonlySet<string> = new Set([
  ReservationStatus.CANCELLED,
  ReservationStatus.NO_SHOW,
]);

/** Stays whose folio still accrues charges, so it closes at check-out, not here (FO-13). */
const STAYS_STILL_ACCRUING: ReadonlySet<string> = new Set([
  ReservationStatus.TENTATIVE,
  ReservationStatus.ON_HOLD,
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
]);

/** The one shape every "no such payment" answer takes. */
const NOT_FOUND_PAYMENT: PaymentByKeyResult = {
  found: false,
  lineId: null,
  folioId: null,
  amountMinor: null,
  method: null,
  chargeDate: null,
};

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
  /** A negative tax delta posted as an ADJUSTMENT (see the schema note). */
  isTaxAdjustment: boolean;
}

/**
 * Is this line tax? `TAX`, or an ADJUSTMENT flagged as a negative tax delta.
 * The ONE definition every total in this file uses, so a downward correction
 * reduces tax instead of masquerading as a change to the net.
 */
function isTaxLine(line: { kind: string; isTaxAdjustment: boolean }): boolean {
  return line.kind === 'TAX' || line.isTaxAdjustment;
}

/** The kind and flag for a tax delta: TAX when >= 0, a flagged ADJUSTMENT when < 0. */
function taxDeltaShape(deltaMinor: number): {
  kind: 'TAX' | 'ADJUSTMENT';
  isTaxAdjustment: boolean;
} {
  return deltaMinor < 0
    ? { kind: 'ADJUSTMENT', isTaxAdjustment: true }
    : { kind: 'TAX', isTaxAdjustment: false };
}

@Injectable()
export class FoliosService {
  private readonly logger = new Logger(FoliosService.name);

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
  async byBookingCode(userId: string, hotelId: string, bookingCode: string): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_READ);

    const reservation = await this.prisma.client.reservation.findFirst({
      where: { propertyId: property.id, confirmationCode: bookingCode },
      select: {
        id: true,
        confirmationCode: true,
        company: { select: { id: true, legalName: true, tradeName: true } },
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
        // F9: per-night prices, when the stay was booked with them.
        pricedNights: {
          select: { stayDate: true, rateMinor: true, taxMinor: true },
          orderBy: { stayDate: 'asc' },
        },
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
            invoice: { select: { id: true, number: true, invoiceDate: true, issuedAt: true } },
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
                isTaxAdjustment: true,
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
        pricedNights: reservation.pricedNights,
        status: reservation.status,
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

    const transactions = [...this.toTransactions(lines, roomNumber), ...scheduled].sort((a, b) =>
      a.date === b.date ? a.postedAt.localeCompare(b.postedAt) : a.date.localeCompare(b.date),
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
        company:
          reservation.company === null
            ? null
            : {
                id: reservation.company.id,
                name: reservation.company.tradeName ?? reservation.company.legalName,
              },

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
        // Net of refunds: money the hotel still holds. The breakdown keeps
        // received and refunded separately.
        paidMinor: breakdown.paymentsReceivedMinor - breakdown.refundsIssuedMinor,
        balanceDueMinor: breakdown.balanceDueMinor,
        hasUnpostedCharges: transactions.some((entry) => !entry.isPosted),
      },

      transactions,
      breakdown,

      invoice:
        reservation.folio?.invoice == null
          ? null
          : {
              id: reservation.folio.invoice.id,
              number: reservation.folio.invoice.number,
              invoiceDate: toBusinessDate(
                reservation.folio.invoice.invoiceDate,
              ) as FolioPage['reservation']['arrivalDate'],
              issuedAt: reservation.folio.invoice.issuedAt.toISOString(),
            },
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

    await this.inFolioWrite(property.id, folio, async (tx) => {
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

    /**
     * The container, created once even under a double-click.
     *
     * Two concurrent first payments on a folio-less booking both read
     * `folio: null` and both try to create one. `folio.reservationId` is
     * unique, so the loser raised `P2002` and answered 500 — a clerk's second
     * click on "Collect payment" produced an unexplained error. That is a
     * *container* collision, not a payment one: the losing request has posted
     * no money yet, so the honest resolution is to use the folio the winner
     * created and carry on. The payment itself is then deduplicated by its own
     * key inside `postPayment`, which is what stops the two requests posting
     * two lines into that one folio.
     */
    const folioId =
      reservation.folio?.id ??
      (await this.openFolio(property.id, reservation.id, reservation.currency));

    return this.postPayment(userId, hotelId, folioId, command);
  }

  /** Opens the payment container, tolerating a concurrent opener. */
  private async openFolio(
    propertyId: string,
    reservationId: string,
    currency: string,
  ): Promise<string> {
    try {
      const created = await this.prisma.client.folio.create({
        data: { propertyId, reservationId, currency, status: 'OPEN' },
        select: { id: true },
      });
      return created.id;
    } catch (cause) {
      // Only the one-folio-per-reservation index means "somebody else opened
      // it"; anything else is a real failure and propagates.
      if (!isFolioPerReservationCollision(cause)) throw cause;

      const existing = await this.prisma.client.folio.findFirst({
        where: { reservationId, propertyId },
        select: { id: true },
      });
      if (existing === null) throw cause;
      return existing.id;
    }
  }

  /**
   * What this idempotency key resolves to in the database, right now.
   *
   * ===========================================================================
   * A read, and nothing but a read.
   *
   * No transaction, no lock, no audit row, no `set_config`: there is nothing
   * to serialise because nothing is written. It exists so a client that lost a
   * response can *look* before it writes again -- the alternative is resending
   * the payment, which is safe but is still a write, and a front desk should
   * be able to answer "did that go through?" by asking rather than by acting.
   *
   * **Authoritative, not cached.** It reads `folio_line` through the same
   * Prisma client every posting uses, so it sees exactly what is committed. It
   * deliberately does not consult the recomputed folio page, which is shaped
   * for display and folds tax lines into their parents.
   *
   * **`found: false` carries no promise about the future.** It says no payment
   * line is visible under this key at the moment of the read. A request still
   * in flight may commit a moment later, so the caller must keep its key and
   * resolve through the idempotent write path. Saying more than that here
   * would invite a client to conclude the payment failed and post a second
   * one, which is the exact duplicate the key exists to prevent.
   *
   * Scoped by `propertyId` in the same predicate as the key (section 3.2), so
   * another property's payment is simply not found -- never a 403 that
   * confirms a key exists somewhere. Narrowed to `kind: 'PAYMENT'` as well, so
   * no other line can ever be reported through this route even if some future
   * writer starts stamping keys.
   * ===========================================================================
   */
  async findPaymentByKey(
    userId: string,
    hotelId: string,
    idempotencyKey: string,
  ): Promise<PaymentByKeyResult> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);

    /**
     * A key that cannot have been issued by this system is answered, not
     * refused.
     *
     * The shape is the DTO's (16-64 URL-safe characters). A malformed key
     * matches nothing by construction, so the honest answer is the same
     * `found: false` any unused key gets -- and it keeps a probe from learning
     * anything from the difference between "malformed" and "not yours".
     */
    if (!PAYMENT_KEY_SHAPE.test(idempotencyKey)) return NOT_FOUND_PAYMENT;

    const line = await this.prisma.client.folioLine.findFirst({
      where: { propertyId: property.id, idempotencyKey, kind: 'PAYMENT' },
      select: {
        id: true,
        folioId: true,
        amountMinor: true,
        paymentMethod: true,
        chargeDate: true,
      },
    });

    if (line === null) return NOT_FOUND_PAYMENT;

    return {
      found: true,
      lineId: line.id,
      folioId: line.folioId,
      // Stored negative (section 3.4); reported as the amount received, so a
      // caller compares it with what it sent rather than with its negation.
      amountMinor: -line.amountMinor,
      method: line.paymentMethod,
      // Branded at the boundary, the same way the folio page's line dates
      // are (`:1304`): `toBusinessDate` yields a plain string.
      chargeDate: toBusinessDate(line.chargeDate) as PaymentByKeyResult['chargeDate'],
    };
  }

  /**
   * Money received at the desk.
   *
   * ===========================================================================
   * **Exactly once per intent, and the index is what makes that true.**
   *
   * Three things move together: the payment line, the reservation's
   * `paidAmountMinor` mirror, and the audit row. Posting any of them twice is a
   * money bug of the worst kind, because `folio_line` is append-only (section
   * 3.4) -- a duplicate cannot be edited away, only corrected with a reversing
   * line, and until somebody does the folio is wrong in the direction that now
   * blocks a departure. Check-out refuses a balance that is non-zero *in either
   * direction*, so a duplicate payment leaves the guest in credit and unable to
   * check out.
   *
   * So the client sends one `idempotencyKey` per intent and reuses it on every
   * retry of that intent, and the line carries it under
   * `folio_line_propertyId_idempotencyKey_key`.
   *
   * **Why there is no "has this key been used?" read first.** Because it cannot
   * work. Two concurrent requests with the same key both read "no such line"
   * and both proceed; a lookup narrows the window without closing it, and that
   * window is exactly where a double-click lands. Only the unique index
   * decides, and it decides correctly under any isolation level -- the same
   * position section 3.1 takes on overselling. The insert is therefore
   * attempted, and the violation is an answer rather than a failure.
   *
   * That violation rolls the **whole** transaction back: PostgreSQL aborts on
   * constraint failure and refuses every later statement on that connection, so
   * nothing partial survives -- no line, no increment, no audit row. The
   * original is recovered *outside* the transaction, which is where this method
   * already does its final read.
   * ===========================================================================
   */
  async postPayment(
    userId: string,
    hotelId: string,
    folioId: string,
    command: PostFolioPaymentCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);
    const folio = await this.loadOpenFolio(property.id, folioId);
    const businessDate = toBusinessDate(property.businessDate);

    try {
      await this.inFolioWrite(property.id, folio, async (tx) => {
        await tx.folioLine.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            kind: 'PAYMENT',
            description: `Payment (${command.method})`,
            // Negative, so the balance stays one plain sum. The CHECK
            // constraint refuses the other sign.
            amountMinor: -command.amountMinor,
            currency: folio.currency,
            // Posted to the business date, never `now()` (section 3.3) — a
            // payment taken at 00:30 belongs to the open accounting day.
            chargeDate: toUtcMidnight(businessDate),
            paymentMethod: command.method,
            remark: command.remark,
            postedById: userId,
            idempotencyKey: command.idempotencyKey,
          },
        });

        // The reservation's own mirror of what has been taken, kept in step
        // inside the same transaction as the line.
        await tx.reservation.update({
          where: { id: folio.reservationId },
          data: { paidAmountMinor: { increment: command.amountMinor } },
        });

        await this.writeAudit(
          tx,
          property.id,
          userId,
          folio.reservationId,
          'FOLIO_PAYMENT_POSTED',
          {
            method: command.method,
            amountMinor: command.amountMinor,
            businessDate,
            idempotencyKey: command.idempotencyKey,
          },
        );
      });
    } catch (cause) {
      /**
       * Only this one index means "already recorded".
       *
       * `folio_line` carries a second unique index --
       * `folio_line_one_room_charge_per_date` -- so treating any `P2002` on
       * this table as a replay would silently swallow a genuine
       * double-charged-night bug. The constraint is identified by name before
       * anything is swallowed, and everything else propagates untouched.
       */
      if (!isIdempotencyKeyCollision(cause)) throw cause;

      await this.assertSamePaymentIntent(property.id, folio.id, command);
      this.logger.debug(`Folio payment replayed on an existing reference; nothing was posted.`);
    }

    return this.byBookingCode(userId, hotelId, folio.bookingCode);
  }

  /**
   * The key is already taken — by this payment, or by a different one?
   *
   * ===========================================================================
   * A replay is a success; a reuse is a refusal. Nothing else is safe.
   *
   * Returning the original for a command that asked for a different amount
   * would tell a clerk ₹7,000 was taken when the books hold ₹5,000. Posting it
   * as a new payment would defeat the key. So the stored line is compared with
   * what was asked for, and only an exact match on the material attributes is
   * reported as the original success.
   *
   * **Material** — the folio, the amount, the method: what the money *is*. The
   * folio is checked here rather than in the index because the index is scoped
   * per property, and that is deliberate: it makes the same key on another
   * folio a conflict to name rather than a second payment to accept.
   *
   * **Not material** — `remark`, a free-text note. A retry that re-typed it is
   * still the same money, and refusing over a comment would leave a clerk
   * unable to finish a payment the books have already taken. The first remark
   * stands, which is the one thing a replay cannot change.
   *
   * The read is scoped by `propertyId`, so it can neither see nor report on a
   * line belonging to another property (section 3.2). It runs outside the
   * aborted transaction, on a fresh connection, because the violation rolled
   * that one back.
   * ===========================================================================
   */
  private async assertSamePaymentIntent(
    propertyId: string,
    folioId: string,
    command: PostFolioPaymentCommand,
  ): Promise<void> {
    const existing = await this.prisma.client.folioLine.findFirst({
      where: { propertyId, idempotencyKey: command.idempotencyKey },
      select: { folioId: true, amountMinor: true, paymentMethod: true, kind: true },
    });

    /**
     * Gone between the violation and this read.
     *
     * Only reachable if the first line were deleted in that window, which no
     * production path does — a folio line is immutable. It is deliberately not
     * treated as a success: *this* request wrote nothing, and reporting a
     * payment that is not in the books is a lie about money. A typed conflict
     * tells the caller to try again, which will then either insert cleanly or
     * replay.
     */
    if (existing === null) throw new TransactionConflictError('folio payment');

    const differing: string[] = [];
    if (existing.folioId !== folioId) differing.push('folioId');
    // Stored negative (section 3.4); the command carries the positive amount a
    // clerk typed.
    if (existing.amountMinor !== -command.amountMinor) differing.push('amountMinor');
    if (existing.paymentMethod !== command.method) differing.push('method');
    // A key that landed on something other than a payment is not this intent
    // under any reading.
    if (existing.kind !== 'PAYMENT') differing.push('kind');

    if (differing.length > 0) throw new IdempotencyKeyReusedError(differing);
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
        // The charge's OWN tax only. Unfiltered, this relation also returned
        // the charge's ADJUSTMENT children, which were then counted again
        // below -- a second correction saw every earlier one twice.
        derivedTax: { where: { kind: 'TAX' }, select: { id: true, amountMinor: true } },
        derivedFrom: { select: { id: true } },
      },
    });

    if (line === null) throw new TenantScopeViolationError('Folio line');

    // A transfer to the city ledger mirrors a receivable on the company's
    // account (GP-07). Correcting one side alone would split them, so it is
    // refused; the company account is corrected with its own entries.
    if (line.paymentMethod === 'CITY_LEDGER') {
      throw new ValidationFailedError({
        lineId: 'A transfer to the company account cannot be corrected here.',
      });
    }

    // A refund is money returned; it is not edited (FO-12).
    if (line.kind === 'REFUND') {
      throw new ValidationFailedError({
        lineId: 'A refund cannot be corrected. Post a payment to undo it.',
      });
    }

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
      where: { derivedFromLineId: line.id, kind: 'ADJUSTMENT', isTaxAdjustment: false },
      select: { id: true, amountMinor: true },
    });
    const adjustmentTaxMinor =
      adjustments.length === 0
        ? 0
        : ((
            await this.prisma.client.folioLine.aggregate({
              where: {
                derivedFromLineId: { in: adjustments.map((entry) => entry.id) },
                OR: [{ kind: 'TAX' }, { isTaxAdjustment: true }],
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

    await this.inFolioWrite(property.id, folio, async (tx) => {
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
          ...(isCredit && line.paymentMethod !== null ? { paymentMethod: line.paymentMethod } : {}),
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
            // A negative delta is a flagged ADJUSTMENT: TAX lines are >= 0.
            ...taxDeltaShape(deltaTaxMinor),
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

      if (line.kind === 'ROOM_CHARGE') {
        await this.applyRoomCorrectionToBooking(
          tx,
          property.id,
          folio.reservationId,
          line.chargeDate,
          deltaNetMinor,
          deltaTaxMinor,
        );
      }

      if (isCredit) {
        // The reservation mirrors what has been taken. Corrected in the same
        // transaction as the line, or the two disagree the moment one fails.
        await tx.reservation.update({
          where: { id: folio.reservationId },
          data: { paidAmountMinor: { increment: -deltaGrossMinor } },
        });
      }

      await this.writeAudit(
        tx,
        property.id,
        userId,
        folio.reservationId,
        'FOLIO_CHARGE_CORRECTED',
        {
          lineId: line.id,
          kind: line.kind,
          fromGrossMinor: currentGrossMinor,
          toGrossMinor: targetGrossMinor,
          deltaNetMinor,
          deltaTaxMinor,
          reason: command.reason,
        },
      );
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
      select: {
        id: true,
        kind: true,
        amountMinor: true,
        derivedFromLineId: true,
        isTaxAdjustment: true,
      },
    });
    const adjustmentIds = new Set(
      children
        .filter((child) => child.kind === 'ADJUSTMENT' && !child.isTaxAdjustment)
        .map((child) => child.id),
    );
    const grandchildren = await this.prisma.client.folioLine.findMany({
      where: {
        derivedFromLineId: { in: [...adjustmentIds] },
        OR: [{ kind: 'TAX' }, { isTaxAdjustment: true }],
      },
      select: { amountMinor: true, derivedFromLineId: true },
    });

    const ownTaxMinor = children
      .filter((child) => isTaxLine(child))
      .reduce((sum, child) => sum + child.amountMinor, 0);
    // The posted nights before tax. Used for the implied rate below and for
    // apportioning the correction across nights further down.
    const baseNetMinor = charges.reduce((sum, charge) => sum + charge.amountMinor, 0);
    const currentGrossMinor =
      baseNetMinor +
      ownTaxMinor +
      children
        .filter((child) => child.kind === 'ADJUSTMENT' && !child.isTaxAdjustment)
        .reduce((sum, child) => sum + child.amountMinor, 0) +
      grandchildren.reduce((sum, child) => sum + child.amountMinor, 0);

    // The rate the nights were posted at, recovered from the nights
    // themselves. A banded table has no single property rate to read, and a
    // slab changed since must not re-rate what is already in the ledger.
    const ratePercent = impliedRatePercent(baseNetMinor, ownTaxMinor);
    const taxable = !reservation.isTaxExempt && ownTaxMinor !== 0 && ratePercent > 0;

    /**
     * Each night's OWN rate, from its own tax line.
     *
     * A stay priced per night (F9) can straddle GST bands -- a 5% weeknight
     * beside an 18% Saturday. One rate implied from the stay totals is then
     * right for neither night, and a correction split with it would post the
     * wrong tax on both. When every night shares a rate the old single-rate
     * arithmetic is kept exactly, so uniform stays are unaffected.
     */
    const nightRates = charges.map((charge) => {
      const nightTaxMinor = children
        .filter((child) => isTaxLine(child) && child.derivedFromLineId === charge.id)
        .reduce((sum, child) => sum + child.amountMinor, 0);
      const rate = impliedRatePercent(charge.amountMinor, nightTaxMinor);
      return reservation.isTaxExempt || nightTaxMinor === 0 ? 0 : rate;
    });
    const mixedBands = new Set(nightRates).size > 1;

    /** Split a sum across nights in proportion to what each was charged; remainder on night one. */
    const apportion = (totalMinor: number): number[] => {
      const parts = charges.map((charge) =>
        baseNetMinor === 0
          ? Math.trunc(totalMinor / charges.length)
          : Math.trunc((totalMinor * charge.amountMinor) / baseNetMinor),
      );
      parts[0] = (parts[0] ?? 0) + (totalMinor - parts.reduce((sum, part) => sum + part, 0));
      return parts;
    };

    const targetGrossMinor =
      command.grossAmountMinor ??
      (mixedBands
        ? // A target NET is grossed up night by night, each at its own rate.
          apportion(command.netAmountMinor ?? 0).reduce(
            (sum, net, index) => sum + net + Math.round((net * (nightRates[index] ?? 0)) / 100),
            0,
          )
        : taxable
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
    let shares: number[];
    if (!mixedBands) {
      shares = charges.map((charge) =>
        baseNetMinor === 0
          ? Math.trunc(deltaGrossMinor / charges.length)
          : Math.trunc((deltaGrossMinor * charge.amountMinor) / baseNetMinor),
      );
      const allocated = shares.reduce((sum, share) => sum + share, 0);
      shares[0] = (shares[0] ?? 0) + (deltaGrossMinor - allocated);
    } else {
      /**
       * Mixed bands: each night moves from ITS current gross to ITS target.
       *
       * Splitting one stay-level delta by the original charges would move a
       * 5% night and an 18% night by amounts that, once each is split at its
       * own rate, no longer add up to the requested net. Per-night targets
       * keep every night in its band and the stay on the number typed (to a
       * paisa of rounding per night). The shares still sum to deltaGrossMinor.
       */
      const nightOf = new Map<string, string>(
        children
          .filter((child) => child.kind === 'ADJUSTMENT' && child.derivedFromLineId !== null)
          .map((child) => [child.id, child.derivedFromLineId as string]),
      );
      const currentPerNight = charges.map(
        (charge) =>
          charge.amountMinor +
          children
            .filter((child) => child.derivedFromLineId === charge.id)
            .reduce((sum, child) => sum + child.amountMinor, 0) +
          grandchildren
            .filter(
              (child) =>
                child.derivedFromLineId !== null &&
                nightOf.get(child.derivedFromLineId) === charge.id,
            )
            .reduce((sum, child) => sum + child.amountMinor, 0),
      );
      const targetPerNight =
        command.grossAmountMinor !== undefined
          ? apportion(command.grossAmountMinor)
          : apportion(command.netAmountMinor ?? 0).map(
              (net, index) => net + Math.round((net * (nightRates[index] ?? 0)) / 100),
            );
      shares = targetPerNight.map((target, index) => target - (currentPerNight[index] ?? 0));
    }

    await this.inFolioWrite(property.id, folio, async (tx) => {
      for (const [index, charge] of charges.entries()) {
        const shareGrossMinor = shares[index] ?? 0;
        if (shareGrossMinor === 0) continue;

        // The night's own rate when bands are mixed; the stay rate otherwise.
        const nightRate = mixedBands ? (nightRates[index] ?? 0) : taxable ? ratePercent : 0;
        const shareNetMinor =
          nightRate > 0 ? Math.round(shareGrossMinor / (1 + nightRate / 100)) : shareGrossMinor;
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
              // A negative delta is a flagged ADJUSTMENT: TAX lines are >= 0.
              ...taxDeltaShape(shareTaxMinor),
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

        await this.applyRoomCorrectionToBooking(
          tx,
          property.id,
          folio.reservationId,
          charge.chargeDate,
          shareNetMinor,
          shareTaxMinor,
        );
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

    await this.inFolioWrite(property.id, folio, async (tx) => {
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

      await this.writeAudit(
        tx,
        property.id,
        userId,
        folio.reservationId,
        'FOLIO_DISCOUNT_APPLIED',
        {
          reason: command.reason,
          amountMinor: command.amountMinor,
          businessDate,
        },
      );
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
      if (isTaxLine(line)) {
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
      if (line.kind === 'ADJUSTMENT' && !line.isTaxAdjustment && line.derivedFromLineId !== null) {
        adjustmentParent.set(line.id, line.derivedFromLineId);
      }
    }

    for (const line of lines) {
      if (!isTaxLine(line) || line.derivedFromLineId === null) continue;
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
          // A refund is not corrected by editing it either: a wrong refund is
          // put right with a payment, the way money actually moves (FO-12).
          isCorrectable: line.derivedFromLineId === null && line.kind !== 'REFUND',
          originalGrossMinor: chargeOnlyGrossMinor,
          correctionCount: correctionCount.get(line.id) ?? 0,
          refundableMinor: line.kind === 'PAYMENT' ? refundableFrom(line.id, lines) : null,
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
      pricedNights: readonly { stayDate: Date; rateMinor: number; taxMinor: number }[];
      status: string;
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
    /**
     * Room-charge corrections are carried onto the reservation's total and tax
     * (`applyRoomCorrectionToBooking`), but they only ever touch POSTED nights.
     * The even split below is for the nights still to come, so it works from
     * the total as booked: backing the corrections out keeps an unposted
     * night of a pre-F9 stay at its agreed price instead of absorbing a share
     * of a correction made to a different night.
     */
    const byId = new Map(lines.map((line) => [line.id, line]));
    let correctionGrossMinor = 0;
    let correctionTaxMinor = 0;
    for (const line of lines) {
      const parent = line.derivedFromLineId === null ? undefined : byId.get(line.derivedFromLineId);
      if (parent === undefined) continue;
      const correctsRoomCharge =
        (line.kind === 'ADJUSTMENT' && !line.isTaxAdjustment && parent.kind === 'ROOM_CHARGE') ||
        (isTaxLine(line) &&
          parent.kind === 'ADJUSTMENT' &&
          parent.derivedFromLineId !== null &&
          byId.get(parent.derivedFromLineId)?.kind === 'ROOM_CHARGE');
      if (!correctsRoomCharge) continue;
      correctionGrossMinor += line.amountMinor;
      if (isTaxLine(line)) correctionTaxMinor += line.amountMinor;
    }
    const bookedTotalMinor = reservation.totalAmountMinor - correctionGrossMinor;
    const bookedTaxMinor =
      reservation.taxAmountMinor > 0 ? reservation.taxAmountMinor - correctionTaxMinor : 0;

    const agreedTaxMinor = (() => {
      if (reservation.isTaxExempt) return 0;
      if (bookedTaxMinor > 0) return bookedTaxMinor;

      // Resolved from the net the total implies, not from the total divided by
      // nights: a gross nightly figure can sit above a slab boundary its net
      // does not, and rating on it would over-derive the tax by a whole band.
      const ratePercent = inclusiveRatePercentFor(bookedTotalMinor, nights, taxSlabs);
      if (ratePercent <= 0) return 0;

      // Integer minor units throughout. `gross - round(gross / (1 + rate))`
      // keeps net + tax === gross exactly, which rounding each half
      // independently does not (section 3.4).
      const net = Math.round(bookedTotalMinor / (1 + ratePercent / 100));
      return bookedTotalMinor - net;
    })();

    const nightlyTotal = Math.floor(bookedTotalMinor / nights);
    const nightlyTax = Math.floor(agreedTaxMinor / nights);
    const totalRemainder = bookedTotalMinor - nightlyTotal * nights;
    const taxRemainder = agreedTaxMinor - nightlyTax * nights;

    const pricedByDate = new Map(
      reservation.pricedNights.map((night) => [toBusinessDate(night.stayDate), night]),
    );

    /**
     * A cancelled or no-show stay will never be charged for its remaining
     * nights, so they are not forecast. Showing them made the page report the
     * whole tariff as due on a stay that ended, and told a clerk a zero-balance
     * folio was "not settled". Posted nights, if any, still show from the ledger.
     */
    const forecastsNights = !STAYS_NOT_ACCRUING.has(reservation.status);

    for (let offset = 0; forecastsNights && offset < nights; offset += 1) {
      const date = toBusinessDate(new Date(reservation.arrivalDate.getTime() + offset * DAY_MS));
      if (postedRoomDates.has(date)) continue;

      // F9: a stay priced per night shows each night at its own price. Older
      // stays have no rows and keep the even split with the remainder above.
      const priced = pricedByDate.get(date);
      const grossMinor =
        priced !== undefined
          ? priced.rateMinor + priced.taxMinor
          : nightlyTotal + (offset === 0 ? totalRemainder : 0);
      const taxMinor =
        priced !== undefined ? priced.taxMinor : nightlyTax + (offset === 0 ? taxRemainder : 0);

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
        refundableMinor: null,
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
    // Net of refunds, because `paidAmountMinor` is: a refund decrements it
    // (FO-12), and comparing it with gross payments would hide part of a
    // genuinely unposted advance.
    const postedPayments = lines
      .filter((line) => line.kind === 'PAYMENT' || line.kind === 'REFUND')
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
        refundableMinor: null,
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
  private toBreakdown(transactions: readonly FolioTransaction[], currency: string): FolioBreakdown {
    let subtotalMinor = 0;
    let postedSubtotalMinor = 0;
    let taxMinor = 0;
    let paymentsReceivedMinor = 0;
    let billedToCompanyMinor = 0;
    let refundsIssuedMinor = 0;

    for (const entry of transactions) {
      // A charge row already carries the tax derived from it, folded in by
      // `toTransactions`, so net and tax are taken from the row rather than
      // from a separate TAX line that no longer appears.
      if (entry.kind === 'PAYMENT') {
        // Stored negative; reported as the positive sum a clerk expects.
        paymentsReceivedMinor += -entry.grossMinor;
        if (entry.paymentMethod === 'CITY_LEDGER') billedToCompanyMinor += -entry.grossMinor;
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
      billedToCompanyMinor,
      refundsIssuedMinor,
      // No deposit concept exists; reported as zero rather than hidden.
      depositsHeldMinor: 0,
      balanceDueMinor: subtotalMinor + taxMinor - paymentsReceivedMinor + refundsIssuedMinor,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Bill to company: the city ledger (GP-07)                             */
  /* -------------------------------------------------------------------- */

  /**
   * Moves (part of) a folio's balance onto the stay's company account.
   *
   * ===========================================================================
   * One transaction, under the folio locks every folio write takes
   * (reservation, then folio, FOR UPDATE, bounded wait):
   *
   * 1. Re-read, under the lock, the stay's company and the folio balance. A
   *    stay with no company is refused. So is an amount above the balance:
   *    a transfer settles what the guest owes, it never puts the folio in
   *    credit.
   * 2. Post a PAYMENT line with method CITY_LEDGER, negative like every
   *    payment, on the business date, carrying the client's idempotency key.
   * 3. Write the TRANSFER entry on `company_ledger_entry` pointing at that
   *    line. A deferred trigger refuses a CITY_LEDGER line with no entry, and
   *    the entry's trigger refuses one that does not match its line, so the
   *    two cannot disagree.
   * 4. Keep the reservation's paid mirror in step and write the audit row.
   *
   * The folio then settles, checks out, closes and is invoiced to the company
   * as usual. A replay with the same key is the original success; a different
   * intent under that key is a typed conflict. Concurrent transfers serialise
   * on the folio lock, and the second sees the reduced balance.
   *
   * Lock order matches every folio write. The company row is not locked here,
   * only referenced: the insert takes FOR KEY SHARE on it, which the company
   * payment's FOR NO KEY UPDATE does not block, so the two never deadlock.
   * ===========================================================================
   */
  async billToCompany(
    userId: string,
    hotelId: string,
    folioId: string,
    command: BillToCompanyCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.DIRECT_BILLING_MANAGE);
    const folio = await this.loadOpenFolio(property.id, folioId);
    const businessDate = toBusinessDate(property.businessDate);

    try {
      await this.inFolioWrite(property.id, folio, async (tx) => {
        const stay = await tx.reservation.findFirst({
          where: { id: folio.reservationId, propertyId: property.id },
          select: { companyId: true },
        });
        if (stay?.companyId === null || stay?.companyId === undefined) {
          throw new ValidationFailedError({
            amountMinor: 'This stay is not attached to a company, so it cannot be billed to one.',
          });
        }

        const balanceMinor =
          (
            await tx.folioLine.aggregate({
              where: { folioId: folio.id, propertyId: property.id },
              _sum: { amountMinor: true },
            })
          )._sum.amountMinor ?? 0;
        if (command.amountMinor > balanceMinor) {
          throw new ValidationFailedError({
            amountMinor:
              balanceMinor <= 0
                ? 'Nothing is owed on this folio.'
                : `At most ${String(balanceMinor)} is owed on this folio.`,
          });
        }

        const line = await tx.folioLine.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            kind: 'PAYMENT',
            description: 'Billed to company account',
            amountMinor: -command.amountMinor,
            currency: folio.currency,
            chargeDate: toUtcMidnight(businessDate),
            paymentMethod: 'CITY_LEDGER',
            remark: command.remark,
            postedById: userId,
            idempotencyKey: command.idempotencyKey,
          },
          select: { id: true },
        });

        await tx.companyLedgerEntry.create({
          data: {
            propertyId: property.id,
            companyId: stay.companyId,
            kind: 'TRANSFER',
            amountMinor: command.amountMinor,
            currency: folio.currency,
            postingDate: toUtcMidnight(businessDate),
            reservationId: folio.reservationId,
            folioLineId: line.id,
            remark: command.remark,
            postedById: userId,
          },
        });

        await tx.reservation.update({
          where: { id: folio.reservationId },
          data: { paidAmountMinor: { increment: command.amountMinor } },
        });

        await this.writeAudit(
          tx,
          property.id,
          userId,
          folio.reservationId,
          'FOLIO_BILLED_TO_COMPANY',
          {
            companyId: stay.companyId,
            amountMinor: command.amountMinor,
            businessDate,
            idempotencyKey: command.idempotencyKey,
          },
        );
      });
    } catch (cause) {
      if (!isIdempotencyKeyCollision(cause)) throw cause;
      // The same check a payment replay gets: same folio, amount and method.
      await this.assertSamePaymentIntent(property.id, folio.id, {
        method: 'CITY_LEDGER' as PostFolioPaymentCommand['method'],
        amountMinor: command.amountMinor,
        remark: command.remark,
        idempotencyKey: command.idempotencyKey,
      });
    }

    return this.byBookingCode(userId, hotelId, folio.bookingCode);
  }

  /* -------------------------------------------------------------------- */
  /*  Refunds and settlement (FO-12, FO-13)                                */
  /* -------------------------------------------------------------------- */

  /**
   * Return money against one posted payment (FO-12).
   *
   * ===========================================================================
   * A REFUND line pointing at the payment through `reversesLineId`: the
   * payment is never touched (section 3.4), and the ledger shows what came in
   * and what went back, linked. Stored positive (the sign CHECK requires it),
   * so the balance stays one plain sum. Method and card detail are copied
   * from the payment: money goes back the way it came.
   *
   * **Capped per payment, under the lock.** What is left to refund is what
   * the payment received (after any correction to it) less every refund
   * already posted against it, computed after the reservation and folio rows
   * are locked, so two concurrent refunds cannot both pass the check and
   * return more than was received.
   *
   * **Idempotent per key.** The key is looked up under the same lock before
   * anything is checked, so a replay of a refund that emptied the payment is
   * answered as the original success rather than refused as "nothing left to
   * refund". The unique index stays the backstop for the same key on another
   * folio.
   * ===========================================================================
   */
  async postRefund(
    userId: string,
    hotelId: string,
    folioId: string,
    paymentLineId: string,
    command: PostFolioRefundCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_REFUND);
    const folio = await this.loadOpenFolio(property.id, folioId);
    const businessDate = toBusinessDate(property.businessDate);

    try {
      await this.inFolioWrite(property.id, folio, async (tx) => {
        const replayed = await tx.folioLine.findFirst({
          where: { propertyId: property.id, idempotencyKey: command.idempotencyKey },
          select: { folioId: true, amountMinor: true, kind: true, reversesLineId: true },
        });
        if (replayed !== null) {
          assertSameRefundIntent(replayed, folio.id, paymentLineId, command);
          return;
        }

        const payment = await tx.folioLine.findFirst({
          where: { id: paymentLineId, folioId: folio.id, propertyId: property.id },
          select: {
            id: true,
            kind: true,
            paymentMethod: true,
            cardLast4: true,
            paymentIssuer: true,
            derivedFromLineId: true,
          },
        });
        if (payment === null) throw new TenantScopeViolationError('Folio line');
        if (payment.kind !== 'PAYMENT' || payment.derivedFromLineId !== null) {
          throw new ValidationFailedError({
            paymentLineId:
              'Only a posted payment can be refunded. Refund the original payment, not a correction to it.',
          });
        }
        // Billed to a company, not received: there is no money to return (GP-07).
        if (payment.paymentMethod === 'CITY_LEDGER') {
          throw new ValidationFailedError({
            paymentLineId:
              'This was billed to the company account, not paid, so it cannot be refunded.',
          });
        }

        const refundableMinor = await refundableOf(tx, property.id, payment.id);
        if (command.amountMinor > refundableMinor) {
          throw new ValidationFailedError({
            amountMinor: `At most ${String(refundableMinor)} can still be refunded on this payment.`,
          });
        }

        await tx.folioLine.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            kind: 'REFUND',
            description: `Refund (${payment.paymentMethod ?? 'OTHER'}) — ${command.reason}`,
            amountMinor: command.amountMinor,
            currency: folio.currency,
            // The open accounting day, never now() (section 3.3).
            chargeDate: toUtcMidnight(businessDate),
            paymentMethod: payment.paymentMethod,
            cardLast4: payment.cardLast4,
            paymentIssuer: payment.paymentIssuer,
            reversesLineId: payment.id,
            remark: command.reason,
            postedById: userId,
            idempotencyKey: command.idempotencyKey,
          },
        });

        // The reservation's mirror of money taken, in the same transaction.
        await tx.reservation.update({
          where: { id: folio.reservationId },
          data: { paidAmountMinor: { decrement: command.amountMinor } },
        });

        await this.writeAudit(tx, property.id, userId, folio.reservationId, 'FOLIO_REFUND_POSTED', {
          paymentLineId: payment.id,
          method: payment.paymentMethod,
          amountMinor: command.amountMinor,
          refundableBeforeMinor: refundableMinor,
          reason: command.reason,
          businessDate,
          idempotencyKey: command.idempotencyKey,
        });
      });
    } catch (cause) {
      // The same key landed on another folio between the lookup and the
      // insert: the index decided, so compare against what it kept.
      if (!isIdempotencyKeyCollision(cause)) throw cause;
      const existing = await this.prisma.client.folioLine.findFirst({
        where: { propertyId: property.id, idempotencyKey: command.idempotencyKey },
        select: { folioId: true, amountMinor: true, kind: true, reversesLineId: true },
      });
      if (existing === null) throw new TransactionConflictError('folio refund');
      assertSameRefundIntent(existing, folio.id, paymentLineId, command);
    }

    return this.byBookingCode(userId, hotelId, folio.bookingCode);
  }

  /**
   * Close a settled folio outside check-out (FO-13).
   *
   * ===========================================================================
   * Check-out closes an in-house stay's folio. This closes the rest: a
   * cancelled or no-show stay whose deposit has been refunded, or anything
   * else no longer accruing charges. An upcoming or in-house stay is refused:
   * its nights are still to be charged, and closing would block them.
   *
   * **Only at exactly zero**, summed from the lines under the lock (never the
   * cached `paidAmountMinor`, section 3.4). Owing or in credit is the typed
   * `OutstandingBalanceError`. The lock is what makes "zero" true at the
   * moment of closing: every folio write takes the same reservation and folio
   * rows first, so no payment, charge or refund can land between the sum and
   * the close.
   *
   * Closing a closed folio is an idempotent success, not an error: the
   * caller's intent already holds, and `closedAt` is not moved.
   * ===========================================================================
   */
  async closeFolio(
    userId: string,
    hotelId: string,
    folioId: string,
    command: CloseFolioCommand,
  ): Promise<FolioPage> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);
    const folio = await this.prisma.client.folio.findFirst({
      where: { id: folioId, propertyId: property.id },
      select: {
        id: true,
        currency: true,
        reservationId: true,
        reservation: { select: { confirmationCode: true } },
      },
    });
    if (folio === null) throw new TenantScopeViolationError('Folio');

    await this.runFolioTransaction(async (tx) => {
      const status = await this.lockFolio(tx, property.id, folio);
      if (status === 'CLOSED') return;
      if (status !== 'OPEN') throw new FolioAlreadyClosedError(folio.id);

      const stay = await tx.reservation.findFirst({
        where: { id: folio.reservationId, propertyId: property.id },
        select: { status: true },
      });
      const stayStatus: string | null = stay?.status ?? null;
      if (stayStatus !== null && STAYS_STILL_ACCRUING.has(stayStatus)) {
        throw new ValidationFailedError({
          folioId:
            stayStatus === ReservationStatus.CHECKED_IN
              ? 'The guest is in house. The folio closes at check-out.'
              : 'This stay has not happened yet. Cancel it or mark it a no-show before closing its folio.',
        });
      }

      const balanceMinor =
        (
          await tx.folioLine.aggregate({
            where: { folioId: folio.id, propertyId: property.id },
            _sum: { amountMinor: true },
          })
        )._sum.amountMinor ?? 0;
      if (balanceMinor !== 0) {
        throw new OutstandingBalanceError(balanceMinor, folio.currency, 'close');
      }

      await tx.folio.updateMany({
        where: { id: folio.id, propertyId: property.id, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: this.clock.now() },
      });

      await this.writeAudit(tx, property.id, userId, folio.reservationId, 'FOLIO_CLOSED', {
        folioId: folio.id,
        balanceMinor,
        stayStatus,
        reason: command.reason,
      });
    });

    return this.byBookingCode(userId, hotelId, folio.reservation.confirmationCode);
  }

  /**
   * Every folio write runs here: the reservation row, then the folio row,
   * both FOR UPDATE, then a re-check that the folio is still open.
   *
   * ===========================================================================
   * The same order check-in, check-out and cancellation use (reservation
   * first, section 3.1.1), so a folio write and a stay operation queue rather
   * than deadlock. It is what lets FO-13 promise "closed at exactly zero": a
   * posting cannot commit between a close's balance read and its update, and
   * a posting that queued behind a close sees CLOSED here and is refused.
   *
   * The wait is bounded by the shared `ROW_LOCK_TIMEOUT_MS`, set locally
   * before the first blocking statement. `55P03` becomes the typed 409 and
   * is not retried: a folio write is never retried (a check-in posting has no
   * key, so a retry could double-post).
   * ===========================================================================
   */
  private async inFolioWrite(
    propertyId: string,
    folio: { id: string; reservationId: string },
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.runFolioTransaction(async (tx) => {
      const status = await this.lockFolio(tx, propertyId, folio);
      // Re-checked under the lock: the pre-flight `loadOpenFolio` may be stale.
      if (status !== 'OPEN') throw new FolioAlreadyClosedError(folio.id);
      await work(tx);
    });
  }

  private async runFolioTransaction(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    try {
      await this.prisma.client.$transaction(work);
    } catch (error) {
      if (isLockTimeout(error)) throw new TransactionConflictError('folio');
      throw error;
    }
  }

  /** Bounded wait, tenant stamp, reservation then folio FOR UPDATE; returns the folio status. */
  private async lockFolio(
    tx: Prisma.TransactionClient,
    propertyId: string,
    folio: { id: string; reservationId: string },
  ): Promise<string | null> {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
    await tx.$queryRaw`
      SELECT 1 FROM "reservation"
       WHERE "id" = ${folio.reservationId}::uuid AND "propertyId" = ${propertyId}::uuid
         FOR UPDATE`;
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS status FROM "folio"
       WHERE "id" = ${folio.id}::uuid AND "propertyId" = ${propertyId}::uuid
         FOR UPDATE`;
    return rows[0]?.status ?? null;
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Carry a room-charge correction onto the booking itself.
   *
   * The folio is the ledger, but the stay total, its tax and the per-night
   * tariff on the reservation are what the master report's total and balance,
   * the dashboards, the calendar and the performance figures read. Leaving
   * them at the original price made every one of those disagree with the
   * corrected folio. Applied in the same transaction as the folio lines, so
   * the two cannot drift if either write fails.
   *
   * Atomic increments, scoped by `propertyId` in the same predicate (3.2).
   * `taxAmountMinor` is moved only when the booking recorded one: a legacy
   * stay with 0 has its tax derived from the total, which now moves anyway.
   * Floors at 0 guard the non-negative CHECKs against a paisa of rounding on
   * a night corrected to nothing. A night without a `reservation_night` row
   * (a stay booked before F9) has nothing to update there.
   */
  private async applyRoomCorrectionToBooking(
    tx: Prisma.TransactionClient,
    propertyId: string,
    reservationId: string,
    chargeDate: Date,
    deltaNetMinor: number,
    deltaTaxMinor: number,
  ): Promise<void> {
    const deltaGrossMinor = deltaNetMinor + deltaTaxMinor;
    await tx.$executeRaw`
      UPDATE "reservation"
         SET "totalAmountMinor" = GREATEST(0, "totalAmountMinor" + ${deltaGrossMinor}::int),
             "taxAmountMinor" = CASE WHEN "taxAmountMinor" > 0
                                     THEN GREATEST(0, "taxAmountMinor" + ${deltaTaxMinor}::int)
                                     ELSE "taxAmountMinor" END
       WHERE "id" = ${reservationId}::uuid AND "propertyId" = ${propertyId}::uuid
    `;
    await tx.$executeRaw`
      UPDATE "reservation_night"
         SET "rateMinor" = GREATEST(0, "rateMinor" + ${deltaNetMinor}::int),
             "taxMinor" = GREATEST(0, "taxMinor" + ${deltaTaxMinor}::int),
             "rateSource" = 'MANUAL'
       WHERE "reservationId" = ${reservationId}::uuid
         AND "propertyId" = ${propertyId}::uuid
         AND "stayDate" = ${chargeDate}::date
    `;
  }

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
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
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

    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);

    if (!permissionsForRoles(roles).includes(required)) {
      throw new ForbiddenError(required);
    }

    return first.property;
  }
}

/**
 * Was this unique violation the payment idempotency index, and only that one?
 *
 * ===========================================================================
 * Named, never "any P2002 on this table".
 *
 * `folio_line` also carries `folio_line_one_room_charge_per_date`, the guard
 * that stops a night being charged twice. Swallowing that as "already
 * recorded" would turn the loudest possible double-charge bug into a silent
 * success, which is the exact failure a blanket catch produces (section 5
 * forbids swallowing an error).
 *
 * Prisma reports the index through `meta.target`, whose shape has moved
 * between versions and between the query engine and the driver adapters: it
 * may be the index name, an array of column names, or a comma-joined string.
 * All three are accepted, and nothing else is — an unrecognised shape
 * propagates as the original error rather than being guessed at. The payment
 * suite asserts which shape this build actually produces, so a Prisma upgrade
 * that changes it fails a test instead of quietly widening this predicate.
 * ===========================================================================
 */
export function isIdempotencyKeyCollision(cause: unknown): boolean {
  return uniqueViolationMentions(cause, ['folio_line_propertyId_idempotencyKey_key']);
}

/** The one-folio-per-reservation index, for the concurrent-opener case. */
export function isFolioPerReservationCollision(cause: unknown): boolean {
  return uniqueViolationMentions(cause, ['folio_reservationId_key']);
}

/** Kinds that add to what is owed, exported for the night audit to reuse. */
export const FOLIO_CHARGE_KINDS = CHARGE_KINDS;

/** Guards against an empty command reaching a posting path. */
export function assertPositive(amountMinor: number, field: string): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationFailedError({ [field]: 'Must be a positive integer in minor units.' });
  }
}
