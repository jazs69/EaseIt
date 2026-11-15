/**
 * All Prisma access for the RBAC module.
 *
 * Every query here is explicitly scoped: a role is only visible if it is a
 * portfolio system template or belongs to *this* property, and a staff member
 * is only visible if they hold a grant at this property. There is no code path
 * that returns a row from another hotel (CLAUDE.md section 3.2).
 *
 * Repositories contain no business rules — those live in the service.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, withoutTenantScope } from '@repo/database';
import { isPermissionAvailable, type Permission, type Role as RoleKeyType } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

const ROLE_SELECT = {
  id: true,
  name: true,
  description: true,
  key: true,
  isCustom: true,
  propertyId: true,
  permissions: { select: { permission: { select: { key: true } } } },
} satisfies Prisma.RoleSelect;

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  key: RoleKeyType | null;
  isCustom: boolean;
  propertyId: string | null;
  permissions: Permission[];
  assignedCount: number;
}

export interface StaffRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  roles: { id: string; name: string; key: RoleKeyType | null; isCustom: boolean }[];
  permissions: Permission[];
}

/* -------------------------------------------------------------------------- */
/*  Repository                                                                */
/* -------------------------------------------------------------------------- */

@Injectable()
export class AccessControlRepository {
  constructor(private readonly prisma: PrismaService) {}

  /* -- Roles ------------------------------------------------------------- */

  /**
   * System templates (propertyId null) plus this property's own custom roles.
   * Never another property's roles — that is the whole point of the filter.
   */
  async listRoles(propertyId: string): Promise<RoleRow[]> {
    const rows = await this.prisma.client.role.findMany({
      where: { OR: [{ propertyId: null }, { propertyId }] },
      select: {
        ...ROLE_SELECT,
        _count: { select: { assignments: { where: { propertyId } } } },
      },
      orderBy: [{ isCustom: 'asc' }, { name: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      key: row.key as RoleKeyType | null,
      isCustom: row.isCustom,
      propertyId: row.propertyId,
      // AU-13: unbuilt features' permissions are never shown as granted.
      permissions: row.permissions
        .map((link) => link.permission.key as Permission)
        .filter(isPermissionAvailable),
      assignedCount: row._count.assignments,
    }));
  }

  /** Visible to this property only: a template, or its own custom role. */
  async findRole(propertyId: string, roleId: string): Promise<RoleRow | null> {
    const row = await this.prisma.client.role.findFirst({
      where: { id: roleId, OR: [{ propertyId: null }, { propertyId }] },
      select: {
        ...ROLE_SELECT,
        _count: { select: { assignments: { where: { propertyId } } } },
      },
    });

    if (row === null) return null;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      key: row.key as RoleKeyType | null,
      isCustom: row.isCustom,
      propertyId: row.propertyId,
      // AU-13: unbuilt features' permissions are never shown as granted.
      permissions: row.permissions
        .map((link) => link.permission.key as Permission)
        .filter(isPermissionAvailable),
      assignedCount: row._count.assignments,
    };
  }

  /** Resolves permission keys to catalog ids, dropping anything unknown. */
  private async permissionIds(keys: readonly Permission[]): Promise<string[]> {
    const rows = await this.prisma.client.permission.findMany({
      where: { key: { in: [...keys] } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async createCustomRole(
    propertyId: string,
    name: string,
    description: string,
    permissions: readonly Permission[],
  ): Promise<string> {
    const ids = await this.permissionIds(permissions);

    return this.prisma.client.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          name,
          description,
          // The `role_template_or_custom` CHECK requires exactly this shape
          // for a property-owned role.
          isCustom: true,
          key: null,
          propertyId,
        },
        select: { id: true },
      });

      await tx.rolePermission.createMany({
        data: ids.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });

      return role.id;
    });
  }

  /**
   * Replaces the grant set wholesale rather than diffing, so two concurrent
   * edits cannot interleave into a permission set neither admin intended.
   */
  async updateCustomRole(
    propertyId: string,
    roleId: string,
    // `| undefined` is required, not noise: with exactOptionalPropertyTypes a
    // caller spreading a partial DTO passes properties that are present and
    // undefined, which `name?: string` alone rejects.
    changes: {
      name?: string | undefined;
      description?: string | undefined;
      permissions?: readonly Permission[] | undefined;
    },
  ): Promise<void> {
    const ids =
      changes.permissions === undefined ? null : await this.permissionIds(changes.permissions);

    await this.prisma.client.$transaction(async (tx) => {
      const data: Prisma.RoleUpdateManyMutationInput = {};
      if (changes.name !== undefined) data.name = changes.name;
      if (changes.description !== undefined) data.description = changes.description;

      if (Object.keys(data).length > 0) {
        // updateMany, not update: the extra propertyId predicate makes it
        // impossible to touch another tenant's role even with a guessed id.
        await tx.role.updateMany({
          where: { id: roleId, propertyId, isCustom: true },
          data,
        });
      }

      if (ids !== null) {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.rolePermission.createMany({
          data: ids.map((permissionId) => ({ roleId, permissionId })),
          skipDuplicates: true,
        });
      }
    });
  }

  async roleNameExists(propertyId: string, name: string, excludeRoleId?: string): Promise<boolean> {
    const existing = await this.prisma.client.role.findFirst({
      where: {
        propertyId,
        name,
        ...(excludeRoleId === undefined ? {} : { id: { not: excludeRoleId } }),
      },
      select: { id: true },
    });
    return existing !== null;
  }

  /* -- Staff ------------------------------------------------------------- */

  async listStaff(
    propertyId: string,
    options: {
      search?: string;
      roleId?: string;
      isActive?: boolean;
      userId?: string;
      limit: number;
    },
  ): Promise<StaffRow[]> {
    const rows = await this.prisma.client.user.findMany({
      where: {
        ...(options.userId === undefined ? {} : { id: options.userId }),
        ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
        ...(options.search === undefined
          ? {}
          : {
              OR: [
                { email: { contains: options.search, mode: 'insensitive' } },
                { firstName: { contains: options.search, mode: 'insensitive' } },
                { lastName: { contains: options.search, mode: 'insensitive' } },
              ],
            }),
        // The tenant filter: only staff with a grant at this property.
        propertyRoles: {
          some: {
            propertyId,
            ...(options.roleId === undefined ? {} : { roleId: options.roleId }),
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        lastLoginAt: true,
        propertyRoles: {
          where: { propertyId },
          select: {
            role: {
              select: {
                id: true,
                name: true,
                key: true,
                isCustom: true,
                permissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
      },
      orderBy: [{ firstName: 'asc' }, { email: 'asc' }],
      take: options.limit,
    });

    return rows.map((row) => {
      const permissions = new Set<Permission>();
      for (const grant of row.propertyRoles) {
        for (const link of grant.role.permissions) {
          const permission = link.permission.key as Permission;
          // AU-13: never list an unbuilt feature's permission as held.
          if (isPermissionAvailable(permission)) permissions.add(permission);
        }
      }
      return {
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        isActive: row.isActive,
        lastLoginAt: row.lastLoginAt,
        roles: row.propertyRoles.map((grant) => ({
          id: grant.role.id,
          name: grant.role.name,
          key: grant.role.key as RoleKeyType | null,
          isCustom: grant.role.isCustom,
        })),
        permissions: [...permissions],
      };
    });
  }

  async findStaffMember(propertyId: string, userId: string): Promise<StaffRow | null> {
    const rows = await this.listStaff(propertyId, { userId, limit: 1 });
    return rows[0] ?? null;
  }

  /**
   * Replaces the user's grants at this property. Scoped by `propertyId` on
   * both the delete and the create, so it can never disturb their roles at
   * another hotel.
   */
  async replaceGrants(
    propertyId: string,
    userId: string,
    roleIds: readonly string[],
    grantedById: string,
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.userPropertyRole.deleteMany({ where: { propertyId, userId } });
      if (roleIds.length > 0) {
        await tx.userPropertyRole.createMany({
          data: roleIds.map((roleId) => ({ propertyId, userId, roleId, grantedById })),
          skipDuplicates: true,
        });
      }
    });
  }

  /** Role ids that are legal to grant at this property. */
  async grantableRoleIds(propertyId: string): Promise<Set<string>> {
    const rows = await this.prisma.client.role.findMany({
      where: { OR: [{ propertyId: null }, { propertyId }] },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  async findUserByEmail(email: string): Promise<{ id: string } | null> {
    return this.prisma.client.user.findUnique({
      where: { email },
      select: { id: true },
    });
  }

  async createUser(
    email: string,
    firstName: string,
    lastName: string,
    passwordHash: string,
  ): Promise<string> {
    const user = await this.prisma.client.user.create({
      data: { email, firstName, lastName, passwordHash },
      select: { id: true },
    });
    return user.id;
  }

  /* -- AU-14 / AU-15 ------------------------------------------------------ */

  async propertyName(propertyId: string): Promise<string> {
    const property = await this.prisma.client.property.findFirst({
      where: { id: propertyId },
      select: { name: true },
    });
    return property?.name ?? 'your property';
  }

  async findUser(userId: string): Promise<{
    id: string;
    email: string;
    firstName: string;
    isActive: boolean;
  } | null> {
    return this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, isActive: true },
    });
  }

  /**
   * Where else this person works, and whether they hold a portfolio role.
   *
   * Deliberately cross-property (MT-08): deactivating an account is
   * portfolio-wide, so the caller's authority has to be checked against every
   * property the person can reach, not just this one.
   */
  async grantFootprint(userId: string, propertyId: string): Promise<{ otherProperties: number; isPortfolioOperator: boolean }> {
    return withoutTenantScope('checking where a person works before deactivating them', async () => {
      const grants = await this.prisma.client.userPropertyRole.findMany({
        where: { userId },
        select: { propertyId: true, role: { select: { key: true } } },
      });
      return {
        otherProperties: new Set(grants.filter((g) => g.propertyId !== propertyId).map((g) => g.propertyId)).size,
        isPortfolioOperator: grants.some((g) => g.role.key === 'SUPER_ADMIN'),
      };
    });
  }

  /**
   * Activate or deactivate, with the audit row, in one transaction. A
   * deactivation also stamps `sessionsValidFrom`, so every session the
   * person holds stops working on its next request (AU-06).
   */
  async setActive(input: {
    propertyId: string;
    userId: string;
    actorId: string;
    active: boolean;
    reason: string | null;
    now: Date;
  }): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: input.userId },
        data: input.active ? { isActive: true } : { isActive: false, sessionsValidFrom: input.now },
      });
      await tx.auditLog.create({
        data: {
          propertyId: input.propertyId,
          actorUserId: input.actorId,
          event: input.active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
          entityType: 'user',
          entityId: input.userId,
          before: { isActive: !input.active },
          after: { isActive: input.active },
          reason: input.reason,
        },
      });
    });
  }
}
