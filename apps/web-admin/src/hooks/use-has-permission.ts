'use client';

import { hasAllPermissions, hasAnyPermission, type Permission } from '@repo/types';

import { useSession } from '@/components/session-provider';

/**
 * The permission set for the signed-in operator at their active property.
 *
 * IMPORTANT: this is a **rendering hint, not an authorisation decision**.
 * Hiding a button stops an honest mistake; it stops nothing else. Every action
 * it guards is independently re-checked by `PermissionsGuard` in apps/api,
 * which resolves permissions from the database on every request. Never rely on
 * this alone to protect an operation.
 *
 * The source is the real session now: resolved server-side from the httpOnly
 * cookie by the `(dashboard)` layout and passed down through
 * `SessionProvider`. It used to be derived on the client from a single role in
 * the sign-in stub, which was wrong in two ways beyond being fake — it could
 * not represent an operator holding several roles at one property, and it
 * could not see a property-custom role at all, because those have no `Role`
 * key to look up.
 *
 * The set is already the union of every role the operator holds at the active
 * property, computed by the API. An empty set is meaningful rather than
 * broken: it is what a session with no property selected looks like, because
 * authority in this system is always per property.
 */
export function usePermissions(): readonly Permission[] {
  return useSession().permissions;
}

/**
 * True when the operator holds the permission(s).
 *
 * Passing an array requires **all** of them, matching the default of the
 * `@RequirePermissions` decorator on the server, so the UI and the API agree
 * by default. Use `useHasAnyPermission` where alternatives are acceptable.
 */
export function useHasPermission(permission: Permission | Permission[]): boolean {
  const granted = usePermissions();
  const required = Array.isArray(permission) ? permission : [permission];
  return hasAllPermissions(granted, required);
}

export function useHasAnyPermission(permissions: Permission[]): boolean {
  const granted = usePermissions();
  return hasAnyPermission(granted, permissions);
}
