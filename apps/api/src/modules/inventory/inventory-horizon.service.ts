/**
 * Reading and extending a property's inventory calendar.
 *
 * ===========================================================================
 * `inventory_day` decides what can be sold: `create-reservation` locks one row
 * per night and refuses when the count comes back short, so a night with no
 * row is unsellable regardless of how many rooms stand empty. The seed built a
 * window of `today + 60` days *at seed time* and nothing extended it
 * afterwards, which means the horizon shrank by a day every day until the
 * hotel could not take a booking for next season.
 *
 * This is deliberately operator-triggered rather than a scheduled job. The
 * worker entry point exists (`apps/api/src/worker.ts`), but a repeating queue
 * is operational surface a single-hotel pilot does not need, and CLAUDE.md
 * section 6.4 says not to add infrastructure the existing stack can avoid.
 * Explicit extension is also the more honest model: how far ahead a hotel
 * sells is a commercial decision, not a background detail.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Permission,
  type ExtendInventoryHorizonResponse,
  type InventoryHorizon,
} from '@repo/types';

import {
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { ClockService } from '../platform/clock.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InventoryHorizonRepository } from './inventory-horizon.repository.js';
import {
  MAX_HORIZON_DAYS,
  addCalendarDays,
  planHorizon,
  summariseCoverage,
  toCalendarDate,
} from './inventory-horizon.policy.js';

@Injectable()
export class InventoryHorizonService {
  private readonly logger = new Logger(InventoryHorizonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: InventoryHorizonRepository,
    private readonly clock: ClockService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /*  Read                                                                  */
  /* ---------------------------------------------------------------------- */

  async horizon(userId: string, hotelId: string): Promise<InventoryHorizon> {
    const property = await this.authorise(userId, hotelId, Permission.RESERVATIONS_READ);
    const today = this.todayUtc();

    const [coverage, range] = await Promise.all([
      this.repository.findCoverage(property.id, today),
      this.repository.findConfiguredRange(property.id),
    ]);

    const summary = summariseCoverage(coverage, today);

    return {
      today: toCalendarDate(today),
      firstConfiguredDate: range.first,
      lastConfiguredDate: range.last,
      fullyConfiguredThrough: summary.fullyConfiguredThrough,
      daysRemaining: summary.daysRemaining,
      roomTypeCount: coverage.length,
      maxExtendableThrough: toCalendarDate(addCalendarDays(today, MAX_HORIZON_DAYS)),
      gaps: summary.gaps,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Write                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Extends the calendar to `throughDate`, inclusive, starting from today.
   *
   * Idempotent on the schema's own `inventory_day_unique_per_date`: a repeated
   * request inserts nothing and reports `rowsCreated: 0`. It may still create
   * rows the previous run did not — the range is re-walked from today every
   * time rather than resumed from a stored maximum, which is what lets it fill
   * an internal gap (a room type added last week, say) instead of only
   * appending to the end.
   *
   * **One transaction, bounded statements.** The range is split into chunks of
   * at most `MAX_CHUNK_DAYS` days so no single statement is unbounded, and all
   * chunks run inside one `$transaction`, so the extension is atomic. There is
   * therefore no partial-completion state and nothing to retry: either the
   * whole range is covered or nothing changed.
   */
  async extend(
    userId: string,
    hotelId: string,
    throughDate: string,
  ): Promise<ExtendInventoryHorizonResponse> {
    const property = await this.authorise(userId, hotelId, Permission.PROPERTY_SETTINGS);
    const today = this.todayUtc();

    const plan = planHorizon({ throughDate, today });
    if ('kind' in plan) {
      throw new ValidationFailedError({ [plan.field]: plan.message });
    }

    // Read before the write so the audit entry records what actually changed.
    const horizonBefore = summariseCoverage(
      await this.repository.findCoverage(property.id, today),
      today,
    ).fullyConfiguredThrough;

    const { created, roomTypeCount } = await this.repository.inTransaction(
      property.id,
      async (tx) => {
        const types = await this.repository.countRoomTypes(tx, property.id);

        // Nothing to generate for: a property with no room types has no
        // calendar. Reported as zero rather than treated as an error — the
        // operator's next step is to add room types, not to retry this.
        if (types === 0) return { created: 0, roomTypeCount: 0 };

        let total = 0;
        for (const chunk of plan.chunks) {
          total += await this.repository.insertRange(tx, property.id, chunk.from, chunk.to);
        }

        /**
         * The trail, in the same transaction as the write.
         *
         * Uses the existing `audit_log` table and `tx.auditLog.create`, the
         * same way `property-setup.service.ts` records a configuration change
         * — no new audit mechanism. Extending the calendar changes what the
         * hotel is able to sell and is gated on `property:settings`, so it
         * belongs in the trail for the same reason a settings edit does
         * (CLAUDE.md section 3.4).
         *
         * `entityId` is the property: the row is about the property's calendar
         * extent, and `inventory_day` has no single id this describes.
         * `before`/`after` carry the two horizons rather than thousands of
         * row ids, which is what makes the entry readable a month later.
         */
        await tx.auditLog.create({
          data: {
            propertyId: property.id,
            actorUserId: userId,
            event: 'INVENTORY_HORIZON_EXTENDED',
            entityType: 'inventory_day',
            entityId: property.id,
            before: { fullyConfiguredThrough: horizonBefore },
            after: {
              fromDate: toCalendarDate(plan.from),
              throughDate: toCalendarDate(plan.to),
              rowsCreated: total,
              roomTypeCount: types,
              dayCount: plan.dayCount,
            },
          },
        });

        return { created: total, roomTypeCount: types };
      },
    );

    // Attempted is what the statements enumerated: room types x dates. Skipped
    // is therefore a measured difference, not an estimate.
    const attempted = roomTypeCount * plan.dayCount;
    const skipped = Math.max(0, attempted - created);

    // Re-read after the write so the caller is told the real post-state rather
    // than what was requested. They differ whenever a room type still has a
    // hole behind today's date that this run did not reach.
    const coverage = await this.repository.findCoverage(property.id, today);
    const summary = summariseCoverage(coverage, today);

    // Structured-ish context without guest PII: property, dates, counts only.
    this.logger.log(
      `Inventory extended for property ${property.id} ` +
        `${toCalendarDate(plan.from)}..${toCalendarDate(plan.to)}: ` +
        `${String(created)} created, ${String(skipped)} already present, ` +
        `${String(roomTypeCount)} room type(s), ${String(plan.dayCount)} day(s)`,
    );

    return {
      throughDate: toCalendarDate(plan.to),
      fromDate: toCalendarDate(plan.from),
      rowsCreated: created,
      rowsSkipped: skipped,
      roomTypeCount,
      dayCount: plan.dayCount,
      fullyConfiguredThrough: summary.fullyConfiguredThrough,
    };
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Today as the **current UTC calendar date**.
   *
   * ===========================================================================
   * This is the approved contract, and it is deliberately NOT the property's
   * own timezone. An earlier draft of this file used
   * `currentDateInTimeZone(property.timezone, …)`, reasoning from CLAUDE.md
   * section 3.3 — correct for anything *financial*, because a posting dated by
   * the server's calendar day lands in the wrong business date.
   *
   * Generating inventory is not that. It decides the two administrative
   * endpoints of a range: where generation starts and how far the 730-day cap
   * reaches. `inventory_day.stayDate` is a `@db.Date`, so the only possible
   * effect of the choice is one extra or one fewer row at a boundary, and an
   * extra row is harmless — it is a sellable night nobody has to sell, created
   * with `sold = 0`. Meanwhile UTC makes the cap mean the same thing for every
   * property, which is what an administrative limit should do.
   *
   * The clock stays injected so this is testable and so no `new Date()`
   * appears in domain code.
   * ===========================================================================
   */
  private todayUtc(): Date {
    return new Date(`${toCalendarDate(this.clock.now())}T00:00:00.000Z`);
  }

  /**
   * Resolves the property through the caller's own grants, then checks the
   * permission.
   *
   * `findMany`, not `findFirst`: several roles at one property union into one
   * authority. The tenancy predicate is the shared `grantedPropertyWhere`, so
   * an identifier the caller holds no grant for matches nothing and is
   * reported **not-found (404)**, never forbidden — a 403 would confirm the
   * property exists (CLAUDE.md section 3.2). Only a caller who has already
   * proven a grant can reach the 403 below.
   *
   * `operableOnly: false` matches the ten other write/operational call sites.
   * Configuring the calendar of an ONBOARDING property is exactly what a hotel
   * does before it opens, and the approved scope says not to change
   * property-status policy.
   */
  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<{ id: string }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    requirePermissionFromGrants(grants, required);

    return { id: first.property.id };
  }
}
