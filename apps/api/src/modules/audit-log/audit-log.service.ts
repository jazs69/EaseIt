/**
 * The audit log viewer (AD-03): filter a property's audit rows by actor,
 * entity, event and property-local date, newest first, cursor-paged.
 *
 * Authorisation follows every other `:hotelId` route: a property the caller
 * holds no grant at is **not found** (CLAUDE.md section 3.2); a grant without
 * `audit_log:read` is a 403 naming the permission.
 */

import { Injectable } from '@nestjs/common';
import {
  addDays,
  Permission,
  startOfDayInTimeZone,
  type AuditLogEntry,
  type AuditLogFacets,
  type AuditLogPage,
  type ListAuditLogQuery,
} from '@repo/types';
import type { Prisma } from '@repo/database';

import { EntityNotFoundError, ValidationFailedError } from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { AuditLogRepository, type AuditLogRow } from './audit-log.repository.js';

interface Scope {
  propertyId: string;
  timeZone: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuditLogService {
  constructor(private readonly repository: AuditLogRepository) {}

  async list(userId: string, hotelId: string, query: ListAuditLogQuery): Promise<AuditLogPage> {
    const scope = await this.authorise(userId, hotelId);

    if (query.cursor !== undefined) {
      // A cursor is an entry id of THIS property. Anything else -- garbage,
      // or another hotel's row -- is refused the same way, so a cursor can
      // neither probe for other properties' rows nor position a page by them.
      const known =
        UUID.test(query.cursor) &&
        (await this.repository.entryExists(scope.propertyId, query.cursor));
      if (!known) {
        throw new ValidationFailedError({
          cursor: 'This page link is no longer valid. Start again from the first page.',
        });
      }
    }

    const rows = await this.repository.page(
      this.where(scope, query),
      query.limit + 1,
      query.cursor,
    );
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const names = await this.repository.names(
      items.map((row) => row.actorUserId).filter((id): id is string => id !== null),
    );

    return {
      items: items.map((row) => this.toEntry(row, names)),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      timeZone: scope.timeZone,
    };
  }

  async facets(userId: string, hotelId: string): Promise<AuditLogFacets> {
    const scope = await this.authorise(userId, hotelId);
    const [actorIds, entityTypes, events] = await Promise.all([
      this.repository.distinctActors(scope.propertyId),
      this.repository.distinctEntityTypes(scope.propertyId),
      this.repository.distinctEvents(scope.propertyId),
    ]);
    const names = await this.repository.names(actorIds);
    const actors = actorIds
      .map((id) => ({ id, name: names.get(id) ?? 'Unknown user' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { actors, entityTypes, events };
  }

  private where(scope: Scope, query: ListAuditLogQuery): Prisma.AuditLogWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    // Property-local calendar days, converted with the property's zone; `to`
    // is inclusive, so its bound is the start of the following day.
    if (query.from !== undefined) createdAt.gte = startOfDayInTimeZone(query.from, scope.timeZone);
    if (query.to !== undefined)
      createdAt.lt = startOfDayInTimeZone(addDays(query.to, 1), scope.timeZone);

    let actor: Prisma.AuditLogWhereInput = {};
    if (query.actor === 'system') actor = { actorUserId: null };
    else if (query.actor !== undefined) actor = { actorUserId: query.actor };

    return {
      propertyId: scope.propertyId,
      ...actor,
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.event === undefined ? {} : { event: query.event }),
      ...(query.from === undefined && query.to === undefined ? {} : { createdAt }),
    };
  }

  private toEntry(row: AuditLogRow, names: Map<string, string>): AuditLogEntry {
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      event: row.event,
      entityType: row.entityType,
      entityId: row.entityId,
      actor:
        row.actorUserId === null
          ? null
          : { id: row.actorUserId, name: names.get(row.actorUserId) ?? 'Unknown user' },
      before: row.before ?? null,
      after: row.after ?? null,
      reason: row.reason,
    };
  }

  private async authorise(userId: string, hotelId: string): Promise<Scope> {
    const grants = await this.repository.grantsAt(
      grantedPropertyWhere({ userId, codeOrId: hotelId, operableOnly: false }),
    );
    const first = grants[0];
    if (first === undefined) throw new EntityNotFoundError('Property');
    requirePermissionFromGrants(grants, Permission.AUDIT_LOG_READ);
    return { propertyId: first.property.id, timeZone: first.property.timezone };
  }
}
