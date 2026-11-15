/**
 * Room blocks: withholding capacity from sale for a date range, and giving it
 * back.
 *
 * ===========================================================================
 * THE COUNTER MODEL. A block adds its contribution (1 for a named room, N for
 * a category count) to `inventory_day.blocked` on every night it covers, and a
 * release subtracts exactly that. `inventory_day_not_oversold`
 * (`sold + blocked <= physical + overbookingAllowance`) therefore makes a
 * blocked unit unsellable with no change to the booking path.
 *
 * A BLOCK NEVER EATS OVERBOOKING HEADROOM. The service requires
 * `physical - sold - blocked >= contribution` on each night -- stricter than
 * the CHECK, which would also allow spending `overbookingAllowance`. Blocking
 * a room for maintenance must withhold a real room, never convert a revenue
 * manager's deliberate overbooking allowance into a phantom one.
 *
 * RELEASE IS THE DANGEROUS DIRECTION. The CHECK only looks upward, so a
 * decrement that ran twice would silently invent a room (section 3.1.1). The
 * release therefore locks the block row first and treats an already-released
 * block as an idempotent success that touches nothing, and it refuses -- whole,
 * not partially -- if any night's row is missing or holds less than the block
 * contributed.
 *
 * KNOWN LIMITATION (accepted, recorded as F1 in the DTO). A specific-room
 * block and a concurrent check-in or same-category room move share no lock:
 * neither of those paths touches `inventory_day`. Both can commit, leaving a
 * guest assigned to a blocked room. Creating a reservation with a room DOES
 * lock the same `inventory_day` rows, so that pair is serialised. Capacity
 * stays correct in every case; only the named-room assignment can collide.
 *
 * No past-date floor is applied: no running code advances
 * `property.businessDate` (limitation C1), so there is nothing honest to
 * compare against.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Permission,
  type CreateRoomBlockRequest,
  type RoomBlockListQuery,
  type RoomBlockListResponse,
  type RoomBlockView,
} from '@repo/types';

import {
  DomainError,
  InventoryNotConfiguredError,
  RoomUnavailableError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { isLockTimeout, sqlState } from '../../common/errors/sql-state.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import {
  contributionPerNight,
  enumerateNights,
  evaluateRange,
  nightCountInclusive,
  toExclusiveEnd,
  toInclusiveEnd,
  type BlockShape,
} from './room-block.policy.js';
import { RoomBlockRepository, type RoomBlockRow } from './room-block.repository.js';

const MAX_ATTEMPTS = 3;

/** A malformed id names no block; answered as not-found, never as a 500 from the uuid cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only what Postgres has already rolled back. `23514` / `23P01` are not here:
 * under the inventory lock the service has checked capacity and overlap
 * itself, so a constraint firing means the counters disagree with reality,
 * which a retry cannot fix (the same reasoning as cancellation).
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

@Injectable()
export class RoomBlockService {
  private readonly logger = new Logger(RoomBlockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RoomBlockRepository,
    private readonly clock: ClockService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /*  Read                                                                  */
  /* ---------------------------------------------------------------------- */

  async list(
    userId: string,
    codeOrId: string,
    query: RoomBlockListQuery,
  ): Promise<RoomBlockListResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RESERVATIONS_READ);
    const rows = await this.repository.list(property.id, query);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toView),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(userId: string, codeOrId: string, blockId: string): Promise<RoomBlockView> {
    const property = await this.authorise(userId, codeOrId, Permission.RESERVATIONS_READ);
    if (!UUID.test(blockId)) throw new TenantScopeViolationError('Room block');
    const row = await this.repository.findById(property.id, blockId);
    if (row === null) throw new TenantScopeViolationError('Room block');
    return toView(row);
  }

  /* ---------------------------------------------------------------------- */
  /*  Create                                                                */
  /* ---------------------------------------------------------------------- */

  async create(
    userId: string,
    codeOrId: string,
    request: CreateRoomBlockRequest,
  ): Promise<RoomBlockView> {
    const property = await this.authorise(userId, codeOrId, Permission.ROOM_BLOCKS_MANAGE);

    const range = evaluateRange(request.fromDate, request.throughDate);
    if (!range.ok) {
      const refusal = range.refusal;
      throw new ValidationFailedError(
        refusal.kind === 'MALFORMED'
          ? { [refusal.field]: 'Expected a real calendar date in YYYY-MM-DD form.' }
          : refusal.kind === 'INVERTED'
            ? { throughDate: 'The last night cannot fall before the first.' }
            : {
                throughDate:
                  `That range is ${String(refusal.dayCount)} nights. ` +
                  `A single block may cover at most ${String(refusal.max)}.`,
              },
      );
    }
    const nights = range.nights;

    if (!(await this.repository.roomTypeExists(property.id, request.roomTypeId))) {
      throw new TenantScopeViolationError('Room type');
    }

    let shape: BlockShape;
    if (request.roomId !== undefined) {
      const room = await this.repository.findRoom(property.id, request.roomId);
      if (room === null) throw new TenantScopeViolationError('Room');
      if (room.roomTypeId !== request.roomTypeId) {
        throw new ValidationFailedError({
          roomId: 'That room does not belong to the selected room type.',
        });
      }
      shape = { kind: 'SPECIFIC_ROOM', roomId: room.id };
    } else {
      shape = { kind: 'CATEGORY', rooms: request.rooms ?? 1 };
    }

    const contribution = contributionPerNight(shape);
    const throughExclusive = toExclusiveEnd(request.throughDate);

    const row = await this.withRetry('room block', () =>
      this.repository.inTransaction(property.id, async (tx) => {
        const locked = await this.repository.lockNights(
          tx,
          property.id,
          request.roomTypeId,
          nights,
        );

        if (locked.length !== nights.length) {
          throw new InventoryNotConfiguredError({
            nightsRequested: nights.length,
            nightsConfigured: locked.length,
            firstNight: nights[0],
            lastNight: nights.at(-1),
          });
        }

        // Real rooms only: overbooking allowance is deliberately excluded.
        const short = locked.find(
          (night) => night.physical - night.sold - night.blocked < contribution,
        );
        if (short !== undefined) {
          throw new RoomUnavailableError({
            reason: 'Not enough unsold rooms of that type to block on this night.',
            stayDate: short.stayDate,
            unsoldRooms: Math.max(0, short.physical - short.sold - short.blocked),
            requested: contribution,
          });
        }

        if (shape.kind === 'SPECIFIC_ROOM') {
          const alreadyBlocked = await this.repository.findOverlappingRoomBlocks(
            tx,
            property.id,
            shape.roomId,
            request.fromDate,
            throughExclusive,
          );
          if (alreadyBlocked > 0) {
            throw new RoomUnavailableError({
              reason: 'That room is already blocked on one of these nights.',
            });
          }

          const stays = await this.repository.findOverlappingStays(
            tx,
            property.id,
            shape.roomId,
            request.fromDate,
            throughExclusive,
          );
          const first = stays[0];
          if (first !== undefined) {
            throw new RoomUnavailableError({
              reason:
                'That room has a stay on these nights. Move the guest to another room ' +
                'before blocking it.',
              conflictsWith: first.confirmationCode,
            });
          }
        }

        const touched = await this.repository.adjustBlocked(
          tx,
          property.id,
          request.roomTypeId,
          nights,
          contribution,
        );
        if (touched !== nights.length) {
          // Impossible under the lock; refusing keeps the counters honest.
          throw new ValidationFailedError({
            inventory: `Expected to update ${String(nights.length)} night(s), updated ${String(touched)}.`,
          });
        }

        const created = await this.repository.insertBlock(tx, {
          propertyId: property.id,
          roomTypeId: request.roomTypeId,
          roomId: shape.kind === 'SPECIFIC_ROOM' ? shape.roomId : null,
          rooms: contribution,
          fromDate: request.fromDate,
          throughExclusive,
          reason: request.reason,
          note: request.note ?? null,
          createdByUserId: userId,
        });

        // Same transaction as the counter it moved (section 3.4).
        await this.repository.audit(tx, {
          propertyId: property.id,
          actorUserId: userId,
          event: 'ROOM_BLOCK_CREATED',
          blockId: created.id,
          before: null,
          after: {
            roomTypeId: created.roomTypeId,
            roomId: created.roomId,
            rooms: created.rooms,
            fromDate: created.fromDate,
            throughDate: request.throughDate,
            nightCount: nights.length,
            reason: created.reason,
            blockedDelta: contribution,
          },
        });

        return created;
      }),
    );

    this.logger.log(
      `Room block ${row.id} created for property ${property.id}: ` +
        `${String(contribution)} unit(s) x ${String(nights.length)} night(s)`,
    );
    return toView(row);
  }

  /* ---------------------------------------------------------------------- */
  /*  Release                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Give the capacity back. Idempotent: releasing a released block returns it
   * unchanged and moves no counter.
   */
  async release(userId: string, codeOrId: string, blockId: string): Promise<RoomBlockView> {
    const property = await this.authorise(userId, codeOrId, Permission.ROOM_BLOCKS_MANAGE);
    if (!UUID.test(blockId)) throw new TenantScopeViolationError('Room block');

    const outcome = await this.withRetry('room block release', () =>
      this.repository.inTransaction(property.id, async (tx) => {
        // Block row FIRST, then inventory (section 3.1.1).
        const lockedBlock = await this.repository.lockBlock(tx, property.id, blockId);
        if (lockedBlock === null) throw new TenantScopeViolationError('Room block');

        const block = await this.repository.readLockedBlock(tx, property.id, blockId);
        if (lockedBlock.status === 'RELEASED') {
          return { row: block, released: false };
        }

        const nights = enumerateNights(block.fromDate, toInclusiveEnd(block.throughDateExclusive));
        const locked = await this.repository.lockNights(tx, property.id, block.roomTypeId, nights);

        if (locked.length !== nights.length) {
          throw new ValidationFailedError({
            inventory:
              'Inventory is missing for some nights of this block, so it cannot be released. ' +
              `Expected ${String(nights.length)} row(s), found ${String(locked.length)}.`,
          });
        }

        const short = locked.find((night) => night.blocked < block.rooms);
        if (short !== undefined) {
          throw new ValidationFailedError({
            inventory:
              `The blocked counter for ${short.stayDate} is ${String(short.blocked)}, ` +
              `less than the ${String(block.rooms)} unit(s) this block holds. The counters ` +
              'and the blocks disagree and need reconciling before this block can be released.',
          });
        }

        const touched = await this.repository.adjustBlocked(
          tx,
          property.id,
          block.roomTypeId,
          nights,
          -block.rooms,
        );
        if (touched !== nights.length) {
          throw new ValidationFailedError({
            inventory: `Expected to update ${String(nights.length)} night(s), updated ${String(touched)}.`,
          });
        }

        const released = await this.repository.markReleased(
          tx,
          property.id,
          blockId,
          userId,
          this.clock.now(),
        );

        await this.repository.audit(tx, {
          propertyId: property.id,
          actorUserId: userId,
          event: 'ROOM_BLOCK_RELEASED',
          blockId,
          before: { status: 'ACTIVE' },
          after: {
            status: 'RELEASED',
            roomTypeId: block.roomTypeId,
            roomId: block.roomId,
            fromDate: block.fromDate,
            nightCount: nights.length,
            blockedDelta: -block.rooms,
          },
        });

        return { row: released, released: true };
      }),
    );

    if (outcome.released) {
      this.logger.log(`Room block ${blockId} released for property ${property.id}`);
    }
    return toView(outcome.row);
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Bounded retry for transactions Postgres already aborted.
   *
   * A typed `DomainError` is rethrown BEFORE any SQLSTATE classification
   * (section 3.1.1): `sqlState()` falls back to reading the message text. A
   * lock timeout (`55P03`) is never retried -- the wait already happened.
   */
  private async withRetry<T>(operation: string, work: () => Promise<T>): Promise<T> {
    let lastState: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (isLockTimeout(error)) throw new TransactionConflictError(operation);

        const state = sqlState(error);
        if (state === null || !TRANSIENT_SQLSTATES.has(state)) throw error;

        lastState = state;
        if (attempt < MAX_ATTEMPTS) {
          const backoff = 25 * attempt + Math.floor(Math.random() * 50);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    this.logger.warn(
      `${operation} exhausted ${String(MAX_ATTEMPTS)} attempts on SQLSTATE ${String(lastState)}`,
    );
    throw new TransactionConflictError(operation);
  }

  /** Same order as every sibling: grant first (404), then permission (403). */
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

/** Persistence row to wire shape: inclusive end date, no `propertyId`. */
function toView(row: RoomBlockRow): RoomBlockView {
  const throughInclusive = toInclusiveEnd(row.throughDateExclusive);
  return {
    id: row.id,
    roomTypeId: row.roomTypeId,
    roomTypeCode: row.roomTypeCode,
    roomTypeName: row.roomTypeName,
    roomId: row.roomId,
    roomNumber: row.roomNumber,
    rooms: row.rooms,
    fromDate: row.fromDate as RoomBlockView['fromDate'],
    throughDate: throughInclusive as RoomBlockView['throughDate'],
    nightCount: nightCountInclusive(row.fromDate, throughInclusive),
    reason: row.reason,
    note: row.note,
    status: row.status,
    createdByUserId: row.createdByUserId,
    releasedByUserId: row.releasedByUserId,
    releasedAt: row.releasedAt === null ? null : row.releasedAt.toISOString(),
  };
}
