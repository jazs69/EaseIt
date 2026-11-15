/**
 * Per-night inventory: reading the counters, and setting the overbooking
 * allowance for a date range.
 *
 * ===========================================================================
 * OVERBOOKING IS A DELIBERATE, AUDITED DECISION (CLAUDE.md section 3.1): it is
 * only ever raised here, under `inventory:override`, with a reason recorded in
 * the same transaction. Nothing else writes `overbookingAllowance`.
 *
 * LOWERING IS REFUSED WHEN IT WOULD BREAK A PROMISE. If a night already has
 * `sold + blocked` above `physical + newAllowance`, those rooms are already
 * sold or withheld; the write is refused whole, naming the night, rather than
 * clamped or partially applied. `inventory_day_not_oversold` would reject the
 * write anyway -- this check exists to say *why* in a typed 400 instead.
 *
 * `physical` is deliberately not writable here: it is owned by the horizon
 * generator (room count at generation time, limitation L1). Taking a room out
 * of service for some nights is a room block, which keeps the reason and the
 * named room on record and is reversible.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  MAX_INVENTORY_DAYS_WINDOW,
  MAX_OVERBOOKING_RANGE_DAYS,
  Permission,
  type InventoryDaysQuery,
  type InventoryDaysResponse,
  type SetOverbookingAllowanceRequest,
  type SetOverbookingAllowanceResponse,
} from '@repo/types';

import {
  DomainError,
  InventoryNotConfiguredError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { isLockTimeout, sqlState } from '../../common/errors/sql-state.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InventoryDayRepository } from './inventory-day.repository.js';
import { enumerateNights, nightCountInclusive } from './room-block.policy.js';

const MAX_ATTEMPTS = 3;
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

function isRealDate(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

@Injectable()
export class InventoryDayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: InventoryDayRepository,
  ) {}

  async read(
    userId: string,
    codeOrId: string,
    query: InventoryDaysQuery,
  ): Promise<InventoryDaysResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RESERVATIONS_READ);
    this.requireRange(query.fromDate, query.toDate, 'toDate', MAX_INVENTORY_DAYS_WINDOW);

    if (!(await this.repository.roomTypeExists(property.id, query.roomTypeId))) {
      throw new TenantScopeViolationError('Room type');
    }

    const nights = await this.repository.readNights(
      property.id,
      query.roomTypeId,
      query.fromDate,
      query.toDate,
    );

    return {
      roomTypeId: query.roomTypeId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      days: nights.map((night) => ({
        ...night,
        sellable: night.physical + night.overbookingAllowance - night.sold - night.blocked,
      })),
    };
  }

  async setOverbookingAllowance(
    userId: string,
    codeOrId: string,
    request: SetOverbookingAllowanceRequest,
  ): Promise<SetOverbookingAllowanceResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.INVENTORY_OVERRIDE);
    this.requireRange(
      request.fromDate,
      request.throughDate,
      'throughDate',
      MAX_OVERBOOKING_RANGE_DAYS,
    );

    if (!(await this.repository.roomTypeExists(property.id, request.roomTypeId))) {
      throw new TenantScopeViolationError('Room type');
    }

    const nights = enumerateNights(request.fromDate, request.throughDate);

    const updated = await this.withRetry(() =>
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

        const broken = locked.find(
          (night) => night.sold + night.blocked > night.physical + request.allowance,
        );
        if (broken !== undefined) {
          const minimum = broken.sold + broken.blocked - broken.physical;
          throw new ValidationFailedError({
            allowance:
              `On ${broken.stayDate}, ${String(broken.sold)} room(s) are sold and ` +
              `${String(broken.blocked)} blocked against ${String(broken.physical)} ` +
              `physical, so the allowance cannot go below ${String(minimum)} for that night.`,
          });
        }

        const count = await this.repository.setAllowance(
          tx,
          property.id,
          request.roomTypeId,
          nights,
          request.allowance,
        );
        if (count !== nights.length) {
          throw new ValidationFailedError({
            inventory: `Expected to update ${String(nights.length)} night(s), updated ${String(count)}.`,
          });
        }

        // Only nights whose value actually changed are worth an auditor's time.
        const changed = locked.filter((night) => night.overbookingAllowance !== request.allowance);

        await this.repository.audit(tx, {
          propertyId: property.id,
          actorUserId: userId,
          roomTypeId: request.roomTypeId,
          reason: request.reason,
          before: {
            nights: changed.map((night) => ({
              stayDate: night.stayDate,
              overbookingAllowance: night.overbookingAllowance,
            })),
          },
          after: {
            roomTypeId: request.roomTypeId,
            fromDate: request.fromDate,
            throughDate: request.throughDate,
            allowance: request.allowance,
            nightCount: nights.length,
            nightsChanged: changed.length,
          },
        });

        return count;
      }),
    );

    return {
      roomTypeId: request.roomTypeId,
      fromDate: request.fromDate,
      throughDate: request.throughDate,
      allowance: request.allowance,
      nightsUpdated: updated,
    };
  }

  /* ---------------------------------------------------------------------- */

  private requireRange(from: string, to: string, field: string, max: number): void {
    if (!isRealDate(from)) {
      throw new ValidationFailedError({ fromDate: 'Expected a real calendar date.' });
    }
    if (!isRealDate(to)) {
      throw new ValidationFailedError({ [field]: 'Expected a real calendar date.' });
    }
    if (to < from) {
      throw new ValidationFailedError({ [field]: 'The end cannot fall before the start.' });
    }
    const days = nightCountInclusive(from, to);
    if (days > max) {
      throw new ValidationFailedError({
        [field]: `That range is ${String(days)} days. Ask for at most ${String(max)}.`,
      });
    }
  }

  /** Same contract as every inventory writer: DomainError first, 55P03 unretried. */
  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (isLockTimeout(error)) throw new TransactionConflictError('overbooking allowance');
        const state = sqlState(error);
        if (state === null || !TRANSIENT_SQLSTATES.has(state)) throw error;
        if (attempt >= MAX_ATTEMPTS) throw new TransactionConflictError('overbooking allowance');
        const backoff = 25 * attempt + Math.floor(Math.random() * 50);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

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
