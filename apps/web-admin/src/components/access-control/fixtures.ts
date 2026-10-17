/**
 * Local fixtures for the access-control screen.
 *
 * ===========================================================================
 * THIS IS NOT REAL DATA. There is no database yet, so this screen reads the
 * genuine role templates out of @repo/types and pairs them with an in-memory
 * staff list. Every mutation below updates React state only — nothing is
 * persisted, and reloading the page discards it.
 *
 * Swapping to the real API is a change of data source, not of shape: the
 * types here are the same DTOs the endpoints return.
 *
 *   GET    /api/v1/properties/:propertyId/roles
 *   POST   /api/v1/properties/:propertyId/roles
 *   PATCH  /api/v1/properties/:propertyId/roles/:roleId
 *   GET    /api/v1/properties/:propertyId/users
 *   POST   /api/v1/properties/:propertyId/users/assign-roles
 * ===========================================================================
 */

import {
  ALL_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  Permission,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type Permission as PermissionKey,
  type Role,
} from '@repo/types';

export interface RoleView {
  id: string;
  name: string;
  description: string;
  key: Role | null;
  isCustom: boolean;
  permissions: PermissionKey[];
  assignedCount: number;
}

export interface StaffView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  roleIds: string[];
}

/** System templates, read straight out of the shared RBAC definitions. */
export function systemRoles(): RoleView[] {
  return ALL_ROLES.map((role) => ({
    id: `system:${role}`,
    name: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
    key: role,
    isCustom: false,
    permissions: [...DEFAULT_ROLE_PERMISSIONS[role]],
    assignedCount: 0,
  }));
}

/**
 * One custom role, mirroring what the seed creates for Grand Marine Goa: a
 * single-cover shift combining reception and the night audit, minus the
 * refund permission.
 */
export function initialCustomRoles(): RoleView[] {
  const combined = new Set<PermissionKey>([
    ...DEFAULT_ROLE_PERMISSIONS.FRONT_DESK,
    ...DEFAULT_ROLE_PERMISSIONS.NIGHT_AUDITOR,
  ]);
  combined.delete(Permission.FOLIO_REFUND);

  return [
    {
      id: 'custom:single-cover',
      name: 'Front Desk & Night Auditor',
      description: 'Combined reception and night-audit duties for a single-cover shift.',
      key: null,
      isCustom: true,
      permissions: [...combined],
      assignedCount: 1,
    },
  ];
}

export function initialStaff(): StaffView[] {
  return [
    {
      id: 'u-1',
      email: 'property.admin@grand-marine-goa.example.com',
      firstName: 'Priya',
      lastName: 'Shetty',
      isActive: true,
      roleIds: ['system:PROPERTY_ADMIN'],
    },
    {
      id: 'u-2',
      email: 'front.desk@grand-marine-goa.example.com',
      firstName: 'Karan',
      lastName: 'Fernandes',
      isActive: true,
      roleIds: ['system:FRONT_DESK'],
    },
    {
      id: 'u-3',
      email: 'dual.role@grand-marine-goa.example.com',
      firstName: 'Asha',
      lastName: 'Nair',
      isActive: true,
      // Multi-role at one property: permissions are the union of the two.
      roleIds: ['system:FRONT_DESK', 'system:NIGHT_AUDITOR'],
    },
    {
      id: 'u-4',
      email: 'single.cover@grand-marine-goa.example.com',
      firstName: 'Ravi',
      lastName: 'Menon',
      isActive: true,
      roleIds: ['custom:single-cover'],
    },
    {
      id: 'u-5',
      email: 'housekeeping@grand-marine-goa.example.com',
      firstName: 'Meera',
      lastName: 'Das',
      isActive: true,
      roleIds: ['system:HOUSEKEEPING'],
    },
    {
      id: 'u-6',
      email: 'revenue.west@easeit.example.com',
      firstName: 'West',
      lastName: 'Revenue',
      isActive: true,
      roleIds: ['system:REVENUE_MANAGER'],
    },
    {
      id: 'u-7',
      email: 'pos.staff@grand-marine-goa.example.com',
      firstName: 'Nikhil',
      lastName: 'Rao',
      isActive: false,
      roleIds: ['system:POS_STAFF'],
    },
  ];
}

/** Union of every permission the given roles grant. */
export function permissionsFor(
  roleIds: readonly string[],
  roles: readonly RoleView[],
): PermissionKey[] {
  const granted = new Set<PermissionKey>();
  for (const roleId of roleIds) {
    const role = roles.find((candidate) => candidate.id === roleId);
    if (role === undefined) continue;
    for (const permission of role.permissions) granted.add(permission);
  }
  return [...granted];
}
