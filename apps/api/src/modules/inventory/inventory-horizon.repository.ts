/**
 * The only writer that INSERTS `inventory_day` rows at runtime.
 *
 * ===========================================================================
 * Before this, nothing did. The seed wrote one `createMany` per property at
 * seed time (`INVENTORY_DAYS_FORWARD = 60`, measured from the seed run date),
 * and the three reservation services only ever `increment`/`decrement` `sold`
 * on rows that already exist. So the selling horizon was a fixed calendar date
 * that shrank by a day every day.
 *
 * WHAT THIS MUST NEVER DO, and why.
 * `ON CONFLICT DO NOTHING`, never `DO UPDATE`, and never `DELETE`:
 *
 *   * An existing row carries live `sold`, `blocked` and `overbookingAllowance`.
 *     Overwriting `physical` could drop it below `sold + blocked` and trip
 *     `inventory_day_not_oversold` — or worse, succeed and invent capacity.
 *   * Overwriting `sold` would destroy the booking-to-counter agreement that
 *     `cancel-reservation.service.ts` refuses to proceed without.
 *   * Deleting a row would make a cancellation of any stay covering that night
 *     impossible: it requires one row per night per held category and refuses
 *     the whole operation when one is missing.
 *
 * So this is strictly additive. It can only ever create a night that did not
 * exist, which no existing invariant depends on being absent.
 *
 * NO ROW LOCKS, and why that is safe.
 * It never reads-then-writes and never touches an existing row, so there is
 * nothing to lose an update on. Two concurrent extensions over overlapping
 * ranges both succeed, one inserting and the other skipping. It takes no
 * `FOR UPDATE` on `inventory_day`, so it adds no edge to the lock graph the
 * reservation protocol in CLAUDE.md section 3.1.1 reasons about.
 *
 * WHY RAW SQL.
 * Prisma cannot express `INSERT ... SELECT ... ON CONFLICT DO NOTHING`, which
 * CLAUDE.md section 2 permits raw SQL for. It is also the only way to compute
 * `physical` from the room table *inside the same statement*, so there is no
 * window in which the room count could change between reading it and writing
 * it. Every value is a parameterised tagged-template binding.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  INVENTORY_LOCK_TIMEOUT_MS,
  TRANSACTION_MAX_WAIT_MS,
  TRANSACTION_TIMEOUT_MS,
  toCalendarDate,
  type CalendarDate,
  type RoomTypeCoverage,
} from './inventory-horizon.policy.js';

/** A Prisma transaction client, as the reservation services type it. */
type Tx = Prisma.TransactionClient;

@Injectable()
export class InventoryHorizonRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in one transaction with the property stamped on the session.
   *
   * `set_config('app.current_property_id', …, true)` matches what every other
   * writer does (folios, property-setup and all five reservation paths), and
   * the `true` is `is_local` — reverted at COMMIT/ROLLBACK.
   *
   * An honest note on what it buys **today**: nothing. CLAUDE.md section 3.2
   * describes Postgres RLS as a backstop, but no migration in this repository
   * enables row-level security or creates a policy — 0 of 22 — so the variable
   * is read by nothing. It is set anyway, for consistency with the sixteen
   * other call sites and so that enabling RLS later does not have to revisit
   * this file. Tenancy here rests entirely on the grant resolution in the
   * service, which is the control that actually holds.
   */
  async inTransaction<T>(propertyId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;

        /**
         * Bound the wait for a contended `inventory_day` key, before any
         * statement that can block.
         *
         * Second statement in the transaction and ahead of every chunk
         * INSERT, which is the same slot the four reservation paths use
         * (`cancel-reservation:204`, `check-in:300`, `check-out:118`,
         * `room-move:270`). `true` is `is_local` — `SET LOCAL` semantics,
         * reverted at COMMIT/ROLLBACK, so no other connection's behaviour
         * changes. Never set the global `lock_timeout`: a transaction bounds
         * only itself.
         *
         * Exceeding it raises `55P03`, which the service translates into a
         * typed conflict. Without this line the INSERT waits indefinitely on
         * PostgreSQL's speculative-insertion lock and Prisma's transaction
         * deadline cannot interrupt it.
         */
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(
          INVENTORY_LOCK_TIMEOUT_MS,
        )}, true)`;

        return work(tx);
      },
      { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /** How many room types the property has, read inside the transaction. */
  async countRoomTypes(tx: Tx, propertyId: string): Promise<number> {
    return tx.roomType.count({ where: { propertyId } });
  }

  /**
   * Inserts the missing rows for one bounded date range. Returns rows created.
   *
   * `physical` is `COUNT(room WHERE roomTypeId = rt.id AND status <>
   * 'OUT_OF_ORDER')`, which is **exactly** the seed's rule: the seed pushes a
   * room into its type's pool unless the status is `OUT_OF_ORDER` and then uses
   * that pool's length as `physical`. `RoomStatus`'s own docstring states the
   * same contract — "OUT_OF_ORDER rooms drop out of physical stock when
   * inventory is rebuilt; OUT_OF_SERVICE rooms stay counted". No new definition
   * of physical stock is introduced here.
   *
   * The room count is additionally constrained to the same `propertyId`. That
   * is redundant given `room_same_property_as_room_type` (the composite FK
   * guarantees a room's type belongs to its property) and kept anyway, because
   * a count that silently spanned properties is exactly the class of bug
   * section 3.2 exists to prevent.
   *
   * `$executeRaw` returns the number of rows the statement affected, so the
   * created count is the database's, not an estimate.
   */
  async insertRange(tx: Tx, propertyId: string, from: Date, to: Date): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO inventory_day (
        "id", "propertyId", "roomTypeId", "stayDate",
        "physical", "sold", "blocked", "overbookingAllowance",
        "createdAt", "updatedAt"
      )
      SELECT gen_random_uuid(),
             rt."propertyId",
             rt."id",
             series.stay_date::date,
             (
               SELECT count(*)
                 FROM room r
                WHERE r."roomTypeId" = rt."id"
                  AND r."propertyId" = rt."propertyId"
                  AND r."status" <> 'OUT_OF_ORDER'
             ),
             0, 0, 0,
             now(), now()
        FROM room_type rt
        CROSS JOIN generate_series(
               ${from}::date, ${to}::date, interval '1 day'
             ) AS series(stay_date)
       WHERE rt."propertyId" = ${propertyId}::uuid
      ON CONFLICT ("propertyId", "roomTypeId", "stayDate") DO NOTHING
    `;
  }

  /**
   * Per-room-type forward coverage, with the first hole measured in SQL.
   *
   * The first missing date is found by generating the window and
   * anti-joining `inventory_day`, **not** by subtracting a count from a span.
   * A count cannot locate a hole: a room type with a row for today and rows
   * for today+10..today+20 has twelve rows, and "twelve contiguous days" would
   * put the first gap at today+12 when it is really at today+1.
   *
   * The window runs from today to the property's own furthest configured date,
   * so a property whose calendar ends next month is not reported as having
   * hundreds of "missing" days it never claimed to have.
   */
  async findCoverage(propertyId: string, today: Date): Promise<RoomTypeCoverage[]> {
    const rows = await this.prisma.client.$queryRaw<
      {
        room_type_id: string;
        code: string;
        name: string;
        configured_days: bigint | number;
        last_configured: Date | null;
        first_missing: Date | null;
      }[]
    >`
      WITH horizon AS (
        SELECT COALESCE(MAX(i."stayDate"), ${today}::date) AS last_date
          FROM inventory_day i
         WHERE i."propertyId" = ${propertyId}::uuid
           AND i."stayDate" >= ${today}::date
      ),
      window_dates AS (
        SELECT d::date AS stay_date
          FROM horizon,
               generate_series(${today}::date, horizon.last_date, interval '1 day') AS d
      )
      SELECT rt."id"   AS room_type_id,
             rt."code" AS code,
             rt."name" AS name,
             (
               SELECT count(*)
                 FROM inventory_day i
                WHERE i."propertyId" = rt."propertyId"
                  AND i."roomTypeId" = rt."id"
                  AND i."stayDate" >= ${today}::date
             ) AS configured_days,
             (
               SELECT max(i."stayDate")
                 FROM inventory_day i
                WHERE i."propertyId" = rt."propertyId"
                  AND i."roomTypeId" = rt."id"
                  AND i."stayDate" >= ${today}::date
             ) AS last_configured,
             (
               SELECT min(w.stay_date)
                 FROM window_dates w
                WHERE NOT EXISTS (
                        SELECT 1
                          FROM inventory_day i
                         WHERE i."propertyId" = rt."propertyId"
                           AND i."roomTypeId" = rt."id"
                           AND i."stayDate" = w.stay_date
                      )
             ) AS first_missing
        FROM room_type rt
       WHERE rt."propertyId" = ${propertyId}::uuid
       ORDER BY rt."code" ASC
    `;

    return rows.map((row) => ({
      roomTypeId: row.room_type_id,
      code: row.code,
      name: row.name,
      configuredDays: Number(row.configured_days),
      lastConfiguredDate: row.last_configured === null ? null : toCalendarDate(row.last_configured),
      firstMissingDate: row.first_missing === null ? null : toCalendarDate(row.first_missing),
    }));
  }

  /** `MIN`/`MAX` across the whole property, for the reported range. */
  async findConfiguredRange(
    propertyId: string,
  ): Promise<{ first: CalendarDate | null; last: CalendarDate | null }> {
    const grouped = await this.prisma.client.inventoryDay.aggregate({
      where: { propertyId },
      _min: { stayDate: true },
      _max: { stayDate: true },
    });

    return {
      first: grouped._min.stayDate === null ? null : toCalendarDate(grouped._min.stayDate),
      last: grouped._max.stayDate === null ? null : toCalendarDate(grouped._max.stayDate),
    };
  }
}
