/**
 * Route-level permission requirements (CLAUDE.md section 5: authorisation
 * lives in guards, never in business logic).
 *
 * Two modes, because both are genuinely needed:
 *
 *   @RequirePermissions(A, B)     — the caller must hold A *and* B
 *   @RequireAnyPermission(A, B)   — the caller must hold A *or* B
 *
 * ALL is the default: requiring every listed permission is the conservative
 * reading, and a route that genuinely accepts alternatives should say so
 * explicitly.
 */

import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Permission } from '@repo/types';

export const PERMISSIONS_METADATA_KEY = 'easeit:required-permissions';

export type PermissionMode = 'any' | 'all';

export interface RequiredPermissionsMetadata {
  permissions: readonly Permission[];
  mode: PermissionMode;
}

/** The caller must hold every listed permission. */
export function RequirePermissions(...permissions: Permission[]): CustomDecorator<string> {
  return SetMetadata<string, RequiredPermissionsMetadata>(PERMISSIONS_METADATA_KEY, {
    permissions,
    mode: 'all',
  });
}

/** The caller must hold at least one of the listed permissions. */
export function RequireAnyPermission(...permissions: Permission[]): CustomDecorator<string> {
  return SetMetadata<string, RequiredPermissionsMetadata>(PERMISSIONS_METADATA_KEY, {
    permissions,
    mode: 'any',
  });
}
