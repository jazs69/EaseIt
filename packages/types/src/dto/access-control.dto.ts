/**
 * Access-control wire contracts.
 *
 * These are the shapes the RBAC management endpoints accept and return. As
 * everywhere, `propertyId` is never accepted from a request body — it comes
 * from the route and is authorised by `ActivePropertyGuard` before a handler
 * runs (CLAUDE.md section 3.2).
 */

import { z } from 'zod';

import { paginationQuerySchema, propertyIdSchema, roleIdSchema, userIdSchema } from '../domain.js';
import { permissionSchema, roleSchema } from '../rbac.js';

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

export const roleSummarySchema = z.object({
  id: roleIdSchema,
  name: z.string(),
  /** Null for custom roles, which have no system template behind them. */
  key: roleSchema.nullable(),
  isCustom: z.boolean(),
});

export type RoleSummaryDto = z.infer<typeof roleSummarySchema>;

export const roleDetailSchema = roleSummarySchema.extend({
  description: z.string(),
  /**
   * Null for a system template shared by the whole portfolio; set for a role
   * created by and belonging to one property.
   */
  propertyId: propertyIdSchema.nullable(),
  permissions: z.array(permissionSchema),
  /** How many staff currently hold this role at the active property. */
  assignedCount: z.number().int().nonnegative(),
});

export type RoleDetailDto = z.infer<typeof roleDetailSchema>;

export const createRoleRequestSchema = z.object({
  name: z.string().trim().min(2, 'Give the role a name').max(60),
  description: z.string().trim().max(240).default(''),
  permissions: z.array(permissionSchema).min(1, 'A role must grant at least one permission'),
});

export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

/**
 * Partial update. Omitting `permissions` leaves the grant set untouched;
 * sending it replaces the set wholesale rather than diffing, so two concurrent
 * edits cannot interleave into a permission set neither admin intended.
 */
export const updateRoleRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(240),
    permissions: z.array(permissionSchema).min(1),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Staff directory                                                           */
/* -------------------------------------------------------------------------- */

export const staffMemberSchema = z.object({
  id: userIdSchema,
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  isActive: z.boolean(),
  lastLoginAt: z.iso.datetime({ offset: true }).nullable(),
  /** Roles held *at the active property only*, never across the portfolio. */
  roles: z.array(roleSummarySchema),
  /** Union of every permission the roles above grant. */
  permissions: z.array(permissionSchema),
});

export type StaffMemberDto = z.infer<typeof staffMemberSchema>;

export const listStaffQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  roleId: roleIdSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

export type ListStaffQuery = z.infer<typeof listStaffQuerySchema>;

/**
 * Replaces a user's roles at the active property. A full replacement rather
 * than an add/remove delta, and an empty array is a valid way to revoke all
 * access at this property without deactivating the account.
 */
export const assignRolesRequestSchema = z.object({
  userId: userIdSchema,
  roleIds: z.array(roleIdSchema).max(10),
});

export type AssignRolesRequest = z.infer<typeof assignRolesRequestSchema>;

export const inviteStaffRequestSchema = z.object({
  email: z.email().toLowerCase().trim(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  roleIds: z.array(roleIdSchema).min(1, 'Assign at least one role'),
});

export type InviteStaffRequest = z.infer<typeof inviteStaffRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Session view                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What the admin UI needs to decide which controls to render. Permissions are
 * re-resolved server-side on every request, so this is a rendering hint and
 * never the authorisation decision itself.
 */
export const activeContextSchema = z.object({
  propertyId: propertyIdSchema,
  propertySlug: z.string(),
  userId: userIdSchema,
  roles: z.array(roleSummarySchema),
  permissions: z.array(permissionSchema),
  isPortfolioOperator: z.boolean(),
});

export type ActiveContextDto = z.infer<typeof activeContextSchema>;
