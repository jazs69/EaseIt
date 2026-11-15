/**
 * Stay restrictions (AV-07): reading and setting MinLOS, CTA and CTD.
 *
 * Authorisation order matches `rate-calendar.service.ts`: grant first (no grant
 * is not-found), then permission, then the plan/room-type assignment in one
 * scoped read -- any miss is not-found, never a 403 that confirms existence.
 *
 * ENFORCEMENT is not here: it runs in `RateCalendarService.resolveStay`, the
 * one place a booking or quote resolves a plan, so a restriction cannot be
 * honoured by one path and missed by another.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  MAX_RESTRICTION_DAYS,
  Permission,
  type RateRestrictionQuery,
  type RateRestrictionsResponse,
  type SetRateRestrictionsRequest,
} from '@repo/types';

import {
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { enumerateInclusive, parseCalendarDate } from './rate-calendar.policy.js';
import { RateCalendarRepository } from './rate-calendar.repository.js';
import { RateRestrictionRepository } from './rate-restriction.repository.js';

@Injectable()
export class RateRestrictionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RateRestrictionRepository,
    private readonly calendar: RateCalendarRepository,
  ) {}

  async read(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    query: RateRestrictionQuery,
  ): Promise<RateRestrictionsResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    await this.requireAssignment(property.id, ratePlanId, query.roomTypeId);
    this.requireRange(query.fromDate, query.toDate, 'toDate');

    const days = await this.repository.findRange(
      property.id,
      ratePlanId,
      query.roomTypeId,
      query.fromDate,
      query.toDate,
    );
    return {
      ratePlanId,
      roomTypeId: query.roomTypeId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      days: days as RateRestrictionsResponse['days'],
    };
  }

  async set(
    userId: string,
    codeOrId: string,
    ratePlanId: string,
    request: SetRateRestrictionsRequest,
  ): Promise<RateRestrictionsResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const assignment = await this.requireAssignment(property.id, ratePlanId, request.roomTypeId);
    if (assignment.archivedAt !== null || !assignment.isActive) {
      throw new InvalidStateTransitionError('rate plan', 'ARCHIVED_OR_INACTIVE', 'restricted');
    }
    const dates = this.requireRange(request.fromDate, request.throughDate, 'throughDate');

    const before = await this.repository.findRange(
      property.id,
      ratePlanId,
      request.roomTypeId,
      request.fromDate,
      request.throughDate,
    );

    const written = await this.repository.setDates(
      property.id,
      ratePlanId,
      request.roomTypeId,
      dates,
      {
        minLos: request.minLos,
        closedToArrival: request.closedToArrival,
        closedToDeparture: request.closedToDeparture,
      },
      userId,
    );

    // Audit after the write, the same known weakening the sibling calendar
    // service records: the bulk statement is not run inside an interactive
    // transaction. A crash between the two loses the audit row, not the change.
    await this.prisma.client.auditLog.create({
      data: {
        propertyId: property.id,
        actorUserId: userId,
        event: 'RATE_RESTRICTIONS_SET',
        entityType: 'rate_restriction_day',
        entityId: ratePlanId,
        before: { restrictedNights: before.length } as Prisma.InputJsonObject,
        after: {
          roomTypeId: request.roomTypeId,
          fromDate: request.fromDate,
          throughDate: request.throughDate,
          minLos: request.minLos,
          closedToArrival: request.closedToArrival,
          closedToDeparture: request.closedToDeparture,
          rowsWritten: written,
        },
      },
    });

    return this.read(userId, codeOrId, ratePlanId, {
      roomTypeId: request.roomTypeId,
      fromDate: request.fromDate,
      toDate: request.throughDate,
    });
  }

  /* ---------------------------------------------------------------------- */

  private requireRange(from: string, to: string, field: string): string[] {
    const start = parseCalendarDate(from);
    const end = parseCalendarDate(to);
    if (start === null) throw new ValidationFailedError({ fromDate: 'Not a real calendar date.' });
    if (end === null) throw new ValidationFailedError({ [field]: 'Not a real calendar date.' });
    const dates = enumerateInclusive(start, end);
    if (dates.length === 0) {
      throw new ValidationFailedError({ [field]: 'The end cannot fall before the start.' });
    }
    if (dates.length > MAX_RESTRICTION_DAYS) {
      throw new ValidationFailedError({
        [field]: `That range is ${String(dates.length)} days. Ask for at most ${String(MAX_RESTRICTION_DAYS)}.`,
      });
    }
    return dates;
  }

  private async requireAssignment(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
  ): Promise<{ isActive: boolean; archivedAt: Date | null }> {
    const assignment = await this.calendar.findAssignment(propertyId, ratePlanId, roomTypeId);
    if (assignment === null) throw new TenantScopeViolationError('Rate plan assignment');
    return assignment;
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
