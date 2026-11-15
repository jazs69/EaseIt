/**
 * Persistence for seasonal and recurring pricing rules. No business rules
 * here; precedence and conflict logic live in `rate-pricing.policy.ts` (§5).
 *
 * ===========================================================================
 * Every statement carries `propertyId` explicitly. There is no Prisma tenancy
 * extension and no row-level security in this repository -- section 3.2
 * describes both and neither is implemented -- so the predicate IS the tenancy
 * control, not a convenience on top of one.
 *
 * `select` is always explicit. A bare `findMany` would widen the response
 * contract silently the next time a column is added, and would publish
 * `propertyId` and `createdByUserId`.
 *
 * EVERYTHING IS A PARAMETERISED PRISMA QUERY. No raw SQL at all in this file,
 * and in particular nothing built from a user-supplied string: the rule writes
 * are small (one row plus at most fifty prices), so F2's reason for a raw bulk
 * upsert -- avoiding 180 round trips inside one transaction -- does not apply
 * here.
 *
 * `stayDate`-style `@db.Date` columns are converted at this boundary and
 * nowhere else: a date arrives from Postgres as a JS `Date` at UTC midnight,
 * and `toISOString().slice(0, 10)` is the only safe way back to `YYYY-MM-DD`.
 * Anything local-timezone-aware shifts it a day (section 3.3).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import {
  DuplicateIdentifierError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const RULE_SELECT = {
  id: true,
  ratePlanId: true,
  kind: true,
  name: true,
  startDate: true,
  endDate: true,
  daysOfWeek: true,
  priority: true,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
  prices: {
    select: {
      roomTypeId: true,
      amountMinor: true,
      // Reached through the assignment relation, which is also the thing that
      // proves the category is assigned to the plan. Same device
      // `RatePlanDay.assignment` uses.
      assignment: { select: { roomType: { select: { code: true, name: true } } } },
    },
    // Stable order, so two reads render identically and a diff in an audit
    // payload means something changed.
    orderBy: [
      { assignment: { roomType: { sortOrder: 'asc' } } },
      { assignment: { roomType: { code: 'asc' } } },
    ],
  },
} satisfies Prisma.RatePricingRuleSelect;

export type RuleKind = 'SEASONAL' | 'WEEKDAY' | 'WEEKEND';

export interface RuleRow {
  id: string;
  ratePlanId: string;
  kind: RuleKind;
  name: string;
  /** `YYYY-MM-DD`, converted at this boundary. Null for the recurring kinds. */
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[];
  priority: number;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  prices: {
    roomTypeId: string;
    amountMinor: number;
    roomType: { code: string; name: string };
  }[];
}

export interface RuleFilter {
  kind?: RuleKind;
  /** `kind` narrowed to a set, for the two route families. */
  kinds?: readonly RuleKind[];
  enabled?: 'all' | 'enabled' | 'disabled';
  roomTypeId?: string;
}

export interface RuleWriteInput {
  kind: RuleKind;
  name: string;
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[];
  priority: number;
}

export interface RulePriceInput {
  roomTypeId: string;
  amountMinor: number;
}

/** `@db.Date` to `YYYY-MM-DD`, the only conversion site. */
function toCalendarDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` to the UTC-midnight instant a `@db.Date` column wants. */
function toDateColumn(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

function toRow(row: {
  id: string;
  ratePlanId: string;
  kind: RuleKind;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  daysOfWeek: number[];
  priority: number;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  prices: {
    roomTypeId: string;
    amountMinor: number;
    assignment: { roomType: { code: string; name: string } };
  }[];
}): RuleRow {
  return {
    id: row.id,
    ratePlanId: row.ratePlanId,
    kind: row.kind,
    name: row.name,
    startDate: toCalendarDate(row.startDate),
    endDate: toCalendarDate(row.endDate),
    // Sorted so Sunday-to-Saturday always reads in order, whatever order the
    // client sent or the array was stored in.
    daysOfWeek: [...row.daysOfWeek].sort((a, b) => a - b),
    priority: row.priority,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Flattened here so nothing above this boundary has to know the room type
    // is reached through the assignment.
    prices: row.prices.map((price) => ({
      roomTypeId: price.roomTypeId,
      amountMinor: price.amountMinor,
      roomType: price.assignment.roomType,
    })),
  };
}

/**
 * Translates a `P2002`/`P2003` into the typed error the caller should see.
 *
 * A unique violation here can only be the per-plan name index. A foreign-key
 * violation, by the time the service has validated ownership and assignment,
 * means a room type or assignment removed between the check and the write --
 * reported against `prices` so the form marks the right control.
 */
function translateWriteFailure(error: unknown, name: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new DuplicateIdentifierError('pricing rule', 'name', name);
    }
    if (error.code === 'P2003' || error.code === 'P2025') {
      throw new ValidationFailedError({
        prices: 'One of those room types is no longer assigned to this rate plan.',
      });
    }
  }
  throw error;
}

@Injectable()
export class RatePricingRuleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(propertyId: string, ratePlanId: string, filter: RuleFilter): Promise<RuleRow[]> {
    const rows = await this.prisma.client.ratePricingRule.findMany({
      where: {
        propertyId,
        ratePlanId,
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.kinds === undefined ? {} : { kind: { in: [...filter.kinds] } }),
        ...(filter.enabled === undefined || filter.enabled === 'all'
          ? {}
          : { isEnabled: filter.enabled === 'enabled' }),
        // `some` with `propertyId` scoped too, so an id from elsewhere cannot
        // reach across properties even if supplied.
        ...(filter.roomTypeId === undefined
          ? {}
          : { prices: { some: { propertyId, roomTypeId: filter.roomTypeId } } }),
      },
      select: RULE_SELECT,
      // Precedence order, so a list reads the way the resolver decides:
      // seasons first, then weekday, then weekend; higher priority first.
      orderBy: [{ kind: 'asc' }, { priority: 'desc' }, { name: 'asc' }],
    });

    return rows.map(toRow);
  }

  /**
   * One rule, scoped by `propertyId` AND `ratePlanId` in the SAME predicate as
   * the id.
   *
   * Not `findUnique` on the id alone followed by a comparison: a lookup that
   * can find another property's row and then reject it has already confirmed
   * that row exists. Not found is the only correct answer (3.2).
   */
  async findOne(propertyId: string, ratePlanId: string, ruleId: string): Promise<RuleRow | null> {
    const row = await this.prisma.client.ratePricingRule.findFirst({
      where: { id: ruleId, propertyId, ratePlanId },
      select: RULE_SELECT,
    });

    return row === null ? null : toRow(row);
  }

  /**
   * Every enabled rule for a plan that prices at least one room type, in the
   * shape the resolver's conflict detector needs.
   *
   * Reads disabled rules too when asked, because re-enabling one has to be
   * checked against what is already enabled.
   */
  async findForConflictCheck(
    propertyId: string,
    ratePlanId: string,
  ): Promise<
    {
      id: string;
      name: string;
      kind: RuleKind;
      startDate: string | null;
      endDate: string | null;
      daysOfWeek: number[];
      priority: number;
      isEnabled: boolean;
      roomTypeIds: string[];
    }[]
  > {
    const rows = await this.prisma.client.ratePricingRule.findMany({
      where: { propertyId, ratePlanId },
      select: {
        id: true,
        name: true,
        kind: true,
        startDate: true,
        endDate: true,
        daysOfWeek: true,
        priority: true,
        isEnabled: true,
        prices: { select: { roomTypeId: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as RuleKind,
      startDate: toCalendarDate(row.startDate),
      endDate: toCalendarDate(row.endDate),
      daysOfWeek: [...row.daysOfWeek],
      priority: row.priority,
      isEnabled: row.isEnabled,
      roomTypeIds: row.prices.map((price) => price.roomTypeId),
    }));
  }

  /**
   * The enabled rules that price ONE room type, for the calendar resolver.
   *
   * Filtered in the database rather than in the service, so a plan with
   * fifteen rules across five categories does not ship all seventy-five price
   * rows to resolve one column of the grid. Only priced categories come back,
   * which is also what the resolver requires: a rule with no price for the
   * category does not apply to it.
   */
  async findForResolution(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
  ): Promise<
    {
      id: string;
      name: string;
      kind: RuleKind;
      startDate: string | null;
      endDate: string | null;
      daysOfWeek: number[];
      priority: number;
      amountMinor: number;
    }[]
  > {
    const rows = await this.prisma.client.ratePricingRule.findMany({
      where: {
        propertyId,
        ratePlanId,
        isEnabled: true,
        prices: { some: { propertyId, roomTypeId } },
      },
      select: {
        id: true,
        name: true,
        kind: true,
        startDate: true,
        endDate: true,
        daysOfWeek: true,
        priority: true,
        prices: {
          where: { propertyId, roomTypeId },
          select: { amountMinor: true },
        },
      },
    });

    return rows.flatMap((row) => {
      const price = row.prices[0];
      // Cannot happen given the `some` filter, but a rule with no price for
      // this category must never reach the resolver: it would have no number
      // to decide with. Dropped rather than defaulted.
      if (price === undefined) return [];
      return [
        {
          id: row.id,
          name: row.name,
          kind: row.kind as RuleKind,
          startDate: toCalendarDate(row.startDate),
          endDate: toCalendarDate(row.endDate),
          daysOfWeek: [...row.daysOfWeek],
          priority: row.priority,
          amountMinor: price.amountMinor,
        },
      ];
    });
  }

  /**
   * Create a rule and its prices in one transaction.
   *
   * A rule and its prices are one fact. Creating the rule and then inserting
   * prices separately would leave a rule pricing nothing if the process died
   * between them -- and a rule that prices nothing is exactly the state the
   * DTO refuses to let a client create.
   *
   * `ratePlanId` is stamped on every price row explicitly. It is denormalised
   * from the rule, and the composite foreign key
   * `rate_pricing_rule_price_rule_triple` is what keeps the copy honest.
   */
  async create(
    propertyId: string,
    ratePlanId: string,
    input: RuleWriteInput,
    prices: readonly RulePriceInput[],
    createdByUserId: string,
  ): Promise<RuleRow> {
    try {
      const created = await this.prisma.client.$transaction(async (tx) =>
        tx.ratePricingRule.create({
          data: {
            propertyId,
            ratePlanId,
            kind: input.kind,
            name: input.name,
            startDate: toDateColumn(input.startDate),
            endDate: toDateColumn(input.endDate),
            daysOfWeek: input.daysOfWeek,
            priority: input.priority,
            createdByUserId,
            prices: {
              create: prices.map((price) => ({
                propertyId,
                ratePlanId,
                roomTypeId: price.roomTypeId,
                amountMinor: price.amountMinor,
              })),
            },
          },
          select: RULE_SELECT,
        }),
      );

      return toRow(created);
    } catch (error) {
      translateWriteFailure(error, input.name);
    }
  }

  /**
   * Update a rule, and optionally replace its price set.
   *
   * ===========================================================================
   * THE PRICE REPLACE IS A DIFF, not a delete-then-reinsert, for the same
   * reason F2's assignment replace is: a row that survives keeps its identity
   * and its `createdAt`, and only a genuinely removed room type loses its
   * price. Here it also avoids a window in which the rule prices nothing,
   * which the CHECK constraints do not forbid but which no reader should ever
   * observe.
   * ===========================================================================
   */
  async update(
    propertyId: string,
    ratePlanId: string,
    ruleId: string,
    input: Partial<RuleWriteInput>,
    prices: readonly RulePriceInput[] | undefined,
  ): Promise<RuleRow | null> {
    try {
      const found = await this.prisma.client.$transaction(async (tx) => {
        const data = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.startDate === undefined ? {} : { startDate: toDateColumn(input.startDate) }),
          ...(input.endDate === undefined ? {} : { endDate: toDateColumn(input.endDate) }),
          ...(input.daysOfWeek === undefined ? {} : { daysOfWeek: input.daysOfWeek }),
        };

        if (Object.keys(data).length > 0) {
          const updated = await tx.ratePricingRule.updateMany({
            where: { id: ruleId, propertyId, ratePlanId },
            data,
          });
          if (updated.count === 0) return false;
        } else {
          const exists = await tx.ratePricingRule.count({
            where: { id: ruleId, propertyId, ratePlanId },
          });
          if (exists === 0) return false;
        }

        if (prices !== undefined) {
          const existing = await tx.ratePricingRulePrice.findMany({
            where: { propertyId, ruleId },
            select: { roomTypeId: true, amountMinor: true },
          });

          const keep = new Set(prices.map((price) => price.roomTypeId));
          const before = new Map(existing.map((row) => [row.roomTypeId, row.amountMinor]));

          const removed = existing
            .filter((row) => !keep.has(row.roomTypeId))
            .map((row) => row.roomTypeId);

          if (removed.length > 0) {
            await tx.ratePricingRulePrice.deleteMany({
              where: { propertyId, ruleId, roomTypeId: { in: removed } },
            });
          }

          for (const price of prices) {
            const current = before.get(price.roomTypeId);

            if (current === undefined) {
              await tx.ratePricingRulePrice.create({
                data: {
                  propertyId,
                  ruleId,
                  ratePlanId,
                  roomTypeId: price.roomTypeId,
                  amountMinor: price.amountMinor,
                },
              });
              continue;
            }

            // Only write when the amount actually differs, so `updatedAt` on an
            // untouched price stays honest about when it last changed.
            if (current !== price.amountMinor) {
              await tx.ratePricingRulePrice.update({
                where: { ruleId_roomTypeId: { ruleId, roomTypeId: price.roomTypeId } },
                data: { amountMinor: price.amountMinor },
              });
            }
          }
        }

        return true;
      });

      if (!found) return null;
    } catch (error) {
      translateWriteFailure(error, input.name ?? '');
    }

    return this.findOne(propertyId, ratePlanId, ruleId);
  }

  /** Enable or disable. Scoped by all three ids in one predicate. */
  async setEnabled(
    propertyId: string,
    ratePlanId: string,
    ruleId: string,
    isEnabled: boolean,
  ): Promise<RuleRow | null> {
    const updated = await this.prisma.client.ratePricingRule.updateMany({
      where: { id: ruleId, propertyId, ratePlanId },
      data: { isEnabled },
    });

    if (updated.count === 0) return null;

    return this.findOne(propertyId, ratePlanId, ruleId);
  }

  /**
   * Delete a rule. Its prices cascade.
   *
   * A real delete, unlike a rate plan, which only archives. The difference is
   * deliberate: a rate plan may have been quoted and is history, whereas a
   * pricing rule is pure configuration -- nothing references it, and no
   * reservation or folio points at one, because F9 has not integrated pricing
   * yet. A deleted rule changes future effective rates and nothing else.
   *
   * Returns false when the row is not this property's, so the caller answers
   * not-found rather than a misleading success.
   */
  async remove(propertyId: string, ratePlanId: string, ruleId: string): Promise<boolean> {
    const deleted = await this.prisma.client.ratePricingRule.deleteMany({
      where: { id: ruleId, propertyId, ratePlanId },
    });

    return deleted.count > 0;
  }

  /** The property's weekend definition, with the documented default. */
  async weekendDays(propertyId: string): Promise<number[]> {
    const settings = await this.prisma.client.propertySettings.findUnique({
      where: { propertyId },
      select: { weekendDays: true },
    });

    // A property with no settings row yet gets the same default the column
    // declares, so a WEEKEND rule behaves identically before and after the
    // operator first opens the settings screen.
    return settings === null ? [0, 6] : [...settings.weekendDays];
  }
}
