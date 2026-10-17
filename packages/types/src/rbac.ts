/**
 * Role-based access control for the EaseIt portfolio.
 *
 * Two levels of scope exist and must not be conflated:
 *
 *  - **Portfolio scope** — `SUPER_ADMIN` only. Spans all 10 properties and is
 *    the sole role permitted to cross tenant boundaries. Every such read still
 *    goes through the audited `withoutTenantScope()` escape hatch
 *    (CLAUDE.md section 3.2).
 *  - **Property scope** — every other role. A grant is always a triple of
 *    (user, property, role), modelled by `UserPropertyRole`. The same person
 *    can be FRONT_DESK at one hotel and PROPERTY_ADMIN at another, and can
 *    hold *several* roles at one property (e.g. Front Desk + Night Auditor).
 *    Their effective permission set is the union of all of them.
 *
 * Permissions are the unit authorisation is checked against, never roles.
 * Guards resolve a role set to a permission set once per request and check
 * permissions from then on, so re-mapping a role never requires touching a
 * call site.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

export const Role = {
  /** Portfolio owner / platform operator. Crosses property boundaries. */
  SUPER_ADMIN: 'SUPER_ADMIN',
  /** General manager of a single property. Full control within that property. */
  PROPERTY_ADMIN: 'PROPERTY_ADMIN',
  /** Reception: reservations, check-in/out, folio posting, settlement. */
  FRONT_DESK: 'FRONT_DESK',
  /** Room status and task execution. Deliberately blind to financials. */
  HOUSEKEEPING: 'HOUSEKEEPING',
  /** Rates, restrictions, channel mappings, ARI distribution. */
  REVENUE_MANAGER: 'REVENUE_MANAGER',
  /** Runs and reviews the night audit; closes the business date. */
  NIGHT_AUDITOR: 'NIGHT_AUDITOR',
  /** Outlet staff posting food, beverage and spa charges to a room folio. */
  POS_STAFF: 'POS_STAFF',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES = Object.values(Role);

export const roleSchema = z.enum(Role);

/** Roles whose authority is not confined to one `propertyId`. */
export const PORTFOLIO_ROLES: readonly Role[] = [Role.SUPER_ADMIN];

export function isPortfolioRole(role: Role): boolean {
  return PORTFOLIO_ROLES.includes(role);
}

/** Human-readable labels for the admin UI. Keep in sync with `Role`. */
export const ROLE_LABELS: Record<Role, string> = {
  [Role.SUPER_ADMIN]: 'Super Admin',
  [Role.PROPERTY_ADMIN]: 'Property Admin',
  [Role.FRONT_DESK]: 'Front Desk',
  [Role.HOUSEKEEPING]: 'Housekeeping',
  [Role.REVENUE_MANAGER]: 'Revenue Manager',
  [Role.NIGHT_AUDITOR]: 'Night Auditor',
  [Role.POS_STAFF]: 'POS Staff',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [Role.SUPER_ADMIN]: 'Portfolio operator. The only role permitted to cross property boundaries.',
  [Role.PROPERTY_ADMIN]: 'General manager of one property. Full control within that property.',
  [Role.FRONT_DESK]: 'Reception: reservations, check-in/out, folio posting and settlement.',
  [Role.HOUSEKEEPING]: 'Room status and task execution. No access to financial data.',
  [Role.REVENUE_MANAGER]: 'Rates, restrictions, channel mappings and ARI distribution.',
  [Role.NIGHT_AUDITOR]: 'Runs and reviews the night audit; closes the business date.',
  [Role.POS_STAFF]: 'Outlet staff posting charges to an in-house guest folio.',
};

/* -------------------------------------------------------------------------- */
/*  Permissions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Granular permissions in `module:action` form.
 *
 * Rules for adding one:
 *  - The string value is persisted in `Permission.key` and may appear in JWT
 *    claims, so treat it as a wire contract: additive only, never renamed.
 *  - Prefer a new narrow permission over widening an existing one.
 *  - Anything that moves money, alters inventory, or crosses a tenant boundary
 *    gets its own permission rather than riding along on a broader one.
 */
export const Permission = {
  /* -- Front desk --------------------------------------------------------- */
  RESERVATIONS_READ: 'reservations:read',
  RESERVATIONS_CREATE: 'reservations:create',
  RESERVATIONS_EDIT: 'reservations:edit',
  RESERVATIONS_CHECKIN: 'reservations:checkin',
  RESERVATIONS_CHECKOUT: 'reservations:checkout',
  ROOMS_ASSIGN: 'rooms:assign',

  /* -- Housekeeping ------------------------------------------------------- */
  HOUSEKEEPING_READ: 'housekeeping:read',
  HOUSEKEEPING_UPDATE_STATUS: 'housekeeping:update_status',

  /* -- Billing & folio ---------------------------------------------------- */
  FOLIO_READ: 'folio:read',
  FOLIO_CHARGE: 'folio:charge',
  FOLIO_DISCOUNT: 'folio:discount',
  FOLIO_REFUND: 'folio:refund',
  FOLIO_SETTLE: 'folio:settle',

  /* -- Rates & distribution ----------------------------------------------- */
  RATES_READ: 'rates:read',
  RATES_MANAGE: 'rates:manage',
  CHANNELS_READ: 'channels:read',
  CHANNELS_SYNC: 'channels:sync',
  /** Raise a room type's overbooking allowance (CLAUDE.md section 3.1). */
  INVENTORY_OVERRIDE: 'inventory:override',

  /* -- Night audit -------------------------------------------------------- */
  NIGHT_AUDIT_READ: 'night_audit:read',
  /**
   * Authorises *enqueueing* an audit run, not running one inline. The audit
   * is always a BullMQ job on the property's own schedule
   * (CLAUDE.md section 3.3); this permission gates the button, not the
   * execution model.
   */
  NIGHT_AUDIT_EXECUTE: 'night_audit:execute',
  FINANCIAL_REPORTS_READ: 'financial_reports:read',

  /* -- Administration ----------------------------------------------------- */
  USERS_READ: 'users:read',
  USERS_MANAGE: 'users:manage',
  ROLES_MANAGE: 'roles:manage',
  PROPERTY_SETTINGS: 'property:settings',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS = Object.values(Permission);

export const permissionSchema = z.enum(Permission);

/* -------------------------------------------------------------------------- */
/*  Categories — drives the permission matrix in the admin UI                 */
/* -------------------------------------------------------------------------- */

export const PermissionCategory = {
  FRONT_DESK: 'FRONT_DESK',
  HOUSEKEEPING: 'HOUSEKEEPING',
  BILLING: 'BILLING',
  RATES_DISTRIBUTION: 'RATES_DISTRIBUTION',
  NIGHT_AUDIT: 'NIGHT_AUDIT',
  ADMINISTRATION: 'ADMINISTRATION',
} as const;

export type PermissionCategory = (typeof PermissionCategory)[keyof typeof PermissionCategory];

export const PERMISSION_CATEGORY_LABELS: Record<PermissionCategory, string> = {
  [PermissionCategory.FRONT_DESK]: 'Front Desk',
  [PermissionCategory.HOUSEKEEPING]: 'Housekeeping',
  [PermissionCategory.BILLING]: 'Billing & Folio',
  [PermissionCategory.RATES_DISTRIBUTION]: 'Rates & Distribution',
  [PermissionCategory.NIGHT_AUDIT]: 'Night Audit',
  [PermissionCategory.ADMINISTRATION]: 'Administration',
};

export interface PermissionDefinition {
  key: Permission;
  label: string;
  description: string;
  category: PermissionCategory;
  /**
   * True when granting this lets the holder move money or reduce revenue.
   * The role editor badges these so an administrator sees what they are
   * handing out.
   */
  sensitive: boolean;
}

const P = Permission;
const C = PermissionCategory;

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  {
    key: P.RESERVATIONS_READ,
    label: 'View reservations',
    description: 'See the reservation calendar, arrivals and departures.',
    category: C.FRONT_DESK,
    sensitive: false,
  },
  {
    key: P.RESERVATIONS_CREATE,
    label: 'Create reservations',
    description: 'Take a new booking, including walk-ins.',
    category: C.FRONT_DESK,
    sensitive: false,
  },
  {
    key: P.RESERVATIONS_EDIT,
    label: 'Edit reservations',
    description: 'Amend dates, occupancy, rate plan or cancel a booking.',
    category: C.FRONT_DESK,
    sensitive: false,
  },
  {
    key: P.RESERVATIONS_CHECKIN,
    label: 'Check in',
    description: 'Move an arriving reservation to in-house.',
    category: C.FRONT_DESK,
    sensitive: false,
  },
  {
    key: P.RESERVATIONS_CHECKOUT,
    label: 'Check out',
    description: 'Depart an in-house stay once its folio is settled.',
    category: C.FRONT_DESK,
    sensitive: false,
  },
  {
    key: P.ROOMS_ASSIGN,
    label: 'Assign rooms',
    description: 'Allocate or move a physical room for a stay.',
    category: C.FRONT_DESK,
    sensitive: false,
  },

  {
    key: P.HOUSEKEEPING_READ,
    label: 'View room status',
    description: 'See the housekeeping board and task list.',
    category: C.HOUSEKEEPING,
    sensitive: false,
  },
  {
    key: P.HOUSEKEEPING_UPDATE_STATUS,
    label: 'Update room status',
    description: 'Mark rooms clean, dirty, inspected or out of order.',
    category: C.HOUSEKEEPING,
    sensitive: false,
  },

  {
    key: P.FOLIO_READ,
    label: 'View folios',
    description: 'Read guest folios, charges and balances.',
    category: C.BILLING,
    sensitive: false,
  },
  {
    key: P.FOLIO_CHARGE,
    label: 'Post charges',
    description: 'Add a charge line to a guest folio.',
    category: C.BILLING,
    sensitive: true,
  },
  {
    key: P.FOLIO_DISCOUNT,
    label: 'Apply discounts',
    description: 'Reduce a folio total. Writes an audited adjustment line.',
    category: C.BILLING,
    sensitive: true,
  },
  {
    key: P.FOLIO_REFUND,
    label: 'Issue refunds',
    description: 'Return captured funds to the guest.',
    category: C.BILLING,
    sensitive: true,
  },
  {
    key: P.FOLIO_SETTLE,
    label: 'Settle folios',
    description: 'Take payment and close a folio to a zero balance.',
    category: C.BILLING,
    sensitive: true,
  },

  {
    key: P.RATES_READ,
    label: 'View rates',
    description: 'See rate plans, the rate calendar and restrictions.',
    category: C.RATES_DISTRIBUTION,
    sensitive: false,
  },
  {
    key: P.RATES_MANAGE,
    label: 'Manage rates',
    description: 'Create and edit rate plans, pricing and restrictions.',
    category: C.RATES_DISTRIBUTION,
    sensitive: true,
  },
  {
    key: P.CHANNELS_READ,
    label: 'View channels',
    description: 'See OTA mappings and the ARI push log.',
    category: C.RATES_DISTRIBUTION,
    sensitive: false,
  },
  {
    key: P.CHANNELS_SYNC,
    label: 'Sync channels',
    description: 'Trigger an ARI push or a full channel resync.',
    category: C.RATES_DISTRIBUTION,
    sensitive: true,
  },
  {
    key: P.INVENTORY_OVERRIDE,
    label: 'Override inventory',
    description: 'Set a room type overbooking allowance. Never a race side effect.',
    category: C.RATES_DISTRIBUTION,
    sensitive: true,
  },

  {
    key: P.NIGHT_AUDIT_READ,
    label: 'View night audit',
    description: 'Read audit runs, steps and exceptions.',
    category: C.NIGHT_AUDIT,
    sensitive: false,
  },
  {
    key: P.NIGHT_AUDIT_EXECUTE,
    label: 'Run night audit',
    description: 'Enqueue an audit run and close the business date.',
    category: C.NIGHT_AUDIT,
    sensitive: true,
  },
  {
    key: P.FINANCIAL_REPORTS_READ,
    label: 'View financial reports',
    description: 'Revenue, ADR, RevPAR and tax reporting.',
    category: C.NIGHT_AUDIT,
    sensitive: true,
  },

  {
    key: P.USERS_READ,
    label: 'View staff',
    description: 'See the staff directory for this property.',
    category: C.ADMINISTRATION,
    sensitive: false,
  },
  {
    key: P.USERS_MANAGE,
    label: 'Manage staff',
    description: 'Invite, deactivate and assign roles to staff.',
    category: C.ADMINISTRATION,
    sensitive: true,
  },
  {
    key: P.ROLES_MANAGE,
    label: 'Manage roles',
    description: 'Create and edit custom roles and their permissions.',
    category: C.ADMINISTRATION,
    sensitive: true,
  },
  {
    key: P.PROPERTY_SETTINGS,
    label: 'Property settings',
    description: 'Timezone, currency, tax rules and audit cutoff.',
    category: C.ADMINISTRATION,
    sensitive: true,
  },
];

/** Lookup for a single permission's metadata. */
export const PERMISSION_BY_KEY: Record<Permission, PermissionDefinition> = Object.fromEntries(
  PERMISSION_DEFINITIONS.map((definition) => [definition.key, definition]),
) as Record<Permission, PermissionDefinition>;

/** Permissions grouped by category, in display order. */
export function permissionsByCategory(): {
  category: PermissionCategory;
  label: string;
  permissions: readonly PermissionDefinition[];
}[] {
  return Object.values(PermissionCategory).map((category) => ({
    category,
    label: PERMISSION_CATEGORY_LABELS[category],
    permissions: PERMISSION_DEFINITIONS.filter((definition) => definition.category === category),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Default role templates                                                    */
/* -------------------------------------------------------------------------- */

const FRONT_DESK_PERMISSIONS: readonly Permission[] = [
  P.RESERVATIONS_READ,
  P.RESERVATIONS_CREATE,
  P.RESERVATIONS_EDIT,
  P.RESERVATIONS_CHECKIN,
  P.RESERVATIONS_CHECKOUT,
  P.ROOMS_ASSIGN,
  P.HOUSEKEEPING_READ,
  P.FOLIO_READ,
  P.FOLIO_CHARGE,
  P.FOLIO_SETTLE,
  P.RATES_READ,
  // Deliberately excluded: FOLIO_REFUND and FOLIO_DISCOUNT both reduce
  // revenue, and RATES_MANAGE / CHANNELS_SYNC would let reception move
  // distribution pricing. These are manager actions.
];

const HOUSEKEEPING_PERMISSIONS: readonly Permission[] = [
  P.HOUSEKEEPING_READ,
  P.HOUSEKEEPING_UPDATE_STATUS,
  // Nothing else. Housekeeping is blind to financials by design.
];

const REVENUE_MANAGER_PERMISSIONS: readonly Permission[] = [
  P.RESERVATIONS_READ,
  P.RATES_READ,
  P.RATES_MANAGE,
  P.CHANNELS_READ,
  P.CHANNELS_SYNC,
  P.INVENTORY_OVERRIDE,
  P.FINANCIAL_REPORTS_READ,
];

const NIGHT_AUDITOR_PERMISSIONS: readonly Permission[] = [
  P.RESERVATIONS_READ,
  P.RESERVATIONS_CHECKOUT,
  P.FOLIO_READ,
  P.FOLIO_CHARGE,
  P.FOLIO_SETTLE,
  P.HOUSEKEEPING_READ,
  P.NIGHT_AUDIT_READ,
  P.NIGHT_AUDIT_EXECUTE,
  P.FINANCIAL_REPORTS_READ,
];

const POS_STAFF_PERMISSIONS: readonly Permission[] = [
  // Enough to find the in-house guest and post an outlet charge, no more.
  P.RESERVATIONS_READ,
  P.FOLIO_READ,
  P.FOLIO_CHARGE,
];

/**
 * Baseline permission set for each system role. These are *templates*: a
 * property may clone one into a custom role and toggle individual actions,
 * which is what `Role.isCustom` on the database side represents.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [Role.SUPER_ADMIN]: ALL_PERMISSIONS,
  [Role.PROPERTY_ADMIN]: ALL_PERMISSIONS,
  [Role.FRONT_DESK]: FRONT_DESK_PERMISSIONS,
  [Role.HOUSEKEEPING]: HOUSEKEEPING_PERMISSIONS,
  [Role.REVENUE_MANAGER]: REVENUE_MANAGER_PERMISSIONS,
  [Role.NIGHT_AUDITOR]: NIGHT_AUDITOR_PERMISSIONS,
  [Role.POS_STAFF]: POS_STAFF_PERMISSIONS,
};

/* -------------------------------------------------------------------------- */
/*  Resolution helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Union of the permissions granted by every supplied role, de-duplicated. */
/**
 * Roles from most to least privileged.
 *
 * Used only to pick one label when a staff member holds several at the same
 * property — it is a presentation concern, never an authorisation one.
 * Authority is always the *union* of the roles held (see
 * `permissionsForRoles`), so nothing may branch on this order to decide
 * whether an action is allowed.
 */
export const ROLE_PRECEDENCE: readonly Role[] = [
  Role.SUPER_ADMIN,
  Role.PROPERTY_ADMIN,
  Role.REVENUE_MANAGER,
  Role.NIGHT_AUDITOR,
  Role.FRONT_DESK,
  Role.HOUSEKEEPING,
  Role.POS_STAFF,
];

/**
 * The most privileged of the roles given, or null when none were.
 *
 * Null is the honest answer for a staff member whose only role at a property
 * is property-custom: a custom role has no `Role` key, so there is no system
 * label to show and the caller should fall back to the role's own name.
 */
export function primaryRole(roles: readonly Role[]): Role | null {
  for (const candidate of ROLE_PRECEDENCE) {
    if (roles.includes(candidate)) return candidate;
  }
  return null;
}

export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of DEFAULT_ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return [...granted];
}

export function hasPermission(granted: readonly Permission[], required: Permission): boolean {
  return granted.includes(required);
}

export function hasAnyPermission(
  granted: readonly Permission[],
  required: readonly Permission[],
): boolean {
  return required.some((permission) => granted.includes(permission));
}

export function hasAllPermissions(
  granted: readonly Permission[],
  required: readonly Permission[],
): boolean {
  return required.every((permission) => granted.includes(permission));
}

/** Narrowing guard for values arriving from the database or a JWT claim. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALL_ROLES as string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/*  Request-scoped authorisation subject                                      */
/* -------------------------------------------------------------------------- */

/**
 * A single (role, property) grant. `propertyId` is null only for portfolio
 * roles; a property-scoped role with a null `propertyId` is invalid data.
 */
export const roleAssignmentSchema = z.object({
  role: roleSchema,
  propertyId: z.uuid().nullable(),
});

export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

/**
 * The authenticated subject as guards see it. `activePropertyId` is the
 * property resolved for *this* request and is what every tenant-scoped query
 * must filter on — it is never taken from a client-supplied body field.
 */
export const authSubjectSchema = z.object({
  userId: z.uuid(),
  email: z.email(),
  activePropertyId: z.uuid().nullable(),
  assignments: z.array(roleAssignmentSchema),
});

export type AuthSubject = z.infer<typeof authSubjectSchema>;

/** Roles the subject holds at the property this request is scoped to. */
export function rolesAtActiveProperty(subject: AuthSubject): Role[] {
  return subject.assignments
    .filter(
      (assignment) =>
        isPortfolioRole(assignment.role) ||
        (assignment.propertyId !== null && assignment.propertyId === subject.activePropertyId),
    )
    .map((assignment) => assignment.role);
}

/** Effective permissions for the request's active property. */
export function effectivePermissions(subject: AuthSubject): Permission[] {
  return permissionsForRoles(rolesAtActiveProperty(subject));
}

/** True when the subject may read or write data for `propertyId`. */
export function canAccessProperty(subject: AuthSubject, propertyId: string): boolean {
  return subject.assignments.some(
    (assignment) => isPortfolioRole(assignment.role) || assignment.propertyId === propertyId,
  );
}

/**
 * The context an authorised request carries: which property it acts on, and
 * the flattened permission set for that property. Produced by
 * `ActivePropertyGuard`, consumed by `PermissionsGuard` and repositories.
 */
export interface ActivePropertyContext {
  propertyId: string;
  propertySlug: string;
  userId: string;
  roles: readonly Role[];
  permissions: readonly Permission[];
  isPortfolioOperator: boolean;
}
