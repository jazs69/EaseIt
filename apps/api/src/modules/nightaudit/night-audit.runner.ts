/**
 * Executes one night-audit run (CLAUDE.md section 3.3; NA-02, NA-04 .. NA-06).
 *
 * ===========================================================================
 * Only ever called by the worker, through the NIGHT_AUDIT_RUN outbox handler.
 * The API enqueues; it never calls this (section 3.3: a user action can only
 * enqueue a run and poll it).
 *
 * **Steps in order, each committed on its own.** A step's row is written in
 * the same transaction as the step's effect where the step is one
 * transaction (1, 4, 6, 7, 8). Steps that act per stay (2, 3, 5) commit each
 * stay separately -- every one idempotent on its own -- and then write the
 * step row. Either way the row exists only once the step's work is durable.
 *
 * **Resumable and idempotent.** A run starts at its first step without a
 * COMPLETED row. A COMPLETED run is a no-op. Two executors racing the same
 * run serialise on the run row (`FOR UPDATE`) inside each step transaction
 * and re-check the step row under that lock, so a step cannot run twice; the
 * per-stay work underneath is idempotent by construction (a no-show is a
 * no-op on a NO_SHOW stay, a night is not posted twice for a date, a closed
 * folio stays closed).
 *
 * **Locks.** Run row first in a step transaction; per-stay work takes the
 * reservation row then the folio row, the same order as every stay and folio
 * operation (section 3.1.1). Every transaction bounds its lock wait with the
 * shared `ROW_LOCK_TIMEOUT_MS`.
 *
 * **Money.** Integer minor units throughout; nights are priced from
 * `reservation_night` exactly as check-in prices the arrival night, never
 * re-priced from today's rates (section 3.4).
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import { addDays, NIGHT_AUDIT_STEPS, ReservationStatus, type BusinessDate } from '@repo/types';
import { Prisma } from '@repo/database';

import { DomainError, NightAuditBlockedError } from '../../common/errors/domain-error.js';
import { ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { OutboxService } from '../platform/outbox/outbox.service.js';
import { CancelReservationService } from '../reservations/cancel-reservation.service.js';

type Tx = Prisma.TransactionClient;
type Outcome = Record<string, unknown>;

interface RunRef {
  id: string;
  propertyId: string;
  /** "YYYY-MM-DD", the day this run closes. */
  businessDate: BusinessDate;
}

const DAY_MS = 86_400_000;

function toDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function iso(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

/** Stays that never arrived and can still be rolled (the no-show sources). */
const UNARRIVED = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.TENTATIVE,
  ReservationStatus.ON_HOLD,
] as const;

/** Stays whose folio no longer accrues charges (step 5). */
const ENDED = [
  ReservationStatus.CHECKED_OUT,
  ReservationStatus.CANCELLED,
  ReservationStatus.NO_SHOW,
] as const;

@Injectable()
export class NightAuditRunner {
  private readonly logger = new Logger(NightAuditRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly cancellations: CancelReservationService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Run (or resume) a run to completion. Returns the final status. Throws the
   * step's error after recording it, so the caller (the outbox handler) can
   * decide whether a retry is worthwhile.
   */
  async execute(runId: string): Promise<'COMPLETED' | 'FAILED'> {
    const found = await this.prisma.client.nightAuditRun.findUnique({
      where: { id: runId },
      select: { id: true, propertyId: true, businessDate: true, status: true },
    });
    if (found === null) throw new NightAuditBlockedError('The night-audit run no longer exists.');
    if (found.status === 'COMPLETED') return 'COMPLETED';

    const run: RunRef = {
      id: found.id,
      propertyId: found.propertyId,
      businessDate: iso(found.businessDate),
    };

    await this.prisma.client.nightAuditRun.updateMany({
      where: { id: run.id, propertyId: run.propertyId, status: { not: 'COMPLETED' } },
      data: { status: 'RUNNING', lastError: null },
    });
    await this.prisma.client.nightAuditRun.updateMany({
      where: { id: run.id, propertyId: run.propertyId, startedAt: null },
      data: { startedAt: this.clock.now() },
    });

    for (const definition of NIGHT_AUDIT_STEPS) {
      if (await this.isStepCompleted(run, definition.step)) continue;
      const startedAt = this.clock.now();
      try {
        await this.runStep(run, definition.step, startedAt);
      } catch (error) {
        await this.recordFailure(run, definition.step, startedAt, error);
        throw error;
      }
    }

    await this.prisma.client.nightAuditRun.updateMany({
      where: { id: run.id, propertyId: run.propertyId, status: { not: 'COMPLETED' } },
      data: { status: 'COMPLETED', completedAt: this.clock.now(), lastError: null },
    });
    this.logger.log(`Night audit ${run.businessDate} completed for property ${run.propertyId}.`);
    return 'COMPLETED';
  }

  /* -------------------------------------------------------------------- */
  /*  Step dispatch                                                        */
  /* -------------------------------------------------------------------- */

  private async runStep(run: RunRef, step: number, startedAt: Date): Promise<void> {
    switch (step) {
      case 1:
        return this.inStepTransaction(run, step, startedAt, (tx) => this.validatePreconditions(tx, run));
      case 2: {
        const outcome = await this.rollNoShows(run);
        return this.inStepTransaction(run, step, startedAt, () => Promise.resolve(outcome));
      }
      case 3: {
        const outcome = await this.postRoomCharges(run);
        return this.inStepTransaction(run, step, startedAt, () => Promise.resolve(outcome));
      }
      case 4:
        return this.inStepTransaction(run, step, startedAt, () =>
          Promise.resolve({
            posted: 0,
            note: 'No recurring or scheduled charges exist in the product yet, so none were posted.',
          }),
        );
      case 5: {
        const outcome = await this.settleFolios(run);
        return this.inStepTransaction(run, step, startedAt, () => Promise.resolve(outcome));
      }
      case 6:
        return this.inStepTransaction(run, step, startedAt, (tx) => this.snapshot(tx, run));
      case 7:
        return this.inStepTransaction(run, step, startedAt, (tx) => this.advanceBusinessDate(tx, run));
      case 8:
        return this.inStepTransaction(run, step, startedAt, (tx) => this.emit(tx, run));
      default:
        throw new NightAuditBlockedError(`Unknown night-audit step ${String(step)}.`);
    }
  }

  /**
   * The step's own transaction: run row locked, the step re-checked under the
   * lock (another executor may have just finished it), the work done, and the
   * step row written -- all or nothing.
   */
  private async inStepTransaction(
    run: RunRef,
    step: number,
    startedAt: Date,
    work: (tx: Tx) => Promise<Outcome>,
  ): Promise<void> {
    await this.prisma.client.$transaction(
      async (tx) => {
        await this.lockRun(tx, run);
        const existing = await tx.nightAuditStep.findUnique({
          where: { night_audit_step_one_per_run: { propertyId: run.propertyId, runId: run.id, step } },
          select: { status: true },
        });
        if (existing?.status === 'COMPLETED') return;

        const outcome = await work(tx);
        await this.writeStep(tx, run, step, 'COMPLETED', outcome, startedAt);
      },
      { timeout: 30_000, isolationLevel: 'ReadCommitted' },
    );
  }

  private async lockRun(tx: Tx, run: RunRef): Promise<void> {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_property_id', ${run.propertyId}, true)`;
    await tx.$queryRaw`
      SELECT 1 FROM "night_audit_run"
       WHERE "id" = ${run.id}::uuid AND "propertyId" = ${run.propertyId}::uuid
         FOR UPDATE`;
  }

  private async writeStep(
    tx: Tx,
    run: RunRef,
    step: number,
    status: 'COMPLETED' | 'FAILED',
    outcome: Outcome,
    startedAt: Date,
  ): Promise<void> {
    const definition = NIGHT_AUDIT_STEPS.find((entry) => entry.step === step);
    const data = {
      status,
      outcome: outcome as Prisma.InputJsonValue,
      startedAt,
      finishedAt: this.clock.now(),
    };
    await tx.nightAuditStep.upsert({
      where: { night_audit_step_one_per_run: { propertyId: run.propertyId, runId: run.id, step } },
      create: {
        propertyId: run.propertyId,
        runId: run.id,
        step,
        name: definition?.name ?? `STEP_${String(step)}`,
        ...data,
      },
      update: data,
    });
  }

  private async isStepCompleted(run: RunRef, step: number): Promise<boolean> {
    const row = await this.prisma.client.nightAuditStep.findUnique({
      where: { night_audit_step_one_per_run: { propertyId: run.propertyId, runId: run.id, step } },
      select: { status: true },
    });
    return row?.status === 'COMPLETED';
  }

  /**
   * The step's failure, recorded for the screen. A typed DomainError's message
   * is safe to show; anything else is summarised -- SQL and driver text never
   * reach a client (section 5), and the full error is in the worker log.
   */
  private async recordFailure(run: RunRef, step: number, startedAt: Date, error: unknown): Promise<void> {
    const message =
      error instanceof DomainError
        ? error.message
        : `Step ${String(step)} failed unexpectedly; see the worker log. It will be retried.`;
    const details = error instanceof DomainError ? (error.details ?? {}) : {};
    this.logger.error(`Night audit ${run.businessDate} step ${String(step)} failed: ${String(error)}`);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${run.propertyId}, true)`;
      await this.writeStep(tx, run, step, 'FAILED', { error: message, ...details }, startedAt);
      await tx.nightAuditRun.updateMany({
        where: { id: run.id, propertyId: run.propertyId, status: { not: 'COMPLETED' } },
        data: { status: 'FAILED', lastError: `Step ${String(step)}: ${message}` },
      });
    });
  }

  /* -------------------------------------------------------------------- */
  /*  1. Preconditions                                                     */
  /* -------------------------------------------------------------------- */

  private async validatePreconditions(tx: Tx, run: RunRef): Promise<Outcome> {
    const property = await tx.property.findFirst({
      where: { id: run.propertyId },
      select: { businessDate: true },
    });
    if (property === null) throw new NightAuditBlockedError('The property no longer exists.');
    const current = iso(property.businessDate);
    if (current !== run.businessDate) {
      throw new NightAuditBlockedError(
        `The property's business date is ${current}, not ${run.businessDate}; this run is stale.`,
        { businessDate: current, runBusinessDate: run.businessDate },
      );
    }

    // An in-house stay with no room cannot be charged to a room or reported
    // as occupying one. The audit stops rather than guessing.
    const inHouse = await tx.reservation.findMany({
      where: { propertyId: run.propertyId, status: ReservationStatus.CHECKED_IN },
      select: { confirmationCode: true, rooms: { select: { roomId: true } } },
    });
    const unassigned = inHouse
      .filter((stay) => stay.rooms.length === 0 || stay.rooms.some((room) => room.roomId === null))
      .map((stay) => stay.confirmationCode);
    if (unassigned.length > 0) {
      throw new NightAuditBlockedError(
        `${String(unassigned.length)} in-house stay(s) have no room assigned. Assign a room, then run the audit again.`,
        { unassignedInHouse: unassigned },
      );
    }

    return {
      businessDate: run.businessDate,
      inHouse: inHouse.length,
      cashierShifts: 'Not applicable: the product has no cashier shifts yet.',
    };
  }

  /* -------------------------------------------------------------------- */
  /*  2. No-shows                                                          */
  /* -------------------------------------------------------------------- */

  /**
   * Every stay due on or before the business date that never arrived becomes
   * a no-show, through the same transaction a clerk's "Mark no-show" runs
   * (RS-13): reservation row locked, nights released from the live room rows,
   * refused when counters disagree. Already-NO_SHOW is a no-op, so a resumed
   * step does not release anything twice. A refusal stops the step.
   */
  private async rollNoShows(run: RunRef): Promise<Outcome> {
    const due = await this.prisma.client.reservation.findMany({
      where: {
        propertyId: run.propertyId,
        status: { in: [...UNARRIVED] },
        arrivalDate: { lte: toDate(run.businessDate) },
      },
      select: { id: true, confirmationCode: true },
      orderBy: { arrivalDate: 'asc' },
    });

    let rolled = 0;
    let nightsReleased = 0;
    const codes: string[] = [];
    for (const stay of due) {
      const result = await this.cancellations.markNoShowAsSystem(
        run.propertyId,
        stay.id,
        `Night audit ${run.businessDate}: the guest did not arrive.`,
      );
      if (!result.alreadyNoShow) {
        rolled += 1;
        nightsReleased += result.nightsReleased;
        codes.push(stay.confirmationCode);
      }
    }
    return { rolled, nightsReleased, reservations: codes };
  }

  /* -------------------------------------------------------------------- */
  /*  3. Room charges                                                      */
  /* -------------------------------------------------------------------- */

  /**
   * Tonight's room charge and its tax, for every stay in house tonight.
   *
   * In house tonight: CHECKED_IN with arrival <= business date < departure.
   * The arrival night was already posted by check-in, and a night is never
   * posted twice (checked under the locks, and backstopped by
   * `folio_line_one_room_charge_per_date`). A CHECKED_IN stay past its
   * departure date is an overstay: reported, not charged -- what to charge an
   * overstay is a policy this product has not decided.
   */
  private async postRoomCharges(run: RunRef): Promise<Outcome> {
    const night = toDate(run.businessDate);
    const inHouse = await this.prisma.client.reservation.findMany({
      where: {
        propertyId: run.propertyId,
        status: ReservationStatus.CHECKED_IN,
        arrivalDate: { lte: night },
      },
      select: { id: true, confirmationCode: true, departureDate: true },
      orderBy: { arrivalDate: 'asc' },
    });

    let posted = 0;
    let alreadyPosted = 0;
    let roomMinor = 0;
    let taxMinor = 0;
    const overstays: string[] = [];
    for (const stay of inHouse) {
      if (stay.departureDate.getTime() <= night.getTime()) {
        overstays.push(stay.confirmationCode);
        continue;
      }
      const result = await this.postNight(run, stay.id);
      if (result === null) {
        alreadyPosted += 1;
      } else {
        posted += 1;
        roomMinor += result.roomMinor;
        taxMinor += result.taxMinor;
      }
    }
    return { posted, alreadyPosted, postedRoomMinor: roomMinor, postedTaxMinor: taxMinor, overstays };
  }

  /** One stay's night, in its own transaction. Null when already posted. */
  private async postNight(
    run: RunRef,
    reservationId: string,
  ): Promise<{ roomMinor: number; taxMinor: number } | null> {
    const night = toDate(run.businessDate);
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${run.propertyId}, true)`;

        // Reservation row first, scoped by property (section 3.1.1), then
        // everything re-read under it.
        const locked = await tx.$queryRaw<
          {
            status: string;
            arrival_date: Date;
            departure_date: Date;
            total_amount_minor: number;
            tax_amount_minor: number;
            currency: string;
          }[]
        >`
          SELECT "status"::text AS status, "arrivalDate" AS arrival_date,
                 "departureDate" AS departure_date, "totalAmountMinor" AS total_amount_minor,
                 "taxAmountMinor" AS tax_amount_minor, "currency"
            FROM "reservation"
           WHERE "id" = ${reservationId}::uuid AND "propertyId" = ${run.propertyId}::uuid
             FOR UPDATE`;
        const stay = locked[0];
        if (
          stay === undefined ||
          stay.status !== ReservationStatus.CHECKED_IN ||
          stay.arrival_date.getTime() > night.getTime() ||
          stay.departure_date.getTime() <= night.getTime()
        ) {
          // Checked out, moved or cancelled since the list was read.
          return null;
        }

        await tx.$queryRaw`
          SELECT 1 FROM "folio"
           WHERE "reservationId" = ${reservationId}::uuid AND "propertyId" = ${run.propertyId}::uuid
             FOR UPDATE`;
        const folio = await tx.folio.upsert({
          where: { reservationId },
          create: { propertyId: run.propertyId, reservationId, currency: stay.currency, status: 'OPEN' },
          update: {},
          select: { id: true, status: true, currency: true },
        });
        if (folio.status !== 'OPEN') {
          throw new NightAuditBlockedError(
            'An in-house stay has a closed folio, so tonight cannot be charged to it.',
            { reservationId },
          );
        }

        const existing = await tx.folioLine.findFirst({
          where: {
            propertyId: run.propertyId,
            folioId: folio.id,
            kind: 'ROOM_CHARGE',
            chargeDate: night,
            reversesLineId: null,
          },
          select: { id: true },
        });
        if (existing !== null) return null;

        /**
         * The night's price: the `reservation_night` row written when the stay
         * was booked (F9), corrections included; never today's rate. A stay
         * booked before per-night pricing has none and takes the same even
         * split check-in uses for its arrival night, so every night of such a
         * stay is charged alike.
         */
        const priced = await tx.reservationNight.findFirst({
          where: { propertyId: run.propertyId, reservationId, stayDate: night },
          select: { rateMinor: true, taxMinor: true },
        });
        const nights = Math.max(
          1,
          Math.round((stay.departure_date.getTime() - stay.arrival_date.getTime()) / DAY_MS),
        );
        const nightTotalMinor = Math.round(stay.total_amount_minor / nights);
        const taxMinor = priced?.taxMinor ?? Math.round(stay.tax_amount_minor / nights);
        const roomMinor = priced?.rateMinor ?? nightTotalMinor - taxMinor;

        const room = await tx.reservationRoom.findFirst({
          where: { propertyId: run.propertyId, reservationId },
          select: { room: { select: { number: true } } },
        });
        const label = room?.room?.number === undefined ? 'Room' : `Room ${room.room.number}`;

        const charge = await tx.folioLine.create({
          data: {
            propertyId: run.propertyId,
            folioId: folio.id,
            kind: 'ROOM_CHARGE',
            description: `${label} tariff — ${run.businessDate}`,
            amountMinor: roomMinor,
            currency: folio.currency,
            chargeDate: night,
            // Posted by the system, not a person.
            postedById: null,
          },
          select: { id: true },
        });
        if (taxMinor > 0) {
          await tx.folioLine.create({
            data: {
              propertyId: run.propertyId,
              folioId: folio.id,
              kind: 'TAX',
              description: `GST on room tariff — ${run.businessDate}`,
              amountMinor: taxMinor,
              currency: folio.currency,
              chargeDate: night,
              derivedFromLineId: charge.id,
              postedById: null,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            propertyId: run.propertyId,
            actorUserId: null,
            event: 'NIGHT_AUDIT_ROOM_CHARGE_POSTED',
            entityType: 'folio',
            entityId: reservationId,
            before: Prisma.JsonNull,
            after: { businessDate: run.businessDate, roomMinor, taxMinor, runId: run.id },
            reason: null,
          },
        });

        return { roomMinor, taxMinor };
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );
  }

  /* -------------------------------------------------------------------- */
  /*  5. Settle folios                                                     */
  /* -------------------------------------------------------------------- */

  /**
   * Close every open folio of a stay that has ended (checked out, cancelled,
   * no-show) whose lines sum to exactly zero -- the FO-13 rule -- and flag the
   * rest as exceptions for the morning. Nothing is posted to make one balance:
   * an outstanding amount or a credit is a person's decision.
   */
  private async settleFolios(run: RunRef): Promise<Outcome> {
    const open = await this.prisma.client.folio.findMany({
      where: {
        propertyId: run.propertyId,
        status: 'OPEN',
        reservation: { status: { in: [...ENDED] } },
      },
      select: { id: true, reservationId: true },
    });

    let closed = 0;
    const exceptions: { bookingCode: string; balanceMinor: number }[] = [];
    for (const folio of open) {
      const result = await this.closeIfSettled(run, folio.id, folio.reservationId);
      if (result.closed) closed += 1;
      else if (result.balanceMinor !== null) {
        exceptions.push({ bookingCode: result.bookingCode, balanceMinor: result.balanceMinor });
      }
    }
    return { closed, exceptions };
  }

  private closeIfSettled(
    run: RunRef,
    folioId: string,
    reservationId: string,
  ): Promise<{ closed: boolean; balanceMinor: number | null; bookingCode: string }> {
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${run.propertyId}, true)`;
        // Reservation, then folio: the order every folio write uses (FO-13).
        const stayRows = await tx.$queryRaw<{ status: string; code: string }[]>`
          SELECT "status"::text AS status, "confirmationCode" AS code FROM "reservation"
           WHERE "id" = ${reservationId}::uuid AND "propertyId" = ${run.propertyId}::uuid
             FOR UPDATE`;
        const folioRows = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status"::text AS status FROM "folio"
           WHERE "id" = ${folioId}::uuid AND "propertyId" = ${run.propertyId}::uuid
             FOR UPDATE`;
        const stay = stayRows[0];
        const bookingCode = stay?.code ?? '';
        if (
          stay === undefined ||
          !(ENDED as readonly string[]).includes(stay.status) ||
          folioRows[0]?.status !== 'OPEN'
        ) {
          return { closed: false, balanceMinor: null, bookingCode };
        }

        const balanceMinor =
          (
            await tx.folioLine.aggregate({
              where: { folioId, propertyId: run.propertyId },
              _sum: { amountMinor: true },
            })
          )._sum.amountMinor ?? 0;
        if (balanceMinor !== 0) return { closed: false, balanceMinor, bookingCode };

        await tx.folio.updateMany({
          where: { id: folioId, propertyId: run.propertyId, status: 'OPEN' },
          data: { status: 'CLOSED', closedAt: this.clock.now() },
        });
        await tx.auditLog.create({
          data: {
            propertyId: run.propertyId,
            actorUserId: null,
            event: 'FOLIO_CLOSED',
            entityType: 'folio',
            entityId: reservationId,
            before: Prisma.JsonNull,
            after: { folioId, balanceMinor: 0, stayStatus: stay.status, runId: run.id },
            reason: `Night audit ${run.businessDate}: settled at zero.`,
          },
        });
        return { closed: true, balanceMinor: 0, bookingCode };
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );
  }

  /* -------------------------------------------------------------------- */
  /*  6. Snapshot                                                          */
  /* -------------------------------------------------------------------- */

  /**
   * The day's figures, frozen (NA-06). Written once per (property, date) and
   * never updated -- a trigger refuses UPDATE. A resumed step finds the row
   * and reports it rather than writing a second.
   *
   * Rooms come from `inventory_day` for the date (sold is what the counters
   * hold after this run's no-shows released theirs). Money comes from the
   * ledger lines charged to the date: room revenue is room charges plus the
   * net of corrections to them, the same rule as the master report.
   */
  private async snapshot(tx: Tx, run: RunRef): Promise<Outcome> {
    const date = toDate(run.businessDate);
    const existing = await tx.dailySnapshot.findUnique({
      where: { daily_snapshot_one_per_business_date: { propertyId: run.propertyId, businessDate: date } },
      select: { roomsSold: true, roomsAvailable: true, roomRevenueMinor: true, occupancyBp: true },
    });
    if (existing !== null) return { alreadySnapshotted: true, ...existing };

    const rooms = await tx.$queryRaw<{ physical: bigint; blocked: bigint; sold: bigint }[]>`
      SELECT COALESCE(SUM("physical"), 0) AS physical,
             COALESCE(SUM("blocked"), 0)  AS blocked,
             COALESCE(SUM("sold"), 0)     AS sold
        FROM "inventory_day"
       WHERE "propertyId" = ${run.propertyId}::uuid AND "stayDate" = ${date}::date`;
    const money = await tx.$queryRaw<
      { room: bigint; service: bigint; tax: bigint; payments: bigint; refunds: bigint }[]
    >`
      SELECT
        COALESCE(SUM(CASE WHEN l."kind" = 'ROOM_CHARGE'
                            OR (l."kind" = 'ADJUSTMENT' AND NOT l."isTaxAdjustment" AND p."kind" = 'ROOM_CHARGE')
                          THEN l."amountMinor" ELSE 0 END), 0) AS room,
        COALESCE(SUM(CASE WHEN l."kind" = 'SERVICE_CHARGE'
                            OR (l."kind" = 'ADJUSTMENT' AND NOT l."isTaxAdjustment" AND p."kind" = 'SERVICE_CHARGE')
                          THEN l."amountMinor" ELSE 0 END), 0) AS service,
        COALESCE(SUM(CASE WHEN l."kind" = 'TAX' OR l."isTaxAdjustment"
                          THEN l."amountMinor" ELSE 0 END), 0) AS tax,
        COALESCE(SUM(CASE WHEN l."kind" = 'PAYMENT' THEN -l."amountMinor" ELSE 0 END), 0) AS payments,
        COALESCE(SUM(CASE WHEN l."kind" = 'REFUND' THEN l."amountMinor" ELSE 0 END), 0) AS refunds
        FROM "folio_line" l
        LEFT JOIN "folio_line" p ON p."id" = l."derivedFromLineId"
       WHERE l."propertyId" = ${run.propertyId}::uuid AND l."chargeDate" = ${date}::date`;
    const property = await tx.property.findFirst({
      where: { id: run.propertyId },
      select: { currency: true },
    });

    // Postgres SUM returns bigint; every figure is a room count or minor units
    // well inside the safe-integer range, so the narrowing is lossless.
    const physical = Number(rooms[0]?.physical ?? 0);
    const blocked = Number(rooms[0]?.blocked ?? 0);
    const sold = Number(rooms[0]?.sold ?? 0);
    const available = Math.max(0, physical - blocked);
    const roomRevenue = Number(money[0]?.room ?? 0);

    const figures = {
      roomsPhysical: physical,
      roomsBlocked: blocked,
      roomsAvailable: available,
      roomsSold: sold,
      // Integer ratios: basis points and per-room minor units, rounded once.
      occupancyBp: available === 0 ? 0 : Math.round((sold * 10_000) / available),
      currency: property?.currency ?? 'INR',
      roomRevenueMinor: roomRevenue,
      adrMinor: sold === 0 ? 0 : Math.round(roomRevenue / sold),
      revparMinor: available === 0 ? 0 : Math.round(roomRevenue / available),
      serviceRevenueMinor: Number(money[0]?.service ?? 0),
      taxMinor: Number(money[0]?.tax ?? 0),
      paymentsMinor: Number(money[0]?.payments ?? 0),
      refundsMinor: Number(money[0]?.refunds ?? 0),
    };

    await tx.dailySnapshot.createMany({
      data: [{ propertyId: run.propertyId, businessDate: date, runId: run.id, ...figures }],
      skipDuplicates: true,
    });
    return figures;
  }

  /* -------------------------------------------------------------------- */
  /*  7. Business date                                                     */
  /* -------------------------------------------------------------------- */

  /**
   * The one writer of `property.businessDate` (NA-05). Conditional on the
   * date still being the run's, so a second executor, or a resumed step, can
   * never advance it twice.
   */
  private async advanceBusinessDate(tx: Tx, run: RunRef): Promise<Outcome> {
    const next = addDays(run.businessDate, 1);
    const advanced = await tx.property.updateMany({
      where: { id: run.propertyId, businessDate: toDate(run.businessDate) },
      data: { businessDate: toDate(next) },
    });
    if (advanced.count === 0) {
      const property = await tx.property.findFirst({
        where: { id: run.propertyId },
        select: { businessDate: true },
      });
      const current = property === null ? null : iso(property.businessDate);
      if (current !== next) {
        throw new NightAuditBlockedError(
          `The business date is ${String(current)}; expected ${run.businessDate} or ${next}.`,
          { businessDate: current },
        );
      }
    }
    await tx.auditLog.create({
      data: {
        propertyId: run.propertyId,
        actorUserId: null,
        event: 'BUSINESS_DATE_ADVANCED',
        entityType: 'property',
        entityId: run.propertyId,
        before: { businessDate: run.businessDate },
        after: { businessDate: next, runId: run.id },
        reason: null,
      },
    });
    return { from: run.businessDate, to: next, advanced: advanced.count === 1 };
  }

  /* -------------------------------------------------------------------- */
  /*  8. Emit                                                              */
  /* -------------------------------------------------------------------- */

  /** Reports and notifications go through the outbox, never inline (section 3.3). */
  private async emit(tx: Tx, run: RunRef): Promise<Outcome> {
    const result = await this.outbox.enqueue(tx, {
      propertyId: run.propertyId,
      eventType: 'NIGHT_AUDIT_COMPLETED',
      payload: { runId: run.id, businessDate: run.businessDate },
      dedupeKey: `night-audit-completed:${run.id}`,
      dedupeMode: 'UNIQUE_FOREVER',
    });
    return { event: 'NIGHT_AUDIT_COMPLETED', outcome: result.outcome };
  }
}
