/**
 * Persistence for promotions and promo codes. No business rules here;
 * eligibility, selection and discount live in `promotion.policy.ts` (§5).
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
 * NOTHING HERE WRITES A REDEMPTION COUNTER. `redeemedCount` is read, never
 * written, and `promotion_redemption` has no writer at all in F5. The
 * consumption contract belongs to F9 and is documented in migration
 * 20261110230000 section 4. There is deliberately no `incrementRedemption`
 * method here: a method that existed would eventually be called, and a
 * check-then-increment is exactly what the scope forbids.
 *
 * EVERY QUERY IS A PARAMETERISED PRISMA QUERY. No raw SQL at all in this file,
 * and in particular nothing built from a user-supplied string -- a promo code
 * is user input, and it is matched through a bound Prisma predicate on the
 * normalised column, never interpolated.
 *
 * `@db.Date` columns are converted at this boundary and nowhere else: a date
 * arrives from Postgres as a JS `Date` at UTC midnight, and
 * `toISOString().slice(0, 10)` is the only safe way back to `YYYY-MM-DD`.
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

const PROMOTION_SELECT = {
  id: true,
  name: true,
  description: true,
  discountKind: true,
  discountValue: true,
  priority: true,
  isActive: true,
  stayFromDate: true,
  stayThroughDate: true,
  bookFromDate: true,
  bookThroughDate: true,
  minNights: true,
  maxNights: true,
  minEligibleAmountMinor: true,
  appliesToAllRatePlans: true,
  appliesToAllRoomTypes: true,
  maxRedemptions: true,
  redeemedCount: true,
  createdAt: true,
  updatedAt: true,
  ratePlans: {
    select: { ratePlanId: true, ratePlan: { select: { code: true, name: true } } },
    orderBy: [{ ratePlan: { code: 'asc' } }],
  },
  roomTypes: {
    select: { roomTypeId: true, roomType: { select: { code: true, name: true } } },
    orderBy: [{ roomType: { sortOrder: 'asc' } }, { roomType: { code: 'asc' } }],
  },
  codes: {
    select: {
      id: true,
      code: true,
      codeNormalized: true,
      isActive: true,
      expiresOn: true,
      maxRedemptions: true,
      redeemedCount: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ codeNormalized: 'asc' }],
  },
} satisfies Prisma.PromotionSelect;

export type DiscountKind = 'PERCENT' | 'FIXED_PER_NIGHT';

export interface PromoCodeRow {
  id: string;
  code: string;
  codeNormalized: string;
  isActive: boolean;
  expiresOn: string | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromotionRow {
  id: string;
  name: string;
  description: string | null;
  discountKind: DiscountKind;
  discountValue: number;
  priority: number;
  isActive: boolean;
  stayFromDate: string | null;
  stayThroughDate: string | null;
  bookFromDate: string | null;
  bookThroughDate: string | null;
  minNights: number | null;
  maxNights: number | null;
  minEligibleAmountMinor: number | null;
  appliesToAllRatePlans: boolean;
  appliesToAllRoomTypes: boolean;
  maxRedemptions: number | null;
  redeemedCount: number;
  createdAt: Date;
  updatedAt: Date;
  ratePlans: { id: string; code: string; name: string }[];
  roomTypes: { id: string; code: string; name: string }[];
  codes: PromoCodeRow[];
}

export interface PromotionWriteInput {
  name?: string;
  description?: string | null;
  discountKind?: DiscountKind;
  discountValue?: number;
  priority?: number;
  isActive?: boolean;
  stayFromDate?: string | null;
  stayThroughDate?: string | null;
  bookFromDate?: string | null;
  bookThroughDate?: string | null;
  minNights?: number | null;
  maxNights?: number | null;
  minEligibleAmountMinor?: number | null;
  appliesToAllRatePlans?: boolean;
  appliesToAllRoomTypes?: boolean;
  maxRedemptions?: number | null;
  updatedByUserId?: string;
}

/** `@db.Date` to `YYYY-MM-DD`, the only conversion site. */
function toCalendarDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` to the UTC-midnight instant a `@db.Date` column wants. */
function toDateColumn(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

function toCodeRow(row: {
  id: string;
  code: string;
  codeNormalized: string;
  isActive: boolean;
  expiresOn: Date | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  createdAt: Date;
  updatedAt: Date;
}): PromoCodeRow {
  return {
    id: row.id,
    code: row.code,
    codeNormalized: row.codeNormalized,
    isActive: row.isActive,
    expiresOn: toCalendarDate(row.expiresOn),
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type RawPromotion = Prisma.PromotionGetPayload<{ select: typeof PROMOTION_SELECT }>;

function toRow(row: RawPromotion): PromotionRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    discountKind: row.discountKind,
    discountValue: row.discountValue,
    priority: row.priority,
    isActive: row.isActive,
    stayFromDate: toCalendarDate(row.stayFromDate),
    stayThroughDate: toCalendarDate(row.stayThroughDate),
    bookFromDate: toCalendarDate(row.bookFromDate),
    bookThroughDate: toCalendarDate(row.bookThroughDate),
    minNights: row.minNights,
    maxNights: row.maxNights,
    minEligibleAmountMinor: row.minEligibleAmountMinor,
    appliesToAllRatePlans: row.appliesToAllRatePlans,
    appliesToAllRoomTypes: row.appliesToAllRoomTypes,
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ratePlans: row.ratePlans.map((link) => ({
      id: link.ratePlanId,
      code: link.ratePlan.code,
      name: link.ratePlan.name,
    })),
    roomTypes: row.roomTypes.map((link) => ({
      id: link.roomTypeId,
      code: link.roomType.code,
      name: link.roomType.name,
    })),
    codes: row.codes.map(toCodeRow),
  };
}

/**
 * Translates a `P2002`/`P2003` into the typed error the caller should see.
 *
 * A unique violation is either the per-property promotion name or the
 * per-property normalised code. A foreign-key violation, by the time the
 * service has validated ownership, means a rate plan or room type removed
 * between the check and the write.
 */
function translateWriteFailure(error: unknown, name: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const target = JSON.stringify(error.meta?.['target'] ?? '');
      if (target.includes('codeNormalized')) {
        // The VALUE is deliberately not echoed. A promo code is a bearer
        // secret of sorts, and the scope forbids logging raw codes; an error
        // body is a log somebody will read.
        throw new DuplicateIdentifierError('promo code', 'code', '');
      }
      throw new DuplicateIdentifierError('promotion', 'name', name);
    }
    if (error.code === 'P2003' || error.code === 'P2025') {
      throw new ValidationFailedError({
        ratePlanIds: 'One of those rate plans or room types no longer exists at this property.',
      });
    }
  }
  throw error;
}

@Injectable()
export class PromotionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    propertyId: string,
    filter: { status: 'all' | 'active' | 'inactive'; search?: string },
  ): Promise<PromotionRow[]> {
    const rows = await this.prisma.client.promotion.findMany({
      where: {
        propertyId,
        ...(filter.status === 'all' ? {} : { isActive: filter.status === 'active' }),
        ...(filter.search === undefined || filter.search.length === 0
          ? {}
          : { name: { contains: filter.search, mode: 'insensitive' } }),
      },
      select: PROMOTION_SELECT,
      // Precedence order, so a list reads the way the selector decides.
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });

    return rows.map(toRow);
  }

  /**
   * One promotion, scoped by `propertyId` in the SAME predicate as the id.
   *
   * Not `findUnique` on the id alone followed by a property comparison: a
   * lookup that can find another property's row and then reject it has already
   * confirmed that row exists. Not found is the only correct answer (3.2).
   */
  async findOne(propertyId: string, promotionId: string): Promise<PromotionRow | null> {
    const row = await this.prisma.client.promotion.findFirst({
      where: { id: promotionId, propertyId },
      select: PROMOTION_SELECT,
    });

    return row === null ? null : toRow(row);
  }

  /**
   * Every promotion of a property, for eligibility evaluation and for
   * write-time conflict detection.
   *
   * Inactive ones are included: a preview reports why they did not apply, and
   * activating one must be checked against what is already active.
   */
  async findAllForEvaluation(propertyId: string): Promise<PromotionRow[]> {
    const rows = await this.prisma.client.promotion.findMany({
      where: { propertyId },
      select: PROMOTION_SELECT,
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });

    return rows.map(toRow);
  }

  /**
   * Create a promotion with its applicability links, in one transaction.
   *
   * A promotion and the sets it applies to are one fact. Creating the row and
   * then inserting links separately would leave a promotion applying to
   * nothing if the process died between them -- which is exactly the state the
   * service refuses to allow.
   */
  async create(
    propertyId: string,
    input: Required<
      Pick<
        PromotionWriteInput,
        | 'name'
        | 'discountKind'
        | 'discountValue'
        | 'priority'
        | 'appliesToAllRatePlans'
        | 'appliesToAllRoomTypes'
      >
    > &
      PromotionWriteInput,
    ratePlanIds: readonly string[],
    roomTypeIds: readonly string[],
    createdByUserId: string,
  ): Promise<PromotionRow> {
    try {
      const created = await this.prisma.client.$transaction(async (tx) =>
        tx.promotion.create({
          data: {
            propertyId,
            name: input.name,
            description: input.description ?? null,
            discountKind: input.discountKind,
            discountValue: input.discountValue,
            priority: input.priority,
            stayFromDate: toDateColumn(input.stayFromDate ?? null) ?? null,
            stayThroughDate: toDateColumn(input.stayThroughDate ?? null) ?? null,
            bookFromDate: toDateColumn(input.bookFromDate ?? null) ?? null,
            bookThroughDate: toDateColumn(input.bookThroughDate ?? null) ?? null,
            minNights: input.minNights ?? null,
            maxNights: input.maxNights ?? null,
            minEligibleAmountMinor: input.minEligibleAmountMinor ?? null,
            appliesToAllRatePlans: input.appliesToAllRatePlans,
            appliesToAllRoomTypes: input.appliesToAllRoomTypes,
            maxRedemptions: input.maxRedemptions ?? null,
            createdByUserId,
            ratePlans: {
              create: ratePlanIds.map((ratePlanId) => ({ propertyId, ratePlanId })),
            },
            roomTypes: {
              create: roomTypeIds.map((roomTypeId) => ({ propertyId, roomTypeId })),
            },
          },
          select: PROMOTION_SELECT,
        }),
      );

      return toRow(created);
    } catch (error) {
      translateWriteFailure(error, input.name);
    }
  }

  /**
   * Update a promotion, and optionally replace either applicability set.
   *
   * ===========================================================================
   * THE REPLACE IS A DIFF, not a delete-then-reinsert, for the same reason F2's
   * assignment replace and F3's price replace are: a link that survives keeps
   * its identity and its `createdAt`, and only a genuinely removed target is
   * deleted. It also avoids a window in which the promotion applies to nothing,
   * which no constraint forbids but which no reader should ever observe.
   * ===========================================================================
   */
  async update(
    propertyId: string,
    promotionId: string,
    input: PromotionWriteInput,
    ratePlanIds: readonly string[] | undefined,
    roomTypeIds: readonly string[] | undefined,
  ): Promise<PromotionRow | null> {
    try {
      const found = await this.prisma.client.$transaction(async (tx) => {
        const data = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.discountKind === undefined ? {} : { discountKind: input.discountKind }),
          ...(input.discountValue === undefined ? {} : { discountValue: input.discountValue }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          ...(input.stayFromDate === undefined
            ? {}
            : { stayFromDate: toDateColumn(input.stayFromDate) ?? null }),
          ...(input.stayThroughDate === undefined
            ? {}
            : { stayThroughDate: toDateColumn(input.stayThroughDate) ?? null }),
          ...(input.bookFromDate === undefined
            ? {}
            : { bookFromDate: toDateColumn(input.bookFromDate) ?? null }),
          ...(input.bookThroughDate === undefined
            ? {}
            : { bookThroughDate: toDateColumn(input.bookThroughDate) ?? null }),
          ...(input.minNights === undefined ? {} : { minNights: input.minNights }),
          ...(input.maxNights === undefined ? {} : { maxNights: input.maxNights }),
          ...(input.minEligibleAmountMinor === undefined
            ? {}
            : { minEligibleAmountMinor: input.minEligibleAmountMinor }),
          ...(input.appliesToAllRatePlans === undefined
            ? {}
            : { appliesToAllRatePlans: input.appliesToAllRatePlans }),
          ...(input.appliesToAllRoomTypes === undefined
            ? {}
            : { appliesToAllRoomTypes: input.appliesToAllRoomTypes }),
          ...(input.maxRedemptions === undefined ? {} : { maxRedemptions: input.maxRedemptions }),
          ...(input.updatedByUserId === undefined
            ? {}
            : { updatedByUserId: input.updatedByUserId }),
        };

        if (Object.keys(data).length > 0) {
          const updated = await tx.promotion.updateMany({
            where: { id: promotionId, propertyId },
            data,
          });
          if (updated.count === 0) return false;
        } else {
          const exists = await tx.promotion.count({ where: { id: promotionId, propertyId } });
          if (exists === 0) return false;
        }

        if (ratePlanIds !== undefined) {
          const existing = await tx.promotionRatePlan.findMany({
            where: { propertyId, promotionId },
            select: { ratePlanId: true },
          });
          const keep = new Set(ratePlanIds);
          const removed = existing
            .filter((row) => !keep.has(row.ratePlanId))
            .map((row) => row.ratePlanId);
          const present = new Set(existing.map((row) => row.ratePlanId));

          if (removed.length > 0) {
            await tx.promotionRatePlan.deleteMany({
              where: { propertyId, promotionId, ratePlanId: { in: removed } },
            });
          }
          const added = ratePlanIds.filter((id) => !present.has(id));
          if (added.length > 0) {
            await tx.promotionRatePlan.createMany({
              data: added.map((ratePlanId) => ({ propertyId, promotionId, ratePlanId })),
            });
          }
        }

        if (roomTypeIds !== undefined) {
          const existing = await tx.promotionRoomType.findMany({
            where: { propertyId, promotionId },
            select: { roomTypeId: true },
          });
          const keep = new Set(roomTypeIds);
          const removed = existing
            .filter((row) => !keep.has(row.roomTypeId))
            .map((row) => row.roomTypeId);
          const present = new Set(existing.map((row) => row.roomTypeId));

          if (removed.length > 0) {
            await tx.promotionRoomType.deleteMany({
              where: { propertyId, promotionId, roomTypeId: { in: removed } },
            });
          }
          const added = roomTypeIds.filter((id) => !present.has(id));
          if (added.length > 0) {
            await tx.promotionRoomType.createMany({
              data: added.map((roomTypeId) => ({ propertyId, promotionId, roomTypeId })),
            });
          }
        }

        return true;
      });

      if (!found) return null;
    } catch (error) {
      translateWriteFailure(error, input.name ?? '');
    }

    return this.findOne(propertyId, promotionId);
  }

  /**
   * Delete a promotion.
   *
   * Refuses when a redemption references it: a redemption is a financial
   * record, and deleting the promotion a stay was discounted under would
   * destroy the explanation of a charge. The composite foreign key is RESTRICT,
   * so the database agrees rather than taking this on trust -- but the count is
   * read first so the caller gets a typed refusal instead of a driver error.
   *
   * In F5 the count is always zero, because nothing writes redemptions until
   * F9. The check is here so it is correct when that changes.
   */
  async countRedemptions(propertyId: string, promotionId: string): Promise<number> {
    return this.prisma.client.promotionRedemption.count({
      where: { propertyId, promotionId },
    });
  }

  async remove(propertyId: string, promotionId: string): Promise<boolean> {
    const deleted = await this.prisma.client.promotion.deleteMany({
      where: { id: promotionId, propertyId },
    });

    return deleted.count > 0;
  }

  /* -- Promo codes -------------------------------------------------------- */

  async createCode(
    propertyId: string,
    promotionId: string,
    input: {
      code: string;
      codeNormalized: string;
      expiresOn: string | null;
      maxRedemptions: number | null;
    },
    createdByUserId: string,
  ): Promise<PromoCodeRow> {
    try {
      const created = await this.prisma.client.promoCode.create({
        data: {
          propertyId,
          promotionId,
          code: input.code,
          codeNormalized: input.codeNormalized,
          expiresOn: toDateColumn(input.expiresOn) ?? null,
          maxRedemptions: input.maxRedemptions,
          createdByUserId,
        },
        select: {
          id: true,
          code: true,
          codeNormalized: true,
          isActive: true,
          expiresOn: true,
          maxRedemptions: true,
          redeemedCount: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return toCodeRow(created);
    } catch (error) {
      translateWriteFailure(error, '');
    }
  }

  /** One code, scoped by property AND promotion in the same predicate. */
  async findCode(
    propertyId: string,
    promotionId: string,
    codeId: string,
  ): Promise<PromoCodeRow | null> {
    const row = await this.prisma.client.promoCode.findFirst({
      where: { id: codeId, propertyId, promotionId },
      select: {
        id: true,
        code: true,
        codeNormalized: true,
        isActive: true,
        expiresOn: true,
        maxRedemptions: true,
        redeemedCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return row === null ? null : toCodeRow(row);
  }

  async updateCode(
    propertyId: string,
    promotionId: string,
    codeId: string,
    input: { isActive?: boolean; expiresOn?: string | null },
  ): Promise<PromoCodeRow | null> {
    const updated = await this.prisma.client.promoCode.updateMany({
      where: { id: codeId, propertyId, promotionId },
      data: {
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.expiresOn === undefined
          ? {}
          : { expiresOn: toDateColumn(input.expiresOn) ?? null }),
      },
    });

    if (updated.count === 0) return null;

    return this.findCode(propertyId, promotionId, codeId);
  }

  async countCodeRedemptions(propertyId: string, codeId: string): Promise<number> {
    return this.prisma.client.promotionRedemption.count({
      where: { propertyId, promoCodeId: codeId },
    });
  }

  async removeCode(propertyId: string, promotionId: string, codeId: string): Promise<boolean> {
    const deleted = await this.prisma.client.promoCode.deleteMany({
      where: { id: codeId, propertyId, promotionId },
    });

    return deleted.count > 0;
  }

  /* -- Cross-table validation helpers ------------------------------------- */

  /** How many of `ratePlanIds` belong to this property and are not archived. */
  async countSelectableRatePlans(
    propertyId: string,
    ratePlanIds: readonly string[],
  ): Promise<number> {
    return this.prisma.client.ratePlan.count({
      where: {
        propertyId,
        id: { in: [...ratePlanIds] },
        // Archived plans cannot be newly selected (scope section 8).
        archivedAt: null,
      },
    });
  }

  /**
   * The room types actually assigned to the given rate plans.
   *
   * Used to enforce "a room type named by a promotion must be assigned to a
   * rate plan the promotion also names" -- a condition spanning three tables,
   * which no CHECK or foreign key can express.
   */
  async assignedRoomTypeIds(propertyId: string, ratePlanIds: readonly string[]): Promise<string[]> {
    const rows = await this.prisma.client.ratePlanRoomType.findMany({
      where: { propertyId, ratePlanId: { in: [...ratePlanIds] } },
      select: { roomTypeId: true },
      distinct: ['roomTypeId'],
    });

    return rows.map((row) => row.roomTypeId);
  }

  /** Every room type of the property, for the `appliesToAllRatePlans` case. */
  async allAssignedRoomTypeIds(propertyId: string): Promise<string[]> {
    const rows = await this.prisma.client.ratePlanRoomType.findMany({
      where: { propertyId },
      select: { roomTypeId: true },
      distinct: ['roomTypeId'],
    });

    return rows.map((row) => row.roomTypeId);
  }
}
