/**
 * Business rules for RBAC management.
 *
 * The rules that matter here, all of them enforced server-side regardless of
 * what the admin UI renders:
 *
 *  - System role templates are read-only. A property customises access by
 *    creating its own role, never by editing a shared template.
 *  - A role may only be granted at a property if it is a system template or
 *    belongs to that same property.
 *  - An administrator cannot grant a permission they do not themselves hold —
 *    otherwise `roles:manage` silently becomes every permission.
 *  - Revoking every role is allowed and is how access is removed; it is not
 *    the same as deactivating the account.
 */

import { Injectable } from '@nestjs/common';
import {
  hasAllPermissions,
  Permission,
  PERMISSION_BY_KEY,
  type ActivePropertyContext,
  type CreateRoleRequest,
  type RoleDetailDto,
  type StaffMemberDto,
  type UpdateRoleRequest,
} from '@repo/types';
import { hash } from 'bcryptjs';

import {
  EntityNotFoundError,
  ForbiddenError,
  RoleImmutableError,
  RoleNameTakenError,
} from '../../common/errors/domain-error.js';
import {
  AccessControlRepository,
  type RoleRow,
  type StaffRow,
} from './access-control.repository.js';

@Injectable()
export class AccessControlService {
  constructor(private readonly repository: AccessControlRepository) {}

  /* -- Mapping ------------------------------------------------------------ */

  /** Prisma rows never leave this class un-mapped (CLAUDE.md section 5). */
  private toRoleDetail(row: RoleRow): RoleDetailDto {
    return {
      // Safe: the id came back from a Role row, so it is a real role
      // identifier; the brand exists only at the type level.
      id: row.id as RoleDetailDto['id'],
      name: row.name,
      key: row.key,
      isCustom: row.isCustom,
      description: row.description,
      propertyId: row.propertyId as RoleDetailDto['propertyId'],
      permissions: row.permissions,
      assignedCount: row.assignedCount,
    };
  }

  private toStaffMember(row: StaffRow): StaffMemberDto {
    return {
      id: row.id as StaffMemberDto['id'],
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      isActive: row.isActive,
      lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
      roles: row.roles.map((role) => ({
        id: role.id as StaffMemberDto['roles'][number]['id'],
        name: role.name,
        key: role.key,
        isCustom: role.isCustom,
      })),
      permissions: row.permissions,
    };
  }

  /* -- Guard rails -------------------------------------------------------- */

  /**
   * Privilege-escalation check. Without this, anyone holding `roles:manage`
   * could mint a role granting `folio:refund` and assign it to themselves.
   * A portfolio operator is exempt because they already hold everything.
   */
  private assertCanGrant(context: ActivePropertyContext, permissions: readonly Permission[]): void {
    if (context.isPortfolioOperator) return;

    if (!hasAllPermissions(context.permissions, permissions)) {
      const missing = permissions.filter((permission) => !context.permissions.includes(permission));
      throw new ForbiddenError(
        `You cannot grant permissions you do not hold: ${missing
          .map((permission) => PERMISSION_BY_KEY[permission]?.label ?? permission)
          .join(', ')}`,
      );
    }
  }

  /* -- Roles -------------------------------------------------------------- */

  async listRoles(context: ActivePropertyContext): Promise<RoleDetailDto[]> {
    const rows = await this.repository.listRoles(context.propertyId);
    return rows.map((row) => this.toRoleDetail(row));
  }

  async createRole(
    context: ActivePropertyContext,
    request: CreateRoleRequest,
  ): Promise<RoleDetailDto> {
    this.assertCanGrant(context, request.permissions);

    if (await this.repository.roleNameExists(context.propertyId, request.name)) {
      throw new RoleNameTakenError(request.name);
    }

    const roleId = await this.repository.createCustomRole(
      context.propertyId,
      request.name,
      request.description,
      request.permissions,
    );

    const created = await this.repository.findRole(context.propertyId, roleId);
    if (created === null) throw new EntityNotFoundError('Role');
    return this.toRoleDetail(created);
  }

  async updateRole(
    context: ActivePropertyContext,
    roleId: string,
    request: UpdateRoleRequest,
  ): Promise<RoleDetailDto> {
    const existing = await this.repository.findRole(context.propertyId, roleId);
    if (existing === null) throw new EntityNotFoundError('Role');

    // A system template is shared by all ten hotels. Letting one property edit
    // it would silently change access everywhere else.
    if (!existing.isCustom || existing.propertyId === null) {
      throw new RoleImmutableError(existing.name);
    }

    if (request.permissions !== undefined) {
      this.assertCanGrant(context, request.permissions);
    }

    if (
      request.name !== undefined &&
      request.name !== existing.name &&
      (await this.repository.roleNameExists(context.propertyId, request.name, roleId))
    ) {
      throw new RoleNameTakenError(request.name);
    }

    await this.repository.updateCustomRole(context.propertyId, roleId, request);

    const updated = await this.repository.findRole(context.propertyId, roleId);
    if (updated === null) throw new EntityNotFoundError('Role');
    return this.toRoleDetail(updated);
  }

  /* -- Staff -------------------------------------------------------------- */

  async listStaff(
    context: ActivePropertyContext,
    query: { search?: string; roleId?: string; isActive?: string; limit: number },
  ): Promise<StaffMemberDto[]> {
    const rows = await this.repository.listStaff(context.propertyId, {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.roleId === undefined ? {} : { roleId: query.roleId }),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive === 'true' }),
      limit: query.limit,
    });
    return rows.map((row) => this.toStaffMember(row));
  }

  /** Validates every role id is grantable here before touching any grants. */
  private async assertGrantable(
    context: ActivePropertyContext,
    roleIds: readonly string[],
  ): Promise<void> {
    if (roleIds.length === 0) return;

    const grantable = await this.repository.grantableRoleIds(context.propertyId);
    const foreign = roleIds.filter((roleId) => !grantable.has(roleId));
    if (foreign.length > 0) {
      // Reported as not-found rather than forbidden: the ids may belong to
      // another property, and confirming they exist is a cross-tenant leak.
      throw new EntityNotFoundError('Role');
    }

    const roles = await this.repository.listRoles(context.propertyId);
    const selected = roles.filter((role) => roleIds.includes(role.id));
    const granting = new Set<Permission>();
    for (const role of selected) {
      for (const permission of role.permissions) granting.add(permission);
    }
    this.assertCanGrant(context, [...granting]);
  }

  async assignRoles(
    context: ActivePropertyContext,
    userId: string,
    roleIds: readonly string[],
  ): Promise<StaffMemberDto> {
    await this.assertGrantable(context, roleIds);

    const member = await this.repository.findStaffMember(context.propertyId, userId);
    if (member === null) throw new EntityNotFoundError('Staff member');

    await this.repository.replaceGrants(context.propertyId, userId, roleIds, context.userId);

    const updated = await this.repository.findStaffMember(context.propertyId, userId);
    // Revoking every role removes them from this property's directory, which
    // is the intended outcome — return the pre-update view in that case.
    return updated === null ? this.toStaffMember(member) : this.toStaffMember(updated);
  }

  async inviteStaff(
    context: ActivePropertyContext,
    request: { email: string; firstName: string; lastName: string; roleIds: string[] },
  ): Promise<StaffMemberDto> {
    await this.assertGrantable(context, request.roleIds);

    const existing = await this.repository.findUserByEmail(request.email);

    // An invite with a temporary secret, not a usable password. The real flow
    // emails a single-use set-password link once the auth module exists.
    const placeholder = await hash(`invite:${request.email}:${String(Date.now())}`, 12);

    const userId =
      existing?.id ??
      (await this.repository.createUser(
        request.email,
        request.firstName,
        request.lastName,
        placeholder,
      ));

    await this.repository.replaceGrants(
      context.propertyId,
      userId,
      request.roleIds,
      context.userId,
    );

    const member = await this.repository.findStaffMember(context.propertyId, userId);
    if (member === null) throw new EntityNotFoundError('Staff member');
    return this.toStaffMember(member);
  }
}
