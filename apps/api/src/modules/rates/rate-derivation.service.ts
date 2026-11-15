/**
 * Derived (linked) rate plans (AV-06): link a plan to a parent, or unlink it.
 *
 * ===========================================================================
 * The PRICING of a derived plan lives in `RateCalendarService.baseNights`;
 * this service only maintains the link, and refuses every shape the pricing
 * cannot honour:
 *
 *   * parent missing or another property's            -> not-found (3.2)
 *   * plan or parent archived                          -> 409
 *   * parent is itself derived, or the plan is a parent -> 409 (one level)
 *   * plan derived from itself                          -> 400
 *   * a room type the plan sells that the parent does not price -> 400
 *   * currencies differ                                 -> 409
 *
 * Both plan rows are locked FOR UPDATE, in id order, before anything is
 * checked, so two requests cannot each make the other's plan its parent. No
 * reservation or inventory row is touched, so section 3.1.1 is not entered;
 * the lock wait is still bounded transaction-locally.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  Permission,
  type RatePlanDerivationView,
  type SetRatePlanDerivationRequest,
} from '@repo/types';

import {
  DomainError,
  InvalidStateTransitionError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { ROW_LOCK_TIMEOUT_MS, isLockTimeout } from '../../common/errors/sql-state.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PlanRow {
  id: string;
  code: string;
  currency: string;
  archivedAt: Date | null;
  parentRatePlanId: string | null;
}

@Injectable()
export class RateDerivationService {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
  ): Promise<RatePlanDerivationView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    return this.view(property.id, ratePlanId);
  }

  async set(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: SetRatePlanDerivationRequest,
  ): Promise<RatePlanDerivationView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    if (request.parentRatePlanId === ratePlanId) {
      throw new ValidationFailedError({
        parentRatePlanId: 'A plan cannot be derived from itself.',
      });
    }

    await this.inTransaction(property.id, async (tx) => {
      const locked = await this.lockPlans(tx, property.id, [ratePlanId, request.parentRatePlanId]);
      const plan = locked.get(ratePlanId);
      const parent = locked.get(request.parentRatePlanId);
      if (plan === undefined) throw new TenantScopeViolationError('Rate plan');
      if (parent === undefined) throw new TenantScopeViolationError('Parent rate plan');

      if (plan.archivedAt !== null) {
        throw new InvalidStateTransitionError('rate plan', 'ARCHIVED', 'derived');
      }
      if (parent.archivedAt !== null) {
        throw new InvalidStateTransitionError('parent rate plan', 'ARCHIVED', 'derived from');
      }
      if (parent.parentRatePlanId !== null) {
        throw new InvalidStateTransitionError('parent rate plan', 'DERIVED', 'derived from');
      }
      const children = await tx.ratePlan.count({
        where: { propertyId: property.id, parentRatePlanId: ratePlanId },
      });
      if (children > 0) {
        throw new InvalidStateTransitionError('rate plan', 'PARENT', 'derived');
      }
      if (plan.currency !== parent.currency) {
        throw new InvalidStateTransitionError('rate plan', 'OTHER_CURRENCY', 'derived');
      }

      const [own, parents] = await Promise.all([
        tx.ratePlanRoomType.findMany({
          where: { propertyId: property.id, ratePlanId },
          select: { roomTypeId: true },
        }),
        tx.ratePlanRoomType.findMany({
          where: { propertyId: property.id, ratePlanId: request.parentRatePlanId },
          select: { roomTypeId: true },
        }),
      ]);
      const priced = new Set(parents.map((row) => row.roomTypeId));
      const missing = own.filter((row) => !priced.has(row.roomTypeId));
      if (missing.length > 0) {
        throw new ValidationFailedError({
          parentRatePlanId:
            `The parent plan does not price ${String(missing.length)} of this plan's room ` +
            'type(s). Assign them to the parent first.',
        });
      }

      await tx.ratePlan.updateMany({
        where: { id: ratePlanId, propertyId: property.id },
        data: {
          parentRatePlanId: request.parentRatePlanId,
          derivationKind: request.kind,
          derivationValue: request.value,
        },
      });

      await this.audit(tx, property.id, userId, ratePlanId, plan, {
        parentRatePlanId: request.parentRatePlanId,
        derivationKind: request.kind,
        derivationValue: request.value,
      });
    });

    return this.view(property.id, ratePlanId);
  }

  /** Unlink: the plan prices from its own calendar again. Idempotent. */
  async clear(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
  ): Promise<RatePlanDerivationView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);

    await this.inTransaction(property.id, async (tx) => {
      const locked = await this.lockPlans(tx, property.id, [ratePlanId]);
      const plan = locked.get(ratePlanId);
      if (plan === undefined) throw new TenantScopeViolationError('Rate plan');
      if (plan.parentRatePlanId === null) return;

      await tx.ratePlan.updateMany({
        where: { id: ratePlanId, propertyId: property.id },
        data: { parentRatePlanId: null, derivationKind: null, derivationValue: null },
      });
      await this.audit(tx, property.id, userId, ratePlanId, plan, {
        parentRatePlanId: null,
        derivationKind: null,
        derivationValue: null,
      });
    });

    return this.view(property.id, ratePlanId);
  }

  /* ---------------------------------------------------------------------- */

  private async view(propertyId: string, ratePlanId: string): Promise<RatePlanDerivationView> {
    const plan = await this.prisma.client.ratePlan.findFirst({
      where: { id: ratePlanId, propertyId },
      select: {
        id: true,
        derivationKind: true,
        derivationValue: true,
        parentRatePlan: { select: { id: true, code: true } },
      },
    });
    if (plan === null) throw new TenantScopeViolationError('Rate plan');

    const kind = plan.derivationKind;
    return {
      ratePlanId: plan.id,
      derivation:
        plan.parentRatePlan === null ||
        plan.derivationValue === null ||
        (kind !== 'PERCENT' && kind !== 'FIXED')
          ? null
          : {
              parentRatePlanId: plan.parentRatePlan.id,
              parentCode: plan.parentRatePlan.code,
              kind,
              value: plan.derivationValue,
            },
    };
  }

  /** Lock the named plans of THIS property, in id order (deadlock-free between two setters). */
  private async lockPlans(
    tx: Prisma.TransactionClient,
    propertyId: string,
    ids: readonly string[],
  ): Promise<Map<string, PlanRow>> {
    const rows = await tx.$queryRaw<PlanRow[]>`
      SELECT "id", "code", "currency", "archivedAt", "parentRatePlanId"
        FROM rate_plan
       WHERE "propertyId" = ${propertyId}::uuid
         AND "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
       ORDER BY "id"
         FOR UPDATE
    `;
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async inTransaction(
    propertyId: string,
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    try {
      await this.prisma.client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
          await work(tx);
        },
        { timeout: 10_000 },
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isLockTimeout(error)) throw new TransactionConflictError('rate plan derivation');
      throw error;
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    propertyId: string,
    actorUserId: string,
    ratePlanId: string,
    before: PlanRow,
    after: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId,
        actorUserId,
        event: 'RATE_PLAN_DERIVATION_SET',
        entityType: 'rate_plan',
        entityId: ratePlanId,
        before: { parentRatePlanId: before.parentRatePlanId },
        after,
      },
    });
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
