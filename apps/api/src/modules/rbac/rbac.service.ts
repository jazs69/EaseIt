import { Injectable } from '@nestjs/common';
import {
  ALL_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  DEFAULT_ROLE_PERMISSIONS,
  isPortfolioRole,
  permissionsForRoles,
  type Permission,
  type Role,
  type RoleDefinitionDto,
} from '@repo/types';

/**
 * Serves the role/permission catalog to the admin UI so that the permission
 * matrix is rendered from one source of truth instead of being duplicated in
 * the frontend.
 *
 * Note this reads from @repo/types rather than from the database: the six
 * system roles are code, and the `role` table is a seeded projection of them.
 */
@Injectable()
export class RbacService {
  listRoles(): RoleDefinitionDto[] {
    return ALL_ROLES.map((role) => ({
      key: role,
      label: ROLE_LABELS[role],
      description: this.describe(role),
      permissions: [...DEFAULT_ROLE_PERMISSIONS[role]],
      isPortfolioScoped: isPortfolioRole(role),
    }));
  }

  resolvePermissions(roles: readonly Role[]): Permission[] {
    return permissionsForRoles(roles);
  }

  /**
   * Sourced from @repo/types rather than a local switch: a hand-written
   * switch here silently stopped compiling the moment POS_STAFF joined the
   * Role union, which is exactly the drift this avoids.
   */
  private describe(role: Role): string {
    return ROLE_DESCRIPTIONS[role];
  }
}
