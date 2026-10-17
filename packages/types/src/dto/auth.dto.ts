/**
 * Authentication and session contracts.
 *
 * These schemas are the single source of truth: the API validates requests
 * with them and both web apps type their fetch clients and forms from the
 * same definitions, so a contract change breaks the build rather than
 * production.
 *
 * ---------------------------------------------------------------------------
 * Sign-in is two-step and mandatory for staff:
 *
 *   1. POST /auth/login       email + password   -> a *challenge*, not a session
 *   2. POST /auth/verify-otp  challengeId + code -> the session cookie
 *
 * Step 1 issuing only a challenge is the whole point: a stolen password is not
 * a session. The access token is set by the API as an httpOnly cookie and
 * never appears in a response body, so it is not reachable from JavaScript and
 * therefore not exfiltratable by XSS.
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';

import { businessDateSchema, propertyIdSchema, userIdSchema } from '../domain.js';
import { roleSchema, permissionSchema } from '../rbac.js';

/* -------------------------------------------------------------------------- */
/*  Two-factor parameters                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Shared policy numbers. The API enforces them; the web apps import them so
 * the countdown, the slot count and the "attempts left" copy cannot drift out
 * of step with the server that is actually deciding.
 */
export const TWO_FACTOR = {
  /**
   * Digits in an emailed code.
   *
   * Five, as specified for the verification screen and the email template.
   * Worth recording the arithmetic, because this constant is the one that
   * decides how guessable a code is:
   *
   *   5 digits  = 100,000 codes. With MAX_ATTEMPTS below, one challenge gives
   *               an attacker 5 guesses, so a 1-in-20,000 chance.
   *   6 digits  = 1,000,000 codes, i.e. 1-in-200,000.
   *
   * Both are comfortably safe *because* of the attempt cap, the 10-minute
   * expiry, the one-live-challenge-per-account rule and the per-account login
   * throttle — not because of the length. Remove any of those and neither
   * length saves you. Raising this back to 6 is a one-character change: the
   * zod schema, the email template and the OTP input all derive from it.
   */
  CODE_LENGTH: 5,
  /** How long a freshly issued code stays valid. */
  CODE_TTL_SECONDS: 600,
  /** Wrong codes allowed before the challenge is burned. */
  MAX_ATTEMPTS: 5,
  /** Quiet period between sends, so "resend" cannot be used as a mail cannon. */
  RESEND_COOLDOWN_SECONDS: 45,
  /** Resends per challenge. After this the operator must sign in again. */
  MAX_RESENDS: 3,
  /**
   * Absolute ceiling on a challenge, regardless of resends. Keeps a tab left
   * open on a front-desk terminal from staying verifiable all shift.
   */
  CHALLENGE_TTL_SECONDS: 1800,
} as const;

/** Exactly N digits. Rejects spaces, dashes and non-ASCII digits. */
export const otpCodeSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^[0-9]{${String(TWO_FACTOR.CODE_LENGTH)}}$`),
    `Enter the ${String(TWO_FACTOR.CODE_LENGTH)}-digit code from your email`,
  );

export type OtpCode = z.infer<typeof otpCodeSchema>;

const MASK_CHARACTER = '•';

/**
 * Turns `jayesh@hotel.example.com` into a partially masked form: enough for an
 * operator to recognise their own address, not enough to harvest someone
 * else's.
 *
 * Used on the verify screen, which is reached only *after* a correct password,
 * but masked anyway — that screen can sit open on a shared front-desk
 * terminal.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return MASK_CHARACTER.repeat(3);

  const local = email.slice(0, at);
  const domain = email.slice(at);
  const first = local[0] ?? MASK_CHARACTER;

  if (local.length <= 2) {
    return `${first}${MASK_CHARACTER}${domain}`;
  }

  const last = local[local.length - 1] ?? '';
  const hidden = MASK_CHARACTER.repeat(Math.min(local.length - 2, 6));
  return `${first}${hidden}${last}${domain}`;
}

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
/*  The outstanding challenge                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the client is given after a correct password, and all it is given.
 *
 * Note what is absent: the code, the unmasked address, the user id, and any
 * hint of the operator's roles. The challenge id is the only capability it
 * confers, and on its own that buys an attacker nothing but `MAX_ATTEMPTS`
 * guesses at six digits.
 */
export const twoFactorChallengeSchema = z.object({
  challengeId: z.uuid(),
  /** Masked server-side by `maskEmail`. */
  maskedEmail: z.string(),
  codeLength: z.number().int().positive(),
  /** When the current code stops working. ISO-8601 UTC. */
  expiresAt: z.iso.datetime({ offset: true }),
  /** Earliest instant a resend will be accepted. ISO-8601 UTC. */
  resendAvailableAt: z.iso.datetime({ offset: true }),
  attemptsRemaining: z.number().int().nonnegative(),
  resendsRemaining: z.number().int().nonnegative(),
  /**
   * True when the API has no SMTP transport configured and wrote the code to
   * its own log instead of mailing it. Development only: the API refuses to
   * boot in production without a transport, so this can never be true there.
   * It reports the *fact* of the fallback and never the code itself.
   */
  devMailFallback: z.boolean(),
});

export type TwoFactorChallenge = z.infer<typeof twoFactorChallengeSchema>;

export const verifyOtpRequestSchema = z.object({
  challengeId: z.uuid(),
  code: otpCodeSchema,
});

export type VerifyOtpRequest = z.infer<typeof verifyOtpRequestSchema>;

export const resendOtpRequestSchema = z.object({
  challengeId: z.uuid(),
});

export type ResendOtpRequest = z.infer<typeof resendOtpRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Session                                                                   */
/* -------------------------------------------------------------------------- */

/** One property the signed-in user may operate in, with their roles there. */
export const propertyGrantSchema = z.object({
  propertyId: propertyIdSchema,
  /**
   * Operator-facing short identifier, e.g. `31336`.
   *
   * Carried alongside the id because the admin shell routes by it — a property
   * switcher that linked by uuid would put
   * `?hotelId=78c7e694-9993-4f54-9abc-5b04b8c409e9` in the address bar for a
   * code staff read aloud to each other. Not a secret; it is on every screen.
   */
  propertyCode: z.string(),
  propertySlug: z.string(),
  propertyName: z.string(),
  /**
   * The property's logo, where one has been uploaded.
   *
   * Null for most properties, which is the normal case rather than missing
   * data — a hotel that has not supplied a logo is simply shown its initials.
   */
  propertyLogoUrl: z.string().nullable(),
  timezone: z.string(),
  currency: z.string().length(3),
  businessDate: businessDateSchema,
  roles: z.array(roleSchema),
  /** Names of any property-custom roles held here, which carry no `Role` key. */
  customRoleNames: z.array(z.string()),
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

/**
 * The body returned once the second factor has been cleared.
 *
 * Deliberately carries no `accessToken`. The token is delivered *only* as an
 * httpOnly cookie on the same response; putting a copy in the body would hand
 * it straight back to JavaScript and undo the reason for the cookie.
 */
export const authenticatedResponseSchema = z.object({
  /** Seconds until the session cookie's token expires. */
  expiresIn: z.number().int().positive(),
  session: sessionSchema,
});

export type AuthenticatedResponse = z.infer<typeof authenticatedResponseSchema>;

/**
 * The result of step 1.
 *
 * A discriminated union rather than optional-field soup (CLAUDE.md section 5):
 * today `POST /auth/login` always answers `two_factor_required`, but a
 * remembered-device or SSO path would answer `authenticated`, and the client is
 * already written to branch on the tag rather than to sniff which fields came
 * back.
 */
export const loginResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('two_factor_required'),
    challenge: twoFactorChallengeSchema,
  }),
  z.object({
    status: z.literal('authenticated'),
    expiresIn: z.number().int().positive(),
    session: sessionSchema,
  }),
]);

export type LoginResult = z.infer<typeof loginResultSchema>;

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
 *
 * `amr` records *how* the subject authenticated, so a route can one day demand
 * a freshly two-factored session for a sensitive action (a refund, a rate
 * override) rather than accepting any valid token.
 */
export const jwtClaimsSchema = z.object({
  sub: z.uuid(),
  email: z.email(),
  /** Active property for this token. Null only for portfolio-level sessions. */
  pid: z.uuid().nullable(),
  /** Authentication methods cleared: `pwd`, plus `otp` once the code is in. */
  amr: z.array(z.enum(['pwd', 'otp'])).default(['pwd']),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type JwtClaims = z.infer<typeof jwtClaimsSchema>;
