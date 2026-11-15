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
  isPermissionAvailable,
  Permission,
  PERMISSION_BY_KEY,
  UNAVAILABLE_PERMISSIONS,
  type ActivePropertyContext,
  type CreateRoleRequest,
  type InviteStaffResult,
  type RoleDetailDto,
  type StaffMemberDto,
  type UpdateRoleRequest,
} from '@repo/types';
import { randomBytes } from 'node:crypto';

import { hash } from 'bcryptjs';

import {
  DeactivationRefusedError,
  EntityNotFoundError,
  ForbiddenError,
  RoleImmutableError,
  RoleNameTakenError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { AccountService } from '../auth/account.service.js';
import { ClockService } from '../platform/clock.service.js';
import {
  AccessControlRepository,
  type RoleRow,
  type StaffRow,
} from './access-control.repository.js';

@Injectable()
export class AccessControlService {
  constructor(
    private readonly repository: AccessControlRepository,
    private readonly accounts: AccountService,
    private readonly clock: ClockService,
  ) {}

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
    // AU-13, before the portfolio exemption: nobody may grant a permission
    // whose feature does not exist -- it would promise an ability the product
    // cannot deliver. A request-shape problem, so 400 naming each one.
    const unavailable = permissions.filter((permission) => !isPermissionAvailable(permission));
    if (unavailable.length > 0) {
      throw new ValidationFailedError({
        permissions: unavailable
          .map(
            (permission) =>
              `${PERMISSION_BY_KEY[permission]?.label ?? permission}: ${UNAVAILABLE_PERMISSIONS[permission] ?? 'not available'}`,
          )
          .join(' '),
      });
    }

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

  /**
   * AU-14: invite a person to this property.
   *
   * A new person gets an account whose password nobody knows -- a hash of 32
   * random bytes, discarded -- and an emailed single-use link to set their
   * own. (The previous placeholder hashed the email and a millisecond
   * timestamp, which was guessable, so an invited account could have been
   * signed into before its owner ever saw the invitation.) A person who
   * already has an account is simply granted the roles here; one whose
   * earlier invitation is still unaccepted is sent a fresh link.
   */
  async inviteStaff(
    context: ActivePropertyContext,
    request: { email: string; firstName: string; lastName: string; roleIds: string[] },
  ): Promise<InviteStaffResult> {
    await this.assertGrantable(context, request.roleIds);

    const existing = await this.repository.findUserByEmail(request.email);
    const userId =
      existing?.id ??
      (await this.repository.createUser(
        request.email,
        request.firstName,
        request.lastName,
        await hash(randomBytes(32).toString('base64url'), 12),
      ));

    await this.repository.replaceGrants(context.propertyId, userId, request.roleIds, context.userId);

    const member = await this.repository.findStaffMember(context.propertyId, userId);
    if (member === null) throw new EntityNotFoundError('Staff member');

    const needsInvitation = existing === null || (await this.accounts.hasPendingInvitation(userId));
    if (!needsInvitation) return { member: this.toStaffMember(member), invitation: 'NOT_NEEDED' };

    const user = await this.repository.findUser(userId);
    const sent = await this.accounts.sendInvitation({
      userId,
      email: request.email,
      firstName: user?.firstName ?? request.firstName,
      propertyName: await this.repository.propertyName(context.propertyId),
      invitedById: context.userId,
    });
    return { member: this.toStaffMember(member), invitation: sent ? 'SENT' : 'EMAIL_FAILED' };
  }

  /* -- AU-15: deactivation ------------------------------------------------ */

  /**
   * Deactivate a person: they cannot sign in, every session they hold stops
   * working on its next request, and every unused reset or invitation link is
   * revoked. Their grants are kept, so reactivating restores access as it was.
   *
   * An account is portfolio-wide, so the caller's authority is checked against
   * everywhere the person works. Refused, with the reason: deactivating
   * oneself; a portfolio operator, unless the caller is one; and a person who
   * also works at another property, unless the caller is a portfolio operator
   * -- a property admin cannot lock someone out of a hotel they do not run.
   * Removing their roles here (assign-roles with none) is the local option.
   */
  async deactivate(context: ActivePropertyContext, userId: string, reason: string | null): Promise<StaffMemberDto> {
    const member = await this.authorizeActivation(context, userId, 'deactivate');
    await this.repository.setActive({
      propertyId: context.propertyId,
      userId,
      actorId: context.userId,
      active: false,
      reason,
      now: this.clock.now(),
    });
    await this.accounts.revokePendingTokens(userId);
    const updated = await this.repository.findStaffMember(context.propertyId, userId);
    return this.toStaffMember(updated ?? member);
  }

  /** Reactivate; sessions revoked at deactivation stay revoked. */
  async reactivate(context: ActivePropertyContext, userId: string, reason: string | null): Promise<StaffMemberDto> {
    const member = await this.authorizeActivation(context, userId, 'reactivate');
    await this.repository.setActive({
      propertyId: context.propertyId,
      userId,
      actorId: context.userId,
      active: true,
      reason,
      now: this.clock.now(),
    });
    const updated = await this.repository.findStaffMember(context.propertyId, userId);
    return this.toStaffMember(updated ?? member);
  }

  private async authorizeActivation(
    context: ActivePropertyContext,
    userId: string,
    action: 'deactivate' | 'reactivate',
  ): Promise<StaffRow> {
    // Someone with no grant here is not found, never forbidden (section 3.2).
    const member = await this.repository.findStaffMember(context.propertyId, userId);
    if (member === null) throw new EntityNotFoundError('Staff member');

    if (userId === context.userId) {
      throw new DeactivationRefusedError(`You cannot ${action} your own account.`);
    }
    if (!context.isPortfolioOperator) {
      const footprint = await this.repository.grantFootprint(userId, context.propertyId);
      if (footprint.isPortfolioOperator) {
        throw new DeactivationRefusedError(`Only a portfolio operator can ${action} a portfolio operator.`);
      }
      if (footprint.otherProperties > 0) {
        throw new DeactivationRefusedError(
          `This person also works at ${String(footprint.otherProperties)} other propert` +
            `${footprint.otherProperties === 1 ? 'y' : 'ies'}. Ask a portfolio operator to ${action} ` +
            'the account, or remove their roles here instead.',
        );
      }
    }
    return member;
  }
}
