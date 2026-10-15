/**
 * Authentication and session contracts.
 *
 * These schemas are the single source of truth: the API validates requests
 * with them and both web apps type their fetch clients and forms from the
 * same definitions, so a contract change breaks the build rather than
 * production.
 */

import { z } from 'zod';

import { businessDateSchema, propertyIdSchema, userIdSchema } from '../domain.js';
import { roleSchema, permissionSchema } from '../rbac.js';

/* -------------------------------------------------------------------------- */
/*  Login                                                                     */
/* -------------------------------------------------------------------------- */

export const loginRequestSchema = z.object({
  email: z.email().toLowerCase().trim(),
  password: z.string().min(1, 'Password is required'),
  /**
   * Optional: which property the staff member wants to work in. Omitted on
   * first login, in which case the API picks their only property or asks.
   * The server verifies the user actually has a grant there — this field is a
   * request, never an assertion of access.
   */
  propertyId: propertyIdSchema.optional(),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const passwordPolicySchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((value) => /[a-z]/.test(value), 'Needs a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Needs an uppercase letter')
  .refine((value) => /\d/.test(value), 'Needs a digit');

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordPolicySchema,
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Session                                                                   */
/* -------------------------------------------------------------------------- */

/** One property the signed-in user may operate in, with their roles there. */
export const propertyGrantSchema = z.object({
  propertyId: propertyIdSchema,
  propertySlug: z.string(),
  propertyName: z.string(),
  timezone: z.string(),
  currency: z.string().length(3),
  businessDate: businessDateSchema,
  roles: z.array(roleSchema).min(1),
});

export type PropertyGrant = z.infer<typeof propertyGrantSchema>;

/**
 * Everything the admin shell needs to render immediately after login.
 *
 * `permissions` is the resolved set for `activePropertyId` only. Switching
 * property re-authorises server-side and returns a fresh session — the client
 * never recomputes permissions for a property it has just moved to.
 */
export const sessionSchema = z.object({
  userId: userIdSchema,
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  activePropertyId: propertyIdSchema.nullable(),
  grants: z.array(propertyGrantSchema),
  permissions: z.array(permissionSchema),
  isPortfolioUser: z.boolean(),
});

export type Session = z.infer<typeof sessionSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until `accessToken` expires. */
  expiresIn: z.number().int().positive(),
  session: sessionSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const switchPropertyRequestSchema = z.object({
  propertyId: propertyIdSchema,
});

export type SwitchPropertyRequest = z.infer<typeof switchPropertyRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  JWT claims                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Claims carried in the access token. Deliberately minimal: the token holds
 * identity and the active property, and permissions are resolved per request
 * from the database. Baking a permission list into a long-lived token means a
 * revoked role keeps working until the token expires.
 */
export const jwtClaimsSchema = z.object({
  sub: z.uuid(),
  email: z.email(),
  /** Active property for this token. Null only for portfolio-level sessions. */
  pid: z.uuid().nullable(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type JwtClaims = z.infer<typeof jwtClaimsSchema>;
