/**
 * Reads of `audit_log` for the viewer (AD-03). No business rules here: the
 * service decides who may read and turns filters into a `where`.
 *
 * Every query names `propertyId` itself, on top of the tenancy extension and
 * row-level security that already bind it (CLAUDE.md section 3.2).
 */

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';

const ENTRY_SELECT = {
  id: true,
  createdAt: true,
  event: true,
  entityType: true,
  entityId: true,
  actorUserId: true,
  before: true,
  after: true,
  reason: true,
} as const;

export type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof ENTRY_SELECT }>;

export interface GrantRow {
  role: { key: string | null };
  property: { id: string; timezone: string };
}

@Injectable()
export class AuditLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's grants at the named property, with that property's zone. */
  grantsAt(where: Prisma.UserPropertyRoleWhereInput): Promise<GrantRow[]> {
    return this.prisma.client.userPropertyRole.findMany({
      where,
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, timezone: true } },
      },
    });
  }

  /** True when `id` is an entry of this property; a cursor from anywhere else is refused. */
  async entryExists(propertyId: string, id: string): Promise<boolean> {
    const found = await this.prisma.client.auditLog.findFirst({
      where: { id, propertyId },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Newest first, `take` rows after `cursor`.
   *
   * Prisma's own cursor is used rather than a hand-encoded `(createdAt, id)`
   * pair on purpose: `createdAt` is microsecond `timestamptz` and a JS `Date`
   * holds milliseconds, so a cursor round-tripped through JavaScript would
   * silently skip rows written within the same millisecond. Prisma compares
   * against the cursor row in SQL, at full precision.
   */
  page(
    where: Prisma.AuditLogWhereInput,
    take: number,
    cursor: string | undefined,
  ): Promise<AuditLogRow[]> {
    return this.prisma.client.auditLog.findMany({
      where,
      select: ENTRY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
  }

  async distinctActors(propertyId: string): Promise<string[]> {
    const rows = await this.prisma.client.auditLog.groupBy({
      by: ['actorUserId'],
      where: { propertyId, actorUserId: { not: null } },
      orderBy: { actorUserId: 'asc' },
    });
    return rows.map((row) => row.actorUserId).filter((id): id is string => id !== null);
  }

  async distinctEntityTypes(propertyId: string): Promise<string[]> {
    const rows = await this.prisma.client.auditLog.groupBy({
      by: ['entityType'],
      where: { propertyId },
      orderBy: { entityType: 'asc' },
    });
    return rows.map((row) => row.entityType);
  }

  async distinctEvents(propertyId: string): Promise<string[]> {
    const rows = await this.prisma.client.auditLog.groupBy({
      by: ['event'],
      where: { propertyId },
      orderBy: { event: 'asc' },
    });
    return rows.map((row) => row.event);
  }

  async names(ids: readonly string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  }
}
