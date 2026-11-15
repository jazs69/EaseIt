/**
 * Persistence for rate plans. No business rules live here (section 5).
 *
 * ===========================================================================
 * Every statement carries `propertyId` explicitly. There is no Prisma tenancy
 * extension and no row-level security in this repository -- section 3.2
 * describes both and neither is implemented -- so the predicate IS the tenancy
 * control, not a convenience on top of one.
 *
 * `select` is always explicit. A bare `findMany` would widen the response
 * contract silently the next time a column is added to `rate_plan`, and would
 * publish `propertyId` and `createdByUserId`.
 *
 * `P2002` is translated here, at the boundary, so a unique-constraint
 * violation reaches the caller as a typed conflict rather than as a driver
 * code (section 5). `P2003` -- a foreign-key violation -- is translated too:
 * it is what a room type belonging to another property produces once the
 * composite foreign key refuses it, and it must not surface as a 500.
 *
 * WHY THE WRITES ARE TRANSACTIONAL. A plan and its room-type links are one
 * fact. Creating the row and then inserting links in a second statement would
 * leave a plan applying to nothing if the process died between them -- and a
 * plan with no categories is exactly the state the DTO refuses to let a client
 * create. Replacing the set is the same argument: delete-then-insert must not
 * be observable halfway through.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import {
  DuplicateIdentifierError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The columns every read of a rate plan returns.
 *
 * `satisfies` rather than `as const`, which is what the sibling selects in
 * `room-type.repository.ts` use. The difference matters here and only here:
 * this select nests an `orderBy` **array**, and `as const` would make that
 * array `readonly`, which Prisma's generated input types reject outright. The
 * `satisfies` still checks every key against the real model, so a column
 * renamed in the schema still fails the build.
 */
const RATE_PLAN_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  kind: true,
  currency: true,
  isActive: true,
  archivedAt: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  roomTypes: {
    select: {
      roomTypeId: true,
      // F2: the price lives on the assignment, one value per category.
      defaultRateMinor: true,
      baseOccupancy: true,
      roomType: { select: { code: true, name: true } },
      // How many nights this category is deliberately priced away from its
      // default. Surfaced so the UI can warn before an assignment is removed
      // -- that cascades these rows away and is not recoverable.
      _count: { select: { days: true } },
    },
    // Stable order, so two reads of the same plan render identically and a
    // diff in a test or an audit payload means something changed.
    orderBy: [{ roomType: { sortOrder: 'asc' } }, { roomType: { code: 'asc' } }],
  },
} satisfies Prisma.RatePlanSelect;

export interface RatePlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: 'STANDARD' | 'CORPORATE' | 'PACKAGE' | 'PROMOTIONAL' | 'COMPLIMENTARY';
  currency: string;
  isActive: boolean;
  archivedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  roomTypes: {
    roomTypeId: string;
    defaultRateMinor: number;
    baseOccupancy: number;
    roomType: { code: string; name: string };
    _count: { days: number };
  }[];
}

export interface RatePlanFilter {
  status: 'all' | 'active' | 'inactive' | 'archived';
  kind?: RatePlanRow['kind'];
  search?: string;
  roomTypeId?: string;
}

/** One room-type assignment with its own price. */
export interface AssignmentInput {
  roomTypeId: string;
  defaultRateMinor: number;
  baseOccupancy: number;
}

export interface CreateRatePlanInput {
  code: string;
  name: string;
  description: string | null;
  kind: RatePlanRow['kind'];
  currency: string;
  sortOrder: number;
  createdByUserId: string;
  roomTypes: AssignmentInput[];
}

export interface UpdateRatePlanInput {
  name?: string;
  description?: string | null;
  kind?: RatePlanRow['kind'];
  sortOrder?: number;
}

/**
 * Which unique constraint a `P2002` came from, mapped to the field a form
 * would mark. Read from `meta.target`, which Prisma populates with the
 * constraint or column names.
 */
function duplicateField(error: Prisma.PrismaClientKnownRequestError): 'code' | 'name' {
  const target = JSON.stringify(error.meta?.['target'] ?? '');
  return target.includes('name') ? 'name' : 'code';
}

/**
 * Turns a `P2002`/`P2003` into the typed error the caller should see.
 *
 * A foreign-key failure on these tables has exactly one reachable cause by the
 * time the service has validated ownership: a room type that was deleted
 * between the check and the write. Reported against `roomTypeIds` so the form
 * marks the right control, rather than as a conflict about the plan itself.
 */
function translateWriteFailure(error: unknown, code: string, name: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const field = duplicateField(error);
      throw new DuplicateIdentifierError('rate plan', field, field === 'name' ? name : code);
    }
    if (error.code === 'P2003' || error.code === 'P2025') {
      throw new ValidationFailedError({
        roomTypeIds: 'One of those room types no longer exists at this property.',
      });
    }
  }
  throw error;
}

@Injectable()
export class RatePlanRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(propertyId: string, filter: RatePlanFilter): Promise<RatePlanRow[]> {
    return this.prisma.client.ratePlan.findMany({
      where: {
        propertyId,
        ...statusWhere(filter.status),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        // `some` rather than a join predicate: a plan matches when ANY of its
        // links names this category, and the link row's own `propertyId` is
        // scoped too so the filter cannot reach across properties even if an
        // id from elsewhere is supplied.
        ...(filter.roomTypeId === undefined
          ? {}
          : { roomTypes: { some: { propertyId, roomTypeId: filter.roomTypeId } } }),
        ...(filter.search === undefined || filter.search.length === 0
          ? {}
          : {
              OR: [
                { code: { contains: filter.search, mode: 'insensitive' } },
                { name: { contains: filter.search, mode: 'insensitive' } },
              ],
            }),
      },
      select: RATE_PLAN_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  /**
   * One rate plan, scoped by `propertyId` in the SAME predicate as the id.
   *
   * Not `findUnique` on the id alone followed by a property comparison: a
   * lookup that can find another property's row and then reject it has already
   * confirmed that row exists. Not found is the only correct answer (3.2).
   */
  async findOne(propertyId: string, ratePlanId: string): Promise<RatePlanRow | null> {
    return this.prisma.client.ratePlan.findFirst({
      where: { id: ratePlanId, propertyId },
      select: RATE_PLAN_SELECT,
    });
  }

  /**
   * How many of `roomTypeIds` actually belong to this property.
   *
   * Counted rather than fetched: the service only needs to know whether the
   * set is wholly owned, and a count cannot accidentally be returned to a
   * caller. The composite foreign key would refuse a foreign id anyway; this
   * exists so the refusal is a 400 naming the field rather than a translated
   * driver error.
   */
  async countOwnedRoomTypes(propertyId: string, roomTypeIds: string[]): Promise<number> {
    return this.prisma.client.roomType.count({
      where: { propertyId, id: { in: roomTypeIds } },
    });
  }

  async create(propertyId: string, input: CreateRatePlanInput): Promise<RatePlanRow> {
    const { roomTypes, ...plan } = input;

    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.ratePlan.create({
          data: {
            propertyId,
            ...plan,
            // Nested create, so the assignments land in the same transaction
            // as the plan. `propertyId` is stamped on every row explicitly --
            // it is what the composite foreign key checks against.
            roomTypes: {
              create: roomTypes.map((entry) => ({
                propertyId,
                roomTypeId: entry.roomTypeId,
                defaultRateMinor: entry.defaultRateMinor,
                baseOccupancy: entry.baseOccupancy,
              })),
            },
          },
          select: RATE_PLAN_SELECT,
        });

        return created;
      });
    } catch (error) {
      translateWriteFailure(error, input.code, input.name);
    }
  }

  /**
   * Update, returning null when the row is not this property's.
   *
   * `updateMany` with both predicates rather than `update` on the id: a
   * zero-count result is indistinguishable from "no such row", which is what
   * a caller without a grant must be told.
   *
   * `roomTypes` undefined leaves the assignments alone; supplied, it becomes
   * exactly the set sent, applied inside the same transaction as the field
   * update.
   *
   * ===========================================================================
   * THE REPLACE IS A DIFF, NOT A DELETE-THEN-REINSERT, and this is the single
   * most consequential detail in the file.
   *
   * `rate_plan_day` cascades from the assignment. So a delete-all followed by
   * an insert-all -- which is what F1 did, when there were no day rows to lose
   * -- would destroy EVERY date-wise override on every category each time an
   * operator edited a plan's name. The overrides would be gone before the
   * reinsert, and nothing would report it.
   *
   * Diffing instead means:
   *   * an assignment present in both sets keeps its row, and therefore keeps
   *     its calendar, with only its price updated if it changed;
   *   * an assignment genuinely removed loses its calendar, which is the
   *     correct meaning of "this plan no longer prices that category" -- and
   *     the service makes the caller acknowledge it first;
   *   * a newly added assignment starts with no overrides, as it should.
   * ===========================================================================
   */
  async update(
    propertyId: string,
    ratePlanId: string,
    input: UpdateRatePlanInput,
    roomTypes: AssignmentInput[] | undefined,
  ): Promise<RatePlanRow | null> {
    try {
      const found = await this.prisma.client.$transaction(async (tx) => {
        if (Object.keys(input).length > 0) {
          const updated = await tx.ratePlan.updateMany({
            where: { id: ratePlanId, propertyId },
            data: input,
          });
          if (updated.count === 0) return false;
        } else {
          // Only the assignments are changing, so existence still has to be
          // established inside this transaction rather than assumed from a
          // read the service took earlier.
          const exists = await tx.ratePlan.count({ where: { id: ratePlanId, propertyId } });
          if (exists === 0) return false;
        }

        if (roomTypes !== undefined) {
          const existing = await tx.ratePlanRoomType.findMany({
            where: { propertyId, ratePlanId },
            select: { roomTypeId: true, defaultRateMinor: true, baseOccupancy: true },
          });

          const keep = new Set(roomTypes.map((entry) => entry.roomTypeId));
          const before = new Map(existing.map((row) => [row.roomTypeId, row]));

          const removed = existing
            .filter((row) => !keep.has(row.roomTypeId))
            .map((row) => row.roomTypeId);

          if (removed.length > 0) {
            // Cascades the removed categories' `rate_plan_day` rows with them.
            await tx.ratePlanRoomType.deleteMany({
              where: { propertyId, ratePlanId, roomTypeId: { in: removed } },
            });
          }

          for (const entry of roomTypes) {
            const current = before.get(entry.roomTypeId);

            if (current === undefined) {
              await tx.ratePlanRoomType.create({
                data: {
                  propertyId,
                  ratePlanId,
                  roomTypeId: entry.roomTypeId,
                  defaultRateMinor: entry.defaultRateMinor,
                  baseOccupancy: entry.baseOccupancy,
                },
              });
              continue;
            }

            // Only write when something actually differs, so `updatedAt` on an
            // untouched assignment stays honest about when it last changed.
            if (
              current.defaultRateMinor !== entry.defaultRateMinor ||
              current.baseOccupancy !== entry.baseOccupancy
            ) {
              await tx.ratePlanRoomType.update({
                where: { ratePlanId_roomTypeId: { ratePlanId, roomTypeId: entry.roomTypeId } },
                data: {
                  defaultRateMinor: entry.defaultRateMinor,
                  baseOccupancy: entry.baseOccupancy,
                },
              });
            }
          }
        }

        return true;
      });

      if (!found) return null;
    } catch (error) {
      translateWriteFailure(error, '', input.name ?? '');
    }

    return this.findOne(propertyId, ratePlanId);
  }

  /**
   * Update ONE assignment's default rate, touching nothing else.
   *
   * Scoped by `propertyId` AND `ratePlanId` AND `roomTypeId` in one predicate,
   * so another property's assignment is not found rather than forbidden (3.2).
   * `updateMany` for the same reason the sibling writes use it: a zero count is
   * indistinguishable from "no such row", which is the only correct answer.
   *
   * It writes `rate_plan_room_type` only. `rate_plan_day` is not read or
   * touched, so every deliberately-priced night survives a default change --
   * requirement 5 of the scope, and a property of the model rather than of
   * this code: the default is the fallback for nights that have no override.
   */
  async updateAssignment(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    input: { defaultRateMinor?: number; baseOccupancy?: number },
  ): Promise<RatePlanRow | null> {
    const updated = await this.prisma.client.ratePlanRoomType.updateMany({
      where: { propertyId, ratePlanId, roomTypeId },
      data: input,
    });

    if (updated.count === 0) return null;

    return this.findOne(propertyId, ratePlanId);
  }

  /**
   * Set the status.
   *
   * `archivedAt` is passed explicitly rather than derived here, so the
   * database CHECK (`rate_plan_archived_implies_inactive`) and this write
   * cannot disagree about what archival means -- the service composes the pair
   * and this writes it.
   */
  async setStatus(
    propertyId: string,
    ratePlanId: string,
    status: { isActive: boolean; archivedAt: Date | null },
  ): Promise<RatePlanRow | null> {
    const updated = await this.prisma.client.ratePlan.updateMany({
      where: { id: ratePlanId, propertyId },
      data: status,
    });

    if (updated.count === 0) return null;

    return this.findOne(propertyId, ratePlanId);
  }
}

/**
 * Status filter.
 *
 * `active` and `inactive` both exclude archived plans: an archived plan is
 * inactive by construction, and folding it into `inactive` would make the
 * paused plans an operator is looking for impossible to find among the dead
 * ones. `all` genuinely means all.
 */
function statusWhere(status: RatePlanFilter['status']): Prisma.RatePlanWhereInput {
  switch (status) {
    case 'active':
      return { isActive: true, archivedAt: null };
    case 'inactive':
      return { isActive: false, archivedAt: null };
    case 'archived':
      return { archivedAt: { not: null } };
    case 'all':
      return {};
  }
}
