/**
 * Group (portfolio) dashboard contracts.
 *
 * This is the screen a staff member lands on after sign-in: every property
 * they hold a role at, which they then pick one of to enter that property's
 * PMS. It is one of the few deliberately cross-property reads in the system
 * (CLAUDE.md section 3.2) — and it is scoped by `userId`, never open.
 */

import { z } from 'zod';

import { businessDateSchema, propertyIdSchema, propertyStatusSchema } from '../domain.js';
import { roleSchema } from '../rbac.js';

/* -------------------------------------------------------------------------- */
/*  Query                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `ALL` is a filter option, not a status. Keeping it out of `PropertyStatus`
 * itself means no persistence layer can ever store it, and no `switch` over
 * real statuses has to carry a branch that cannot happen.
 */
export const propertyStatusFilterSchema = z.union([propertyStatusSchema, z.literal('ALL')]);

export type PropertyStatusFilter = z.infer<typeof propertyStatusFilterSchema>;

export const listGroupPropertiesQuerySchema = z.object({
  /**
   * Defaults to ACTIVE, matching the toolbar's default. An operator opening
   * the dashboard wants the hotels they can work in, not a retired one from
   * three years ago.
   */
  status: propertyStatusFilterSchema.default('ACTIVE'),
  /** Matches name, code, city or division. Bounded so it cannot be abused. */
  search: z.string().trim().min(1).max(120).optional(),
});

export type ListGroupPropertiesQuery = z.infer<typeof listGroupPropertiesQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Response                                                                  */
/* -------------------------------------------------------------------------- */

/** One row in the group dashboard. */
export const groupPropertySchema = z.object({
  id: propertyIdSchema,
  /** Operator-facing short identifier, e.g. "31336". */
  code: z.string(),
  name: z.string(),
  /** URL segment used to route into this property. */
  slug: z.string(),
  division: z.string().nullable(),
  /**
   * The full physical address as one display string, composed server-side
   * from the structured columns.
   *
   * Deliberately *derived* rather than stored: `property` already holds
   * addressLine1/2, city, state and postalCode, and a second denormalised
   * `address` column would be a duplicate free to drift out of step with them.
   */
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  status: propertyStatusSchema,
  logoUrl: z.string().nullable(),
  timezone: z.string(),
  currency: z.string().length(3),
  businessDate: businessDateSchema,
  /**
   * The single most privileged role this user holds here, for the row's
   * "your role" label.
   *
   * `roles` below is the truthful answer — a clerk can hold several — and this
   * is a presentation convenience derived from it. Null when the user's only
   * role here is property-custom, which has no `Role` key to name.
   */
  userRole: roleSchema.nullable(),
  roles: z.array(roleSchema),
  customRoleNames: z.array(z.string()),
});

export type GroupProperty = z.infer<typeof groupPropertySchema>;

export const groupPropertiesResponseSchema = z.object({
  /** Count *after* filtering, which is what the subtitle reports. */
  total: z.number().int().nonnegative(),
  /** Total the user holds any role at, ignoring filters. */
  totalUnfiltered: z.number().int().nonnegative(),
  properties: z.array(groupPropertySchema),
});

export type GroupPropertiesResponse = z.infer<typeof groupPropertiesResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Selecting the active property                                             */
/* -------------------------------------------------------------------------- */

export const selectPropertyContextRequestSchema = z.object({
  propertyId: propertyIdSchema,
});

export type SelectPropertyContextRequest = z.infer<typeof selectPropertyContextRequestSchema>;

/**
 * What the client gets back after choosing a property.
 *
 * No token, by the same rule as sign-in: the re-issued session is delivered
 * only as the httpOnly cookie on this response. The slug comes back so the
 * client can route to `/properties/{slug-or-id}/…` without a second lookup.
 */
export const selectPropertyContextResponseSchema = z.object({
  activePropertyId: propertyIdSchema,
  propertySlug: z.string(),
  propertyName: z.string(),
  /** Seconds until the re-issued session cookie expires. */
  expiresIn: z.number().int().positive(),
});

export type SelectPropertyContextResponse = z.infer<typeof selectPropertyContextResponseSchema>;
