/**
 * Persistence for the group dashboard.
 *
 * Every query here is **scoped by `userId`**, and that is the whole safety
 * story. This is one of the deliberately cross-property reads CLAUDE.md
 * section 3.2 permits — the screen's entire job is to list the hotels a person
 * may enter, which cannot be answered from inside a single tenant. What makes
 * it safe is that the tenant set is derived from the caller's own
 * `UserPropertyRole` rows rather than from anything they sent.
 *
 * Note what is absent: no `findMany` over `property` on its own. The traversal
 * always starts at the grant table, so a property with no grant for this user
 * is not merely filtered out — it is never selected.
 */

import { Injectable } from '@nestjs/common';
import {
  isRole,
  OPERABLE_PROPERTY_STATUSES,
  type PropertyStatus,
  type Role,
} from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

/** A property the caller holds at least one role at. */
export interface GroupPropertyRow {
  id: string;
  code: string;
  name: string;
  slug: string;
  division: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  status: PropertyStatus;
  logoUrl: string | null;
  timezone: string;
  currency: string;
  /** `YYYY-MM-DD`. */
  businessDate: string;
  roles: Role[];
  customRoleNames: string[];
}

export interface GroupPropertyFilter {
  /** Undefined means every status, including retired. */
  status?: PropertyStatus;
  search?: string;
}

@Injectable()
export class PropertiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's properties, newest-role-first collapsed into one row each.
   *
   * Filtering happens in SQL rather than in the service so that a portfolio
   * operator with every property does not pull ten rows' worth of joins to
   * discard nine of them. At ten properties that is academic; the shape is
   * what matters, because this is the query that would hurt first.
   */
  async findGroupProperties(
    userId: string,
    filter: GroupPropertyFilter,
  ): Promise<GroupPropertyRow[]> {
    const search = filter.search?.trim();

    // Built by conditional spread rather than by assigning `undefined`:
    // `exactOptionalPropertyTypes` (CLAUDE.md section 5) treats an explicit
    // `status: undefined` as a *present* key holding undefined, which Prisma's
    // input types reject. Absent and undefined are different things here, and
    // the compiler is right to insist on the distinction.
    const propertyWhere = {
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(search === undefined || search.length === 0
        ? {}
        : {
            // `mode: 'insensitive'` rather than lowercasing both sides in
            // application code: Postgres can use a case-insensitive index for
            // this, and string-folding in JS cannot.
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { code: { contains: search, mode: 'insensitive' as const } },
              { city: { contains: search, mode: 'insensitive' as const } },
              { division: { contains: search, mode: 'insensitive' as const } },
            ],
          }),
    };

    const rows = await this.prisma.client.userPropertyRole.findMany({
      where: {
        userId,
        ...(Object.keys(propertyWhere).length === 0 ? {} : { property: propertyWhere }),
      },
      select: {
        propertyId: true,
        property: {
          select: {
            id: true,
            code: true,
            name: true,
            slug: true,
            division: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            postalCode: true,
            status: true,
            logoUrl: true,
            timezone: true,
            currency: true,
            businessDate: true,
          },
        },
        role: { select: { key: true, name: true } },
      },
      orderBy: { property: { name: 'asc' } },
    });

    // One row per (property, role), collapsed to one entry per property whose
    // role list is the union — a clerk holding Front Desk *and* Night Auditor
    // appears once, with both.
    const byProperty = new Map<string, GroupPropertyRow>();

    for (const row of rows) {
      let entry = byProperty.get(row.propertyId);
      if (entry === undefined) {
        entry = {
          ...row.property,
          // @db.Date comes back as UTC midnight, so the first ten characters
          // are the property's own calendar date with no timezone arithmetic
          // applied (CLAUDE.md section 3.3).
          businessDate: row.property.businessDate.toISOString().slice(0, 10),
          roles: [],
          customRoleNames: [],
        };
        byProperty.set(row.propertyId, entry);
      }

      if (row.role.key !== null && isRole(row.role.key)) {
        entry.roles.push(row.role.key);
      } else {
        entry.customRoleNames.push(row.role.name);
      }
    }

    return [...byProperty.values()];
  }

  /** How many properties the caller holds any role at, ignoring filters. */
  async countAllGroupProperties(userId: string): Promise<number> {
    const rows = await this.prisma.client.userPropertyRole.findMany({
      where: { userId },
      select: { propertyId: true },
      distinct: ['propertyId'],
    });
    return rows.length;
  }

  /**
   * Confirms the caller may enter this property, and returns what is needed to
   * route them there.
   *
   * Null covers every reason indistinguishably: no such property, retired, or
   * the user holds no role there. The caller turns all three into one
   * not-found, because a response that separated them would confirm the
   * existence of hotels the caller has no business knowing about.
   */
  async findGrantedProperty(
    userId: string,
    propertyId: string,
  ): Promise<{ id: string; slug: string; name: string } | null> {
    const grant = await this.prisma.client.userPropertyRole.findFirst({
      where: {
        userId,
        propertyId,
        property: { status: { in: [...OPERABLE_PROPERTY_STATUSES] } },
      },
      select: {
        property: { select: { id: true, slug: true, name: true } },
      },
    });

    return grant?.property ?? null;
  }
}
