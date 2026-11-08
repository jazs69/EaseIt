/**
 * The *decision* half of a property-scoped authorisation. Pure, no throwing.
 *
 * ===========================================================================
 * `grantedPropertyWhere` (./property-identifier.ts) answers *where*: it
 * resolves a property through the caller's own `UserPropertyRole` rows, so an
 * identifier they hold no grant for is **not found** rather than forbidden
 * (CLAUDE.md section 3.2). That is the tenancy control, and nothing here
 * changes it.
 *
 * This answers *may they do this here?* — a separate question, because holding
 * a grant is not holding an authority. Housekeeping has a grant at the
 * property and must still not be able to check a guest out.
 *
 * WHY THIS FILE HAS NO RELATIVE IMPORTS.
 * Deliberate, and the reason it is split from `require-permission.ts`. Node's
 * type stripping does not rewrite a `.js` specifier to the `.ts` file beside
 * it, so a helper that imports `../errors/domain-error.js` cannot be loaded
 * from a `.mjs` unit test at all. The two src helpers this repository already
 * imports directly from tests — `outbox.prefix.ts` and
 * `property-identifier.ts` — both import only from workspace packages, for
 * exactly this reason. Keeping the predicate free of relative imports is what
 * makes the policy behaviourally testable without a database, a module graph
 * or a loader; the throwing wrapper next door is then thin enough to assert
 * structurally.
 *
 * NOTE ON CUSTOM ROLES — an inherited behaviour, not a new one.
 * `permissionsForRoles` maps *system* role keys to their template
 * permissions. A custom role stores `key = null` and carries its permissions
 * as `rolePermission` rows instead, so it contributes nothing here and a
 * caller whose only role at the property is custom is refused. That is
 * precisely how `check-in`, `check-out`, `cancel-reservation`, `room-move`,
 * `reservation-detail`, `folios` and `property-setup` already behave.
 * Reproduced rather than quietly improved, so every call site answers alike.
 * `ActivePropertyGuard` is the one place that reads the row set and so does
 * honour custom roles; reconciling the two is a real decision with a
 * behavioural consequence, and not this change's to make.
 * ===========================================================================
 */

import { permissionsForRoles, type Permission, type Role } from '@repo/types';

/** A grant row, reduced to the only field this decision needs. */
export interface RoleKeyBearingGrant {
  readonly role: { readonly key: string | null };
}

/**
 * Keeps only the system role keys from a set of grant rows.
 *
 * Grants are read per property, so several rows for one property means several
 * roles, and the caller's authority is their **union** — a clerk holding Front
 * Desk *and* Night Auditor can do both jobs. A `null` key is a custom role;
 * see the note above.
 */
export function systemRoleKeys(grants: readonly RoleKeyBearingGrant[]): Role[] {
  return grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);
}

/**
 * Does the union of `roles` carry `required`?
 *
 * A result, not an exception: "may this caller do this" is an expected
 * question with an expected negative answer (CLAUDE.md section 5). The
 * exception is raised one layer out, by `requirePermission`.
 *
 * An empty `roles` is `false`, which is the fail-closed direction: no roles
 * must never mean no restriction.
 */
export function hasPermission(roles: readonly Role[], required: Permission): boolean {
  return permissionsForRoles(roles).includes(required);
}

/** `hasPermission` straight from grant rows. */
export function grantsCarryPermission(
  grants: readonly RoleKeyBearingGrant[],
  required: Permission,
): boolean {
  return hasPermission(systemRoleKeys(grants), required);
}
