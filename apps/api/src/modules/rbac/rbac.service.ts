import { Injectable } from '@nestjs/common';
import {
  ALL_ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
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
      permissions: [...ROLE_PERMISSIONS[role]],
      isPortfolioScoped: isPortfolioRole(role),
    }));
  }

  resolvePermissions(roles: readonly Role[]): Permission[] {
    return permissionsForRoles(roles);
  }

  private describe(role: Role): string {
    switch (role) {
      case 'SUPER_ADMIN':
        return 'Portfolio operator. The only role permitted to cross property boundaries.';
      case 'PROPERTY_ADMIN':
        return 'General manager of one property. Full control within that property.';
      case 'FRONT_DESK':
        return 'Reception: reservations, check-in/out, folio posting and payments.';
      case 'HOUSEKEEPING':
        return 'Room status and task execution. No access to financial data.';
      case 'REVENUE_MANAGER':
        return 'Rates, restrictions, channel mappings and ARI distribution.';
      case 'NIGHT_AUDITOR':
        return 'Runs and reviews the night audit; closes the business date.';
    }
  }
}
