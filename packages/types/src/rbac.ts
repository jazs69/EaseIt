/**
 * Role-based access control for the EaseIt portfolio.
 *
 * Two levels of scope exist and must not be conflated:
 *
 *  - **Portfolio scope** — `SUPER_ADMIN` only. Spans all 10 properties and is
 *    the sole role permitted to read across tenant boundaries. Every such read
 *    still has to go through the audited `withoutTenantScope()` escape hatch
 *    (CLAUDE.md section 3.2).
 *  - **Property scope** — every other role. A grant is always a triple of
 *    (user, role, propertyId); the same person can be FRONT_DESK at one hotel
 *    and PROPERTY_ADMIN at another. There is no such thing as a role held
 *    "globally" apart from SUPER_ADMIN.
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
  /** Reception: reservations, check-in/out, folio posting, payments. */
  FRONT_DESK: 'FRONT_DESK',
  /** Room status and task execution. Deliberately blind to financials. */
  HOUSEKEEPING: 'HOUSEKEEPING',
  /** Rates, restrictions, channel mappings, ARI distribution. */
  REVENUE_MANAGER: 'REVENUE_MANAGER',
  /** Runs and reviews the night audit; closes the business date. */
  NIGHT_AUDITOR: 'NIGHT_AUDITOR',
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
};

/* -------------------------------------------------------------------------- */
/*  Permissions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Granular permissions in `resource:action` form.
 *
 * Rules for adding one:
 *  - The string value is persisted in `Permission.key` and may appear in JWT
 *    claims, so treat it as a wire contract: additive only, never renamed.
 *  - Prefer a new narrow permission over widening an existing one.
 *  - Anything that moves money, alters inventory, or crosses a tenant boundary
 *    gets its own permission rather than riding along on a broader one.
 */
export const Permission = {
  /* -- Property & portfolio administration -------------------------------- */
  PROPERTY_READ: 'property:read',
  PROPERTY_CREATE: 'property:create',
  PROPERTY_UPDATE: 'property:update',
  PROPERTY_ARCHIVE: 'property:archive',
  PROPERTY_SWITCH_ANY: 'property:switch_any',

  /* -- Users, roles & permissions ----------------------------------------- */
  USER_READ: 'user:read',
  USER_INVITE: 'user:invite',
  USER_UPDATE: 'user:update',
  USER_DEACTIVATE: 'user:deactivate',
  USER_RESET_PASSWORD: 'user:reset_password',
  ROLE_READ: 'role:read',
  ROLE_ASSIGN: 'role:assign',
  ROLE_MANAGE: 'role:manage',

  /* -- Reservations ------------------------------------------------------- */
  RESERVATION_READ: 'reservation:read',
  RESERVATION_CREATE: 'reservation:create',
  RESERVATION_UPDATE: 'reservation:update',
  RESERVATION_CANCEL: 'reservation:cancel',
  RESERVATION_ASSIGN_ROOM: 'reservation:assign_room',
  RESERVATION_MOVE_ROOM: 'reservation:move_room',
  RESERVATION_CHECK_IN: 'reservation:check_in',
  RESERVATION_CHECK_OUT: 'reservation:check_out',
  RESERVATION_MARK_NO_SHOW: 'reservation:mark_no_show',
  /** Book past a closed/restricted date or a stop-sell. Highly privileged. */
  RESERVATION_OVERRIDE_RESTRICTION: 'reservation:override_restriction',

  /* -- Rooms & inventory -------------------------------------------------- */
  ROOM_READ: 'room:read',
  ROOM_MANAGE: 'room:manage',
  ROOM_TYPE_READ: 'room_type:read',
  ROOM_TYPE_MANAGE: 'room_type:manage',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_ADJUST: 'inventory:adjust',
  INVENTORY_BLOCK: 'inventory:block',
  /** Raise `overbookingAllowance`. Never a side effect of a booking race. */
  INVENTORY_SET_OVERBOOKING: 'inventory:set_overbooking',

  /* -- Rates, restrictions & promotions ----------------------------------- */
  RATE_READ: 'rate:read',
  RATE_MANAGE: 'rate:manage',
  RATE_OVERRIDE: 'rate:override',
  RESTRICTION_READ: 'restriction:read',
  RESTRICTION_MANAGE: 'restriction:manage',
  PROMOTION_READ: 'promotion:read',
  PROMOTION_MANAGE: 'promotion:manage',

  /* -- Folios & charges --------------------------------------------------- */
  FOLIO_READ: 'folio:read',
  FOLIO_POST_CHARGE: 'folio:post_charge',
  /** Posts a reversing line. Folio lines are immutable (CLAUDE.md 3.4). */
  FOLIO_REVERSE_CHARGE: 'folio:reverse_charge',
  FOLIO_TRANSFER: 'folio:transfer',
  FOLIO_APPLY_DISCOUNT: 'folio:apply_discount',
  FOLIO_CLOSE: 'folio:close',
  FOLIO_REOPEN: 'folio:reopen',
  INVOICE_READ: 'invoice:read',
  INVOICE_ISSUE: 'invoice:issue',

  /* -- Payments ----------------------------------------------------------- */
  PAYMENT_READ: 'payment:read',
  PAYMENT_CAPTURE: 'payment:capture',
  PAYMENT_REFUND: 'payment:refund',
  PAYMENT_VOID: 'payment:void',
  CASHIER_SHIFT_READ: 'cashier_shift:read',
  CASHIER_SHIFT_CLOSE: 'cashier_shift:close',

  /* -- Housekeeping ------------------------------------------------------- */
  HOUSEKEEPING_READ: 'housekeeping:read',
  HOUSEKEEPING_UPDATE_ROOM_STATUS: 'housekeeping:update_room_status',
  HOUSEKEEPING_ASSIGN_TASK: 'housekeeping:assign_task',
  HOUSEKEEPING_INSPECT: 'housekeeping:inspect',
  HOUSEKEEPING_SET_OUT_OF_ORDER: 'housekeeping:set_out_of_order',

  /* -- Night audit & business date ---------------------------------------- */
  NIGHT_AUDIT_READ: 'night_audit:read',
  /** Enqueues a run. Never executes it inline (CLAUDE.md 3.3). */
  NIGHT_AUDIT_ENQUEUE: 'night_audit:enqueue',
  NIGHT_AUDIT_RESUME: 'night_audit:resume',
  NIGHT_AUDIT_OVERRIDE_EXCEPTION: 'night_audit:override_exception',
  BUSINESS_DATE_CLOSE: 'business_date:close',

  /* -- Channel manager ---------------------------------------------------- */
  CHANNEL_READ: 'channel:read',
  CHANNEL_MANAGE_MAPPING: 'channel:manage_mapping',
  CHANNEL_PUSH_ARI: 'channel:push_ari',
  CHANNEL_RESYNC: 'channel:resync',
  CHANNEL_READ_LOGS: 'channel:read_logs',

  /* -- Direct booking engine --------------------------------------------- */
  BOOKING_ENGINE_READ_CONFIG: 'booking_engine:read_config',
  BOOKING_ENGINE_MANAGE_CONFIG: 'booking_engine:manage_config',

  /* -- Reporting & audit trail ------------------------------------------- */
  REPORT_READ_OPERATIONAL: 'report:read_operational',
  REPORT_READ_FINANCIAL: 'report:read_financial',
  REPORT_EXPORT: 'report:export',
  AUDIT_LOG_READ: 'audit_log:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS = Object.values(Permission);

export const permissionSchema = z.enum(Permission);

/* -------------------------------------------------------------------------- */
/*  Role to permission mapping                                                */
/* -------------------------------------------------------------------------- */

const P = Permission;

/** Read-only baseline every authenticated staff member needs to use the PMS. */
const BASELINE: readonly Permission[] = [P.PROPERTY_READ, P.ROOM_READ, P.ROOM_TYPE_READ];

const FRONT_DESK_PERMISSIONS: readonly Permission[] = [
  ...BASELINE,
  P.USER_READ,
  P.RESERVATION_READ,
  P.RESERVATION_CREATE,
  P.RESERVATION_UPDATE,
  P.RESERVATION_CANCEL,
  P.RESERVATION_ASSIGN_ROOM,
  P.RESERVATION_MOVE_ROOM,
  P.RESERVATION_CHECK_IN,
  P.RESERVATION_CHECK_OUT,
  P.INVENTORY_READ,
  P.RATE_READ,
  P.RESTRICTION_READ,
  P.PROMOTION_READ,
  P.FOLIO_READ,
  P.FOLIO_POST_CHARGE,
  P.FOLIO_TRANSFER,
  P.FOLIO_CLOSE,
  P.INVOICE_READ,
  P.INVOICE_ISSUE,
  P.PAYMENT_READ,
  P.PAYMENT_CAPTURE,
  P.CASHIER_SHIFT_READ,
  P.CASHIER_SHIFT_CLOSE,
  P.HOUSEKEEPING_READ,
  P.HOUSEKEEPING_UPDATE_ROOM_STATUS,
  P.REPORT_READ_OPERATIONAL,
];

const HOUSEKEEPING_PERMISSIONS: readonly Permission[] = [
  ...BASELINE,
  // Arrivals/departures are needed to sequence cleaning, but nothing financial.
  P.RESERVATION_READ,
  P.HOUSEKEEPING_READ,
  P.HOUSEKEEPING_UPDATE_ROOM_STATUS,
  P.HOUSEKEEPING_ASSIGN_TASK,
  P.HOUSEKEEPING_INSPECT,
  P.HOUSEKEEPING_SET_OUT_OF_ORDER,
];

const REVENUE_MANAGER_PERMISSIONS: readonly Permission[] = [
  ...BASELINE,
  P.RESERVATION_READ,
  P.INVENTORY_READ,
  P.INVENTORY_ADJUST,
  P.INVENTORY_BLOCK,
  P.INVENTORY_SET_OVERBOOKING,
  P.ROOM_TYPE_MANAGE,
  P.RATE_READ,
  P.RATE_MANAGE,
  P.RATE_OVERRIDE,
  P.RESTRICTION_READ,
  P.RESTRICTION_MANAGE,
  P.PROMOTION_READ,
  P.PROMOTION_MANAGE,
  P.CHANNEL_READ,
  P.CHANNEL_MANAGE_MAPPING,
  P.CHANNEL_PUSH_ARI,
  P.CHANNEL_RESYNC,
  P.CHANNEL_READ_LOGS,
  P.BOOKING_ENGINE_READ_CONFIG,
  P.BOOKING_ENGINE_MANAGE_CONFIG,
  P.REPORT_READ_OPERATIONAL,
  P.REPORT_READ_FINANCIAL,
  P.REPORT_EXPORT,
];

const NIGHT_AUDITOR_PERMISSIONS: readonly Permission[] = [
  ...BASELINE,
  P.RESERVATION_READ,
  P.RESERVATION_MARK_NO_SHOW,
  P.RESERVATION_CHECK_IN,
  P.RESERVATION_CHECK_OUT,
  P.INVENTORY_READ,
  P.RATE_READ,
  P.FOLIO_READ,
  P.FOLIO_POST_CHARGE,
  P.FOLIO_REVERSE_CHARGE,
  P.FOLIO_CLOSE,
  P.INVOICE_READ,
  P.PAYMENT_READ,
  P.CASHIER_SHIFT_READ,
  P.CASHIER_SHIFT_CLOSE,
  P.HOUSEKEEPING_READ,
  P.NIGHT_AUDIT_READ,
  P.NIGHT_AUDIT_ENQUEUE,
  P.NIGHT_AUDIT_RESUME,
  P.NIGHT_AUDIT_OVERRIDE_EXCEPTION,
  P.BUSINESS_DATE_CLOSE,
  P.REPORT_READ_OPERATIONAL,
  P.REPORT_READ_FINANCIAL,
  P.REPORT_EXPORT,
  P.AUDIT_LOG_READ,
];

/** Everything except the portfolio-crossing permissions. */
const PROPERTY_ADMIN_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) =>
    permission !== P.PROPERTY_CREATE &&
    permission !== P.PROPERTY_ARCHIVE &&
    permission !== P.PROPERTY_SWITCH_ANY &&
    permission !== P.ROLE_MANAGE,
);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [Role.SUPER_ADMIN]: ALL_PERMISSIONS,
  [Role.PROPERTY_ADMIN]: PROPERTY_ADMIN_PERMISSIONS,
  [Role.FRONT_DESK]: FRONT_DESK_PERMISSIONS,
  [Role.HOUSEKEEPING]: HOUSEKEEPING_PERMISSIONS,
  [Role.REVENUE_MANAGER]: REVENUE_MANAGER_PERMISSIONS,
  [Role.NIGHT_AUDITOR]: NIGHT_AUDITOR_PERMISSIONS,
};

/* -------------------------------------------------------------------------- */
/*  Resolution helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Union of the permissions granted by every supplied role, de-duplicated. */
export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
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
 * must filter on — it is never taken from a client-supplied header or body.
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
