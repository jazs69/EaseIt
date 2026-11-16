/**
 * Changing a stay's dates: amend, extend and shorten (RS-11, RS-12).
 *
 * ===========================================================================
 * A date change is a partial cancellation plus a partial booking, in one
 * transaction:
 *
 *   * nights that leave the stay are handed back to the room type's counter,
 *     with the same verification cancellation uses (one locked row per night,
 *     `sold` at least what the stay holds), because a release that runs on a
 *     counter that already disagrees silently invents a room;
 *   * nights that join the stay are sold under `inventory_day_not_oversold`,
 *     exactly as a new booking sells them, and an assigned room keeps its
 *     number only if `reservation_room_no_overlap` lets it.
 *
 * Lock order is the section 3.1.1 protocol: the reservation row first, scoped
 * by property, then `inventory_day` ascending by stay date and room type.
 *
 * Money: nights the stay keeps keep the price they were sold at (their
 * `reservation_night` rows are untouched). Added nights are priced like a new
 * booking's — the stay's rate plan without a promotion, the rack rate, or a
 * manual price — and taxed per night in their own GST band. The reservation
 * total moves by exactly the removed and added nights' rounded amounts, so it
 * stays the sum of its nights. A checked-in stay can never lose a night that
 * has already been charged to its folio.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Permission,
  ReservationStatus,
  type ChangeStayDatesCommand,
  type ChangeStayDatesPreview,
  type ChangeStayDatesResult,
  type NightRateSource,
  type PreviewPromotionRequest,
  type StayDateNight,
  type TaxSlab,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  DomainError,
  InventoryNotConfiguredError,
  RoomUnavailableError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import {
  isLockTimeout,
  isRetryableSqlState,
  ROW_LOCK_TIMEOUT_MS,
  sqlState,
} from '../../common/errors/sql-state.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PropertyTaxService } from '../properties/property-tax.service.js';
import { PromotionService } from '../rates/promotion.service.js';
import { RateCalendarService } from '../rates/rate-calendar.service.js';
import { quoteStay, stayDates, type QuoteInput } from './reservation-pricing.js';
import { dateChangeRule } from './reservation.state.js';

const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 3;

function toDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return toBusinessDate(new Date(toDate(date).getTime() + days * DAY_MS));
}

function gross(night: StayDateNight): number {
  return night.rateMinor + night.taxMinor;
}

/** Splits sorted dates into runs of consecutive days. */
function contiguousRuns(dates: readonly string[]): string[][] {
  const runs: string[][] = [];
  for (const date of dates) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run !== undefined && last !== undefined && addDays(last, 1) === date) run.push(date);
    else runs.push([date]);
  }
  return runs;
}

/** A night with the GST band it was taxed in, for writing its row. */
type PricedNight = StayDateNight & { taxRatePercent: number };

/** Everything the change was decided from, re-validated under the lock. */
interface Plan {
  propertyId: string;
  reservationId: string;
  bookingCode: string;
  status: ReservationStatus;
  currency: string;
  roomNumber: string | null;
  assignment: { id: string; roomId: string | null; roomTypeId: string };
  current: { arrivalDate: string; departureDate: string; totalMinor: number; taxMinor: number };
  proposed: { arrivalDate: string; departureDate: string; totalMinor: number; taxMinor: number };
  added: PricedNight[];
  removed: StayDateNight[];
  /** Nights kept with no `reservation_night` row (a stay booked before F9). */
  materialise: StayDateNight[];
}

@Injectable()
export class ChangeStayDatesService {
  private readonly logger = new Logger(ChangeStayDatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: PropertyTaxService,
    private readonly rates: RateCalendarService,
    private readonly promotions: PromotionService,
  ) {}

  /** What the change would do, committing nothing. Advisory (section 3.1). */
  async preview(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: ChangeStayDatesCommand,
  ): Promise<ChangeStayDatesPreview> {
    const plan = await this.plan(userId, hotelId, reservationId, command);
    return this.present(plan);
  }

  async change(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: ChangeStayDatesCommand,
  ): Promise<ChangeStayDatesResult> {
    const plan = await this.plan(userId, hotelId, reservationId, command);

    if (
      command.expectedTotalMinor !== undefined &&
      command.expectedTotalMinor !== plan.proposed.totalMinor
    ) {
      throw new ValidationFailedError({
        expectedTotalMinor:
          'The price for these dates has changed since it was shown. Review the new total and confirm again.',
      });
    }

    const changedAt = await this.withRetry(() => this.commit(userId, plan, command.reason));
    return { ...this.present(plan), changedAt: changedAt.toISOString() };
  }

  /* -------------------------------------------------------------------- */
  /*  Deciding                                                             */
  /* -------------------------------------------------------------------- */

  private async plan(
    userId: string,
    hotelId: string,
    reservationId: string,
    command: ChangeStayDatesCommand,
  ): Promise<Plan> {
    const property = await this.authorise(userId, hotelId);

    const stay = await this.prisma.client.reservation.findFirst({
      where: { id: reservationId, propertyId: property.id },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        arrivalDate: true,
        departureDate: true,
        adults: true,
        children: true,
        infants: true,
        ratePlanId: true,
        isTaxExempt: true,
        totalAmountMinor: true,
        taxAmountMinor: true,
        currency: true,
        rooms: {
          select: {
            id: true,
            roomId: true,
            roomTypeId: true,
            arrivalDate: true,
            departureDate: true,
            room: { select: { number: true } },
            roomType: {
              select: { baseRateMinor: true, currency: true, retiredAt: true },
            },
          },
        },
        pricedNights: {
          select: { stayDate: true, rateMinor: true, taxMinor: true, rateSource: true },
        },
      },
    });
    if (stay === null) throw new TenantScopeViolationError('Reservation');

    const status = stay.status as ReservationStatus;
    const rule = dateChangeRule(status);
    if (rule === 'REFUSED') {
      throw new ValidationFailedError({
        status: `The dates of a ${status.toLowerCase().replace(/_/g, ' ')} reservation cannot be changed.`,
      });
    }

    // One room row, matching the stay. A group booking prices its nights per
    // reservation, not per room, so changing one room's dates would leave the
    // stored prices ambiguous: refused until group amendments exist.
    const assignment = stay.rooms[0];
    if (assignment === undefined) {
      throw new ValidationFailedError({
        reservationId: 'This reservation has no room row, so its dates cannot be changed.',
      });
    }
    if (stay.rooms.length > 1) {
      throw new ValidationFailedError({
        reservationId:
          'This booking holds several rooms. Changing the dates of a multi-room booking is not supported yet.',
      });
    }

    const current = {
      arrivalDate: toBusinessDate(stay.arrivalDate),
      departureDate: toBusinessDate(stay.departureDate),
    };
    if (
      toBusinessDate(assignment.arrivalDate) !== current.arrivalDate ||
      toBusinessDate(assignment.departureDate) !== current.departureDate
    ) {
      throw new ValidationFailedError({
        reservationId: "This stay's room dates differ from the booking's, so it cannot be changed here.",
      });
    }

    const proposed = { arrivalDate: command.arrivalDate, departureDate: command.departureDate };
    const proposedDates = stayDates(proposed.arrivalDate, proposed.departureDate);
    if (proposedDates.length < 1) {
      throw new ValidationFailedError({
        departureDate: 'Check-out must be at least one night after check-in.',
      });
    }
    if (proposedDates.length > 365) {
      throw new ValidationFailedError({
        departureDate: 'A single reservation cannot exceed 365 nights.',
      });
    }
    if (
      proposed.arrivalDate === current.arrivalDate &&
      proposed.departureDate === current.departureDate
    ) {
      throw new ValidationFailedError({ departureDate: 'Those are already the dates of this stay.' });
    }

    const businessDate = toBusinessDate(property.businessDate);

    if (rule === 'ANY' && proposed.arrivalDate < businessDate) {
      throw new ValidationFailedError({
        arrivalDate: `Check-in cannot be before the business date (${businessDate}).`,
      });
    }

    if (rule === 'DEPARTURE_ONLY') {
      if (proposed.arrivalDate !== current.arrivalDate) {
        throw new ValidationFailedError({
          arrivalDate: 'The guest has already checked in, so only the check-out date can change.',
        });
      }
      if (proposed.departureDate < businessDate) {
        throw new ValidationFailedError({
          departureDate: `Check-out cannot be before the business date (${businessDate}).`,
        });
      }
      const lastCharged = await this.lastChargedNight(property.id, stay.id);
      if (lastCharged !== null && proposed.departureDate <= lastCharged) {
        throw new ValidationFailedError({
          departureDate: `The night of ${lastCharged} has already been charged, so check-out cannot be earlier than ${addDays(lastCharged, 1)}.`,
        });
      }
    }

    const currentDates = stayDates(current.arrivalDate, current.departureDate);
    const proposedSet = new Set(proposedDates);
    const currentSet = new Set(currentDates);
    const removedDates = currentDates.filter((date) => !proposedSet.has(date));
    const addedDates = proposedDates.filter((date) => !currentSet.has(date));
    const keptDates = currentDates.filter((date) => proposedSet.has(date));

    // The price of every current night: its stored row, or for a stay booked
    // before per-night pricing, the even split the folio already shows.
    const priced = this.currentNights(stay, currentDates);

    const removed = removedDates.map((date) => this.nightAt(priced.nights, date));
    const materialise = priced.stored
      ? []
      : keptDates.map((date) => this.nightAt(priced.nights, date));

    if (addedDates.length > 0 && assignment.roomType.retiredAt !== null) {
      throw new ValidationFailedError({
        departureDate: 'This room type has been retired, so no nights can be added to it.',
      });
    }

    const added =
      addedDates.length === 0
        ? []
        : await this.priceAdded(
            property,
            {
              ratePlanId: stay.ratePlanId,
              isTaxExempt: stay.isTaxExempt,
              adults: stay.adults,
              children: stay.children,
              infants: stay.infants,
            },
            {
              id: assignment.roomTypeId,
              baseRateMinor: assignment.roomType.baseRateMinor,
              currency: assignment.roomType.currency,
            },
            addedDates,
            command.overrideNightlyRateMinor,
          );

    // A readable answer before the transaction for the common clash; the
    // exclusion constraint is what makes it true under concurrency.
    if (assignment.roomId !== null && addedDates.length > 0) {
      const clash = await this.prisma.client.reservationRoom.findFirst({
        where: {
          propertyId: property.id,
          roomId: assignment.roomId,
          status: { notIn: [ReservationStatus.CANCELLED, ReservationStatus.NO_SHOW] },
          arrivalDate: { lt: toDate(proposed.departureDate) },
          departureDate: { gt: toDate(proposed.arrivalDate) },
          NOT: { id: assignment.id },
        },
        select: { id: true },
      });
      if (clash !== null) {
        throw new RoomUnavailableError({
          reason: `${assignment.room === null ? 'The room' : `Room ${assignment.room.number}`} is booked by another stay on some of the new nights. Move this stay to another room or unassign it first.`,
        });
      }
    }

    const removedGross = removed.reduce((sum, night) => sum + gross(night), 0);
    const removedTax = removed.reduce((sum, night) => sum + night.taxMinor, 0);
    const addedGross = added.reduce((sum, night) => sum + gross(night), 0);
    const addedTax = added.reduce((sum, night) => sum + night.taxMinor, 0);

    return {
      propertyId: property.id,
      reservationId: stay.id,
      bookingCode: stay.confirmationCode,
      status,
      currency: stay.currency,
      roomNumber: assignment.room?.number ?? null,
      assignment: {
        id: assignment.id,
        roomId: assignment.roomId,
        roomTypeId: assignment.roomTypeId,
      },
      current: {
        ...current,
        totalMinor: stay.totalAmountMinor,
        taxMinor: stay.taxAmountMinor,
      },
      proposed: {
        ...proposed,
        totalMinor: Math.max(0, stay.totalAmountMinor - removedGross + addedGross),
        taxMinor: Math.max(0, stay.taxAmountMinor - removedTax + addedTax),
      },
      added,
      removed,
      materialise,
    };
  }

  /**
   * The current nights' prices, and whether they came from stored rows.
   *
   * A stay booked before F9 has no `reservation_night` rows, and the folio
   * shows its nights as an even split of the total with the remainder on the
   * first night. That same split is used here and written as rows for the
   * nights the stay keeps, so the total remains the sum of its nights. A stay
   * with rows for only some nights is refused: guessing the missing ones would
   * be inventing a price.
   */
  private currentNights(
    stay: {
      totalAmountMinor: number;
      taxAmountMinor: number;
      pricedNights: { stayDate: Date; rateMinor: number; taxMinor: number; rateSource: string }[];
    },
    dates: readonly string[],
  ): { stored: boolean; nights: Map<string, StayDateNight> } {
    const stored = new Map(
      stay.pricedNights.map((night) => [
        toBusinessDate(night.stayDate),
        {
          stayDate: toBusinessDate(night.stayDate) as StayDateNight['stayDate'],
          rateMinor: night.rateMinor,
          taxMinor: night.taxMinor,
          rateSource: night.rateSource as NightRateSource,
        },
      ]),
    );

    if (stored.size > 0) {
      if (!dates.every((date) => stored.has(date))) {
        throw new ValidationFailedError({
          reservationId:
            "Some of this stay's nights have no stored price, so its dates cannot be changed safely.",
        });
      }
      return { stored: true, nights: stored };
    }

    const count = dates.length;
    const nightlyGross = Math.floor(stay.totalAmountMinor / count);
    const nightlyTax = Math.floor(stay.taxAmountMinor / count);
    const grossRemainder = stay.totalAmountMinor - nightlyGross * count;
    const taxRemainder = stay.taxAmountMinor - nightlyTax * count;

    const nights = new Map<string, StayDateNight>();
    dates.forEach((date, index) => {
      const grossMinor = nightlyGross + (index === 0 ? grossRemainder : 0);
      const taxMinor = nightlyTax + (index === 0 ? taxRemainder : 0);
      nights.set(date, {
        stayDate: date as StayDateNight['stayDate'],
        rateMinor: Math.max(0, grossMinor - taxMinor),
        taxMinor,
        rateSource: 'MANUAL',
      });
    });
    return { stored: false, nights };
  }

  private nightAt(nights: Map<string, StayDateNight>, date: string): StayDateNight {
    const night = nights.get(date);
    if (night === undefined) throw new Error(`No price for ${date}.`);
    return night;
  }

  /**
   * Prices the nights joining the stay, one contiguous run at a time.
   *
   * A move can add nights at both ends; each run is quoted as its own stay so
   * a rate plan is asked only about the nights being sold. A promotion is not
   * re-applied: it was redeemed against the original stay, and extending a
   * stay is not a new booking that earns one.
   */
  private async priceAdded(
    property: { id: string; businessDate: Date; taxRatePercent: Prisma.Decimal | null },
    stay: {
      ratePlanId: string | null;
      isTaxExempt: boolean;
      adults: number;
      children: number;
      infants: number;
    },
    roomType: { id: string; baseRateMinor: number; currency: string },
    dates: readonly string[],
    overrideNightlyRateMinor: number | undefined,
  ): Promise<PricedNight[]> {
    const taxSlabs: TaxSlab[] = await this.tax.slabsFor(
      property.id,
      property.taxRatePercent === null ? null : Number(property.taxRatePercent),
    );

    const nights: PricedNight[] = [];
    for (const run of contiguousRuns(dates)) {
      const first = run[0];
      const last = run.at(-1);
      if (first === undefined || last === undefined) continue;
      const arrivalDate = first;
      const departureDate = addDays(last, 1);

      const plan =
        overrideNightlyRateMinor === undefined && stay.ratePlanId !== null
          ? await this.planNights(property, stay, stay.ratePlanId, roomType, run, arrivalDate, departureDate)
          : undefined;

      const quote = quoteStay({
        arrivalDate,
        departureDate,
        baseNightlyRateMinor: roomType.baseRateMinor,
        plan,
        overrideNightlyRateMinor,
        isTaxExempt: stay.isTaxExempt,
        currency: roomType.currency,
        taxSlabs,
      });

      for (const line of quote.nightly) {
        nights.push({
          stayDate: line.stayDate,
          rateMinor: line.nightlyRateMinor,
          taxMinor: line.taxMinor,
          rateSource: line.rateSource,
          taxRatePercent: line.taxRatePercent,
        });
      }
    }
    return nights;
  }

  private async planNights(
    property: { id: string; businessDate: Date },
    stay: { adults: number; children: number; infants: number },
    ratePlanId: string,
    roomType: { id: string; currency: string },
    run: readonly string[],
    arrivalDate: string,
    departureDate: string,
  ): Promise<QuoteInput['plan']> {
    const resolved = await this.rates.resolveStay(
      property.id,
      ratePlanId,
      roomType.id,
      roomType.currency,
      run,
    );

    // Brand casts are safe: the dates were validated at the boundary or
    // derived from them, and the business date is a @db.Date column.
    const priced = await this.promotions.priceStay(property.id, {
      ratePlanId: resolved.ratePlanId,
      roomTypeId: roomType.id,
      arrivalDate: arrivalDate as PreviewPromotionRequest['arrivalDate'],
      departureDate: departureDate as PreviewPromotionRequest['departureDate'],
      bookingDate: toBusinessDate(property.businessDate) as PreviewPromotionRequest['bookingDate'],
      adults: stay.adults,
      children: stay.children,
      infants: stay.infants,
      promoCode: null,
    });

    if (priced.occupancyRefusals.length > 0) {
      throw new ValidationFailedError(
        Object.fromEntries(
          priced.occupancyRefusals.map((refusal) => [refusal.field ?? 'adults', refusal.message]),
        ),
      );
    }

    return {
      ratePlanId: resolved.ratePlanId,
      ratePlanCode: resolved.ratePlanCode,
      nights: resolved.nights.map((night, index) => {
        const line = priced.perNight[index];
        if (line === undefined || line.stayDate !== night.stayDate) {
          throw new Error('Promotion pricing and the stay dates disagree.');
        }
        return {
          stayDate: night.stayDate,
          // Base + extra guests, with any automatic discount put back.
          rateMinor: line.finalNightlyMinor + line.discountMinor,
          source: night.source,
          extraGuestMinor: line.adultExtraChargeMinor + line.childExtraChargeMinor,
          discountMinor: 0,
        };
      }),
      promotion: null,
    };
  }

  /** The latest night already charged to the stay's folio, or null. */
  private async lastChargedNight(propertyId: string, reservationId: string): Promise<string | null> {
    const line = await this.prisma.client.folioLine.findFirst({
      where: {
        propertyId,
        folio: { reservationId },
        kind: 'ROOM_CHARGE',
        reversesLineId: null,
      },
      orderBy: { chargeDate: 'desc' },
      select: { chargeDate: true },
    });
    return line === null ? null : toBusinessDate(line.chargeDate);
  }

  /* -------------------------------------------------------------------- */
  /*  The transaction                                                      */
  /* -------------------------------------------------------------------- */

  private async commit(userId: string, plan: Plan, reason: string | null): Promise<Date> {
    const { propertyId } = plan;

    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
        // Bounded wait before the first blocking statement; 55P03 -> 409, unretried.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;

        // 1. The reservation row, scoped by property in the same predicate.
        const locked = await tx.$queryRaw<
          {
            status: string;
            arrival_date: Date;
            departure_date: Date;
            total_amount_minor: number;
            tax_amount_minor: number;
          }[]
        >`
          SELECT "status"::text AS status, "arrivalDate" AS arrival_date,
                 "departureDate" AS departure_date,
                 "totalAmountMinor" AS total_amount_minor, "taxAmountMinor" AS tax_amount_minor
            FROM reservation
           WHERE "id" = ${plan.reservationId}::uuid AND "propertyId" = ${propertyId}::uuid
             FOR UPDATE`;
        const stay = locked[0];
        if (stay === undefined) throw new TenantScopeViolationError('Reservation');

        // 2. Every fact the plan relied on, re-read under the lock. A changed
        // fact refuses the change rather than re-deciding it: the clerk agreed
        // these nights at this price for the stay as it was.
        if (stay.status !== plan.status) {
          throw new ValidationFailedError({
            status: `This reservation is now ${stay.status.toLowerCase().replace(/_/g, ' ')}; review it and try again.`,
          });
        }
        if (
          toBusinessDate(stay.arrival_date) !== plan.current.arrivalDate ||
          toBusinessDate(stay.departure_date) !== plan.current.departureDate ||
          stay.total_amount_minor !== plan.current.totalMinor ||
          stay.tax_amount_minor !== plan.current.taxMinor
        ) {
          throw new ValidationFailedError({
            departureDate:
              'This stay was changed by someone else a moment ago. Review it and try again.',
          });
        }

        const rooms = await tx.$queryRaw<{ id: string; room_type_id: string; room_id: string | null }[]>`
          SELECT "id", "roomTypeId" AS room_type_id, "roomId" AS room_id
            FROM reservation_room
           WHERE "reservationId" = ${plan.reservationId}::uuid AND "propertyId" = ${propertyId}::uuid`;
        const room = rooms[0];
        if (
          rooms.length !== 1 ||
          room === undefined ||
          room.id !== plan.assignment.id ||
          room.room_type_id !== plan.assignment.roomTypeId ||
          room.room_id !== plan.assignment.roomId
        ) {
          throw new ValidationFailedError({
            roomId: 'This stay was moved by someone else a moment ago. Review where it is now and try again.',
          });
        }

        // A night charged since the plan was made cannot be removed. Every
        // poster of room charges takes the reservation row first, so this read
        // is stable while the lock is held.
        if (plan.status === ReservationStatus.CHECKED_IN && plan.removed.length > 0) {
          const charged = await tx.folioLine.findFirst({
            where: {
              propertyId,
              folio: { reservationId: plan.reservationId },
              kind: 'ROOM_CHARGE',
              reversesLineId: null,
              chargeDate: { in: plan.removed.map((night) => toDate(night.stayDate)) },
            },
            select: { chargeDate: true },
          });
          if (charged !== null) {
            throw new ValidationFailedError({
              departureDate: `The night of ${toBusinessDate(charged.chargeDate)} has already been charged, so it cannot be removed.`,
            });
          }
        }

        // 3. inventory_day, ascending stay date then room type (section 3.1.1).
        const removedDates = plan.removed.map((night) => toDate(night.stayDate));
        const addedDates = plan.added.map((night) => toDate(night.stayDate));
        const touched = [...removedDates, ...addedDates];
        const roomTypeId = plan.assignment.roomTypeId;

        if (touched.length > 0) {
          const counters = await tx.$queryRaw<{ stay_date: Date; sold: number; sellable: number }[]>`
            SELECT "stayDate" AS stay_date, "sold",
                   ("physical" + "overbookingAllowance" - "sold" - "blocked") AS sellable
              FROM inventory_day
             WHERE "propertyId" = ${propertyId}::uuid
               AND "roomTypeId" = ${roomTypeId}::uuid
               AND "stayDate" IN (${Prisma.join(touched)})
             ORDER BY "stayDate" ASC, "roomTypeId" ASC
               FOR UPDATE`;
          const byDate = new Map(counters.map((row) => [toBusinessDate(row.stay_date), row]));

          // Releasing: one row per night, and enough sold to give back. Either
          // mismatch means counters and bookings already disagree, and the
          // whole change is refused rather than half-applied.
          for (const night of plan.removed) {
            const row = byDate.get(night.stayDate);
            if (row === undefined || row.sold < 1) {
              throw new ValidationFailedError({
                reservationId: `The inventory for ${night.stayDate} does not match this booking, so the change was not applied. Ask an administrator to check the calendar.`,
              });
            }
          }

          // Selling: the calendar must extend that far, and have a room left.
          const missing = plan.added.filter((night) => !byDate.has(night.stayDate));
          if (missing.length > 0) {
            throw new InventoryNotConfiguredError({
              nightsRequested: plan.added.length,
              nightsConfigured: plan.added.length - missing.length,
              firstNight: missing[0]?.stayDate,
              lastNight: missing.at(-1)?.stayDate,
            });
          }
          const soldOut = plan.added.find((night) => (byDate.get(night.stayDate)?.sellable ?? 0) < 1);
          if (soldOut !== undefined) {
            throw new RoomUnavailableError({
              reason: 'No rooms of this type remain on one of the new nights.',
              stayDate: soldOut.stayDate,
            });
          }

          if (removedDates.length > 0) {
            const released = await tx.inventoryDay.updateMany({
              where: { propertyId, roomTypeId, stayDate: { in: removedDates }, sold: { gt: 0 } },
              data: { sold: { decrement: 1 } },
            });
            if (released.count !== removedDates.length) {
              throw new Error('Released a different number of nights than were removed.');
            }
          }
          if (addedDates.length > 0) {
            // The CHECK is the guarantee: a concurrent sale of the last room
            // makes this raise 23514 and the whole change roll back.
            await tx.inventoryDay.updateMany({
              where: { propertyId, roomTypeId, stayDate: { in: addedDates } },
              data: { sold: { increment: 1 } },
            });
          }
        }

        // 4. The room row; `reservation_room_no_overlap` refuses a clash (23P01).
        await tx.reservationRoom.update({
          where: { id: plan.assignment.id },
          data: {
            arrivalDate: toDate(plan.proposed.arrivalDate),
            departureDate: toDate(plan.proposed.departureDate),
          },
        });

        // 5. Night prices: removed nights go, added nights are written once.
        if (removedDates.length > 0) {
          await tx.reservationNight.deleteMany({
            where: { propertyId, reservationId: plan.reservationId, stayDate: { in: removedDates } },
          });
        }
        const toWrite: PricedNight[] = [
          // A pre-F9 night's band is implied by its split; informational only.
          ...plan.materialise.map((night) => ({
            ...night,
            taxRatePercent:
              night.rateMinor === 0 ? 0 : Math.round((night.taxMinor * 10_000) / night.rateMinor) / 100,
          })),
          ...plan.added,
        ];
        if (toWrite.length > 0) {
          await tx.reservationNight.createMany({
            data: toWrite.map((night) => ({
              propertyId,
              reservationId: plan.reservationId,
              stayDate: toDate(night.stayDate),
              rateMinor: night.rateMinor,
              taxMinor: night.taxMinor,
              // A tax RATE, not money: Decimal is permitted (section 3.4).
              taxRatePercent: new Prisma.Decimal(night.taxRatePercent),
              currency: plan.currency,
              rateSource: night.rateSource,
            })),
          });
        }

        // 6. The reservation itself.
        await tx.reservation.update({
          where: { id: plan.reservationId },
          data: {
            arrivalDate: toDate(plan.proposed.arrivalDate),
            departureDate: toDate(plan.proposed.departureDate),
            totalAmountMinor: plan.proposed.totalMinor,
            taxAmountMinor: plan.proposed.taxMinor,
          },
        });

        const changedAt = new Date();

        // In the same transaction as the change it records (section 3.4).
        await tx.auditLog.create({
          data: {
            propertyId,
            actorUserId: userId,
            event: 'RESERVATION_DATES_CHANGED',
            entityType: 'reservation',
            entityId: plan.reservationId,
            before: plan.current,
            after: {
              ...plan.proposed,
              nightsAdded: plan.added.map((night) => night.stayDate),
              nightsRemoved: plan.removed.map((night) => night.stayDate),
            },
            reason,
          },
        });

        this.logger.log(
          `Reservation ${plan.bookingCode} dates changed; +${String(plan.added.length)} / -${String(plan.removed.length)} night(s).`,
        );
        return changedAt;
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Retries the genuinely retryable, then gives a clean answer (section 3.1.1).
   */
  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    let last: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        // A typed refusal is the answer; rethrown before any SQLSTATE reading.
        if (error instanceof DomainError) throw error;
        if (isLockTimeout(error)) throw new TransactionConflictError('date change');
        if (!isRetryableSqlState(error)) throw error;

        last = error;
        this.logger.warn(
          `Date change attempt ${String(attempt)} hit SQLSTATE ${String(sqlState(error))}; retrying.`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 50));
        }
      }
    }

    const lastState = last === null ? null : sqlState(last);
    if (lastState === '40001' || lastState === '40P01') {
      throw new TransactionConflictError('date change');
    }
    throw new RoomUnavailableError({
      reason:
        lastState === '23514'
          ? 'No rooms of this type remain on one of the new nights.'
          : 'The room was taken for some of the new nights while the change was being made.',
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  private present(plan: Plan): ChangeStayDatesPreview {
    const span = (side: Plan['current']) => ({
      arrivalDate: side.arrivalDate as ChangeStayDatesPreview['current']['arrivalDate'],
      departureDate: side.departureDate as ChangeStayDatesPreview['current']['departureDate'],
      nights: stayDates(side.arrivalDate, side.departureDate).length,
      totalMinor: side.totalMinor,
      taxMinor: side.taxMinor,
    });
    return {
      reservationId: plan.reservationId,
      bookingCode: plan.bookingCode,
      status: plan.status,
      currency: plan.currency,
      roomNumber: plan.roomNumber,
      current: span(plan.current),
      proposed: span(plan.proposed),
      addedNights: plan.added.map(({ taxRatePercent: _rate, ...night }) => night),
      removedNights: plan.removed,
      deltaMinor: plan.proposed.totalMinor - plan.current.totalMinor,
    };
  }

  private async authorise(
    userId: string,
    codeOrId: string,
  ): Promise<{ id: string; businessDate: Date; taxRatePercent: Prisma.Decimal | null }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, businessDate: true, taxRatePercent: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    requirePermissionFromGrants(grants, Permission.RESERVATIONS_EDIT);
    return first.property;
  }
}
