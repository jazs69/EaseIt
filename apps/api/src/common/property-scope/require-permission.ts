/**
 * The *refusal* half of a property-scoped authorisation.
 *
 * ===========================================================================
 * Thin on purpose. The decision lives in `./permission-policy.ts`, which has
 * no relative imports and is therefore unit-testable from a `.mjs` suite; all
 * this adds is the typed exception, which needs `../errors/domain-error.js`
 * and so cannot sit in that file (see its header).
 *
 * Why a function rather than two inlined lines: the same two lines are written
 * out in `check-in`, `check-out`, `cancel-reservation`, `room-move`,
 * `reservation-detail`, `folios` and `property-setup`. That duplication is
 * what this repository has already paid for once, when the grant predicate
 * itself was found copied across seventeen services.
 * ===========================================================================
 */

import type { Permission, Role } from '@repo/types';

import { ForbiddenError } from '../errors/domain-error.js';
import {
  grantsCarryPermission,
  hasPermission,
  type RoleKeyBearingGrant,
} from './permission-policy.js';

/**
 * Throws `ForbiddenError` unless the union of `roles` carries `required`.
 *
 * Returns nothing on success, so a call site reads as a precondition. The
 * error names the missing permission, which is what lets an operator be told
 * what to ask for; the global `DomainExceptionFilter` renders it as a 403 with
 * the typed `FORBIDDEN` code (CLAUDE.md section 5).
 *
 * **403, not 404**, and the distinction is load-bearing: a caller only reaches
 * this after proving a grant at the property, so its existence is not a secret
 * from them. A missing *grant* stays 404 — section 3.2 is about hiding other
 * tenants, not one's own.
 */
export function requirePermission(roles: readonly Role[], required: Permission): void {
  if (!hasPermission(roles, required)) {
    throw new ForbiddenError(required);
  }
}

/**
 * The same, straight from grant rows.
 *
 * `grants` is the result of a `findMany` over `UserPropertyRole` selecting
 * `role: { select: { key: true } }`. An **empty set is not handled here**:
 * that means no grant, which is a tenancy answer (404) the caller must raise
 * itself before asking about permissions.
 */
export function requirePermissionFromGrants(
  grants: readonly RoleKeyBearingGrant[],
  required: Permission,
): void {
  if (!grantsCarryPermission(grants, required)) {
    throw new ForbiddenError(required);
  }
}
