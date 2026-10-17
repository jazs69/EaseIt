/**
 * Property, user and role-assignment contracts.
 *
 * Note what these DTOs deliberately do not accept from a client: `id`,
 * `propertyId`, `createdAt`, or any computed field. Server-owned values are
 * server-owned (CLAUDE.md section 5) — a request that could set its own
 * `propertyId` is a cross-tenant write waiting to happen.
 */

import { z } from 'zod';

import {
  businessDateSchema,
  paginationQuerySchema,
  propertyIdSchema,
  userIdSchema,
} from '../domain.js';
import { currencySchema } from '../money.js';
import { roleSchema } from '../rbac.js';

/* -------------------------------------------------------------------------- */
/*  Property                                                                  */
/* -------------------------------------------------------------------------- */

/** URL-safe tenant key used by the booking engine (`book.domain.com/{slug}`). */
export const propertySlugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Lowercase letters, digits and single hyphens only — it becomes a subdomain',
  );

/** IANA zone, e.g. `Asia/Kolkata`. Drives this property's night audit. */
export const timeZoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid IANA timezone identifier' },
);

export const propertySchema = z.object({
  id: propertyIdSchema,
  slug: propertySlugSchema,
  name: z.string(),
  legalName: z.string().nullable(),
  timezone: timeZoneSchema,
  currency: currencySchema,
  locale: z.string(),
  /** Owned by the night audit; advanced only by its business-date-roll step. */
  businessDate: businessDateSchema,
  /** Local time after which un-arrived reservations roll to no-show. */
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().length(2),
  phone: z.string().nullable(),
  email: z.email().nullable(),
  isActive: z.boolean(),
});

export type PropertyDto = z.infer<typeof propertySchema>;

export const createPropertyRequestSchema = propertySchema
  .omit({ id: true, businessDate: true, isActive: true })
  .extend({
    /** The business date the property opens its books on. */
    openingBusinessDate: businessDateSchema,
  });

export type CreatePropertyRequest = z.infer<typeof createPropertyRequestSchema>;

export const updatePropertyRequestSchema = propertySchema
  .omit({ id: true, slug: true, businessDate: true, currency: true })
  .partial();

export type UpdatePropertyRequest = z.infer<typeof updatePropertyRequestSchema>;

/** Public shape served to the booking engine. No operational internals. */
export const publicPropertySchema = propertySchema.pick({
  slug: true,
  name: true,
  timezone: true,
  currency: true,
  locale: true,
  checkInTime: true,
  checkOutTime: true,
  addressLine1: true,
  city: true,
  state: true,
  countryCode: true,
  phone: true,
});

export type PublicPropertyDto = z.infer<typeof publicPropertySchema>;

/* -------------------------------------------------------------------------- */
/*  Users                                                                     */
/* -------------------------------------------------------------------------- */

export const userSchema = z.object({
  id: userIdSchema,
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  /** Home property. Null for portfolio-level users (SUPER_ADMIN). */
  propertyId: propertyIdSchema.nullable(),
  isActive: z.boolean(),
  lastLoginAt: z.iso.datetime({ offset: true }).nullable(),
});

export type UserDto = z.infer<typeof userSchema>;

export const inviteUserRequestSchema = z.object({
  email: z.email().toLowerCase().trim(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  phone: z.string().max(30).optional(),
  /**
   * Roles to grant at the property this request is scoped to. The target
   * property comes from the authenticated request context, never from the
   * body — see the omission of `propertyId` here.
   */
  roles: z.array(roleSchema).min(1),
});

export type InviteUserRequest = z.infer<typeof inviteUserRequestSchema>;

export const updateUserRequestSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  phone: z.string().max(30).nullable().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  role: roleSchema.optional(),
  isActive: z.coerce.boolean().optional(),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Role assignment                                                           */
/* -------------------------------------------------------------------------- */

export const roleDefinitionSchema = z.object({
  key: roleSchema,
  label: z.string(),
  description: z.string(),
  permissions: z.array(z.string()),
  isPortfolioScoped: z.boolean(),
});

export type RoleDefinitionDto = z.infer<typeof roleDefinitionSchema>;
