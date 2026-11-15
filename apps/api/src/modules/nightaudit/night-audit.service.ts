/**
 * Enqueueing and reading night-audit runs (NA-01, NA-07).
 *
 * ===========================================================================
 * This never executes a run. A request -- or the scheduler -- creates the run
 * row and the NIGHT_AUDIT_RUN outbox event in ONE transaction, so either both
 * exist or neither does, and the worker picks it up (section 3.3: a user
 * action can only enqueue and poll).
 *
 * A run always closes the property's *current* business date, which the
 * server owns; the client cannot name a date. (propertyId, businessDate) is
 * unique, so asking twice returns the same run: a COMPLETED one is left
 * alone, a FAILED one is re-enqueued and resumes from its first unfinished
 * step.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  NIGHT_AUDIT_STEPS,
  Permission,
  permissionsForRoles,
  type NightAuditOverview,
  type NightAuditRunView,
  type Role,
  type StartNightAuditResult,
} from '@repo/types';
import type { Prisma } from '@repo/database';

import {
  ForbiddenError,
  TenantScopeViolationError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OutboxService } from '../platform/outbox/outbox.service.js';

type Tx = Prisma.TransactionClient;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const RUN_SELECT = {
  id: true,
  businessDate: true,
  status: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  lastError: true,
  steps: {
    select: { step: true, status: true, outcome: true, finishedAt: true },
    orderBy: { step: 'asc' as const },
  },
} as const;

type RunRow = Prisma.NightAuditRunGetPayload<{ select: typeof RUN_SELECT }>;

function toView(row: RunRow): NightAuditRunView {
  return {
    id: row.id,
    businessDate: iso(row.businessDate) as NightAuditRunView['businessDate'],
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    lastError: row.lastError,
    steps: NIGHT_AUDIT_STEPS.map((definition) => {
      const done = row.steps.find((entry) => entry.step === definition.step);
      return {
        step: definition.step,
        name: definition.name,
        label: definition.label,
        status: done?.status ?? 'NOT_STARTED',
        // Stored by the runner as a JSON object; anything else is shown as absent.
        outcome:
          done !== undefined && typeof done.outcome === 'object' && done.outcome !== null && !Array.isArray(done.outcome)
            ? (done.outcome as Record<string, unknown>)
            : null,
        finishedAt: done?.finishedAt.toISOString() ?? null,
      };
    }),
  };
}

@Injectable()
export class NightAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /** A person asks for tonight's audit. */
  async start(userId: string, hotelId: string): Promise<StartNightAuditResult> {
    const property = await this.authorise(userId, hotelId, Permission.NIGHT_AUDIT_EXECUTE);
    return this.enqueueForProperty(property.id, userId);
  }

  /**
   * Create-or-resume the run for the property's current business date and
   * enqueue it. Shared by the request path and the scheduler (`userId` null).
   */
  async enqueueForProperty(propertyId: string, userId: string | null): Promise<StartNightAuditResult> {
    return this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
      // One enqueuer per property at a time, so two clicks (or a click and
      // the scheduler) cannot both create. Transaction-scoped, released at
      // COMMIT; keyed per property so properties never wait on each other.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`night-audit:${propertyId}`}))`;

      const property = await tx.property.findFirst({
        where: { id: propertyId },
        select: { businessDate: true },
      });
      if (property === null) throw new TenantScopeViolationError('Property');

      const existing = await tx.nightAuditRun.findUnique({
        where: {
          night_audit_run_one_per_business_date: { propertyId, businessDate: property.businessDate },
        },
        select: { id: true, status: true },
      });

      if (existing !== null && existing.status !== 'FAILED') {
        // PENDING or RUNNING is already on its way; COMPLETED is a no-op.
        return { run: await this.read(tx, propertyId, existing.id), outcome: 'EXISTING' as const };
      }

      let runId: string;
      let outcome: 'CREATED' | 'RESUMED';
      if (existing === null) {
        const created = await tx.nightAuditRun.create({
          data: { propertyId, businessDate: property.businessDate, requestedById: userId },
          select: { id: true },
        });
        runId = created.id;
        outcome = 'CREATED';
      } else {
        await tx.nightAuditRun.updateMany({
          where: { id: existing.id, propertyId, status: 'FAILED' },
          data: { status: 'PENDING' },
        });
        runId = existing.id;
        outcome = 'RESUMED';
      }

      // COALESCE: a pending delivery of the same run is reused, but a
      // finished one does not block a resume.
      await this.outbox.enqueue(tx, {
        propertyId,
        eventType: 'NIGHT_AUDIT_RUN',
        payload: { runId },
        dedupeKey: `night-audit-run:${runId}`,
        dedupeMode: 'COALESCE',
      });

      await tx.auditLog.create({
        data: {
          propertyId,
          actorUserId: userId,
          event: outcome === 'CREATED' ? 'NIGHT_AUDIT_REQUESTED' : 'NIGHT_AUDIT_RESUMED',
          entityType: 'night_audit_run',
          entityId: runId,
          before: { status: existing?.status ?? null },
          after: { status: 'PENDING', businessDate: iso(property.businessDate) },
          reason: userId === null ? 'Scheduled' : null,
        },
      });

      return { run: await this.read(tx, propertyId, runId), outcome };
    });
  }

  async overview(userId: string, hotelId: string): Promise<NightAuditOverview> {
    const property = await this.authorise(userId, hotelId, Permission.NIGHT_AUDIT_READ);
    const rows = await this.prisma.client.nightAuditRun.findMany({
      where: { propertyId: property.id },
      select: RUN_SELECT,
      orderBy: { businessDate: 'desc' },
      take: 14,
    });
    return {
      businessDate: iso(property.businessDate) as NightAuditOverview['businessDate'],
      timezone: property.timezone,
      runs: rows.map(toView),
    };
  }

  async run(userId: string, hotelId: string, runId: string): Promise<NightAuditRunView> {
    const property = await this.authorise(userId, hotelId, Permission.NIGHT_AUDIT_READ);
    return this.read(this.prisma.client, property.id, runId);
  }

  private async read(db: Tx | PrismaService['client'], propertyId: string, runId: string): Promise<NightAuditRunView> {
    // Scoped by property in the same predicate: another property's run is
    // not found, never forbidden (section 3.2).
    const row = await db.nightAuditRun.findFirst({ where: { id: runId, propertyId }, select: RUN_SELECT });
    if (row === null) throw new TenantScopeViolationError('Night audit run');
    return toView(row);
  }

  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<{ id: string; businessDate: Date; timezone: string }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, businessDate: true, timezone: true } },
      },
    });
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);
    if (!permissionsForRoles(roles).includes(required)) throw new ForbiddenError(required);
    return first.property;
  }
}
