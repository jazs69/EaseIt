/**
 * Environment validation. The API refuses to boot on invalid configuration
 * rather than failing later with a confusing runtime error (CLAUDE.md
 * section 2).
 */

import { z } from 'zod';

/**
 * z.coerce.boolean() is wrong for env vars: it applies JS truthiness, so the
 * string "false" becomes true. Parse the literal spellings instead.
 */
const booleanFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'));

/**
 * `8h`, `45m`, `30s`, `7d`, or a bare count of seconds.
 *
 * Parsed here rather than handed to a JWT library's own parser, because the
 * cookie's `Max-Age` and the token's `exp` have to agree exactly — deriving
 * both from one integer is what guarantees that.
 */
const durationSecondsFromEnv = z
  .string()
  .trim()
  .regex(/^\d+(?:[smhd])?$/, 'Expected a duration like 8h, 45m, 3600 or 7d')
  .transform((value) => {
    const unit = value.at(-1) ?? '';
    const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400 }[unit];
    return multiplier === undefined
      ? Number.parseInt(value, 10)
      : Number.parseInt(value.slice(0, -1), 10) * multiplier;
  })
  .pipe(z.number().int().positive());

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),

    /** Pooled connection used at runtime. */
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    /** Unpooled connection for Prisma Migrate. Optional outside migrations. */
    DIRECT_URL: z.string().min(1).optional(),

    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    /**
     * Signs session tokens, and — via a labelled HKDF-style derivation, never
     * directly — peppers the stored OTP hashes. One secret, two
     * domain-separated keys, so rotating it invalidates both at once.
     */
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters of real entropy'),
    // `prefault`, not `default`: this field parses a string into a number, and
    // zod 4's `default` applies on the *output* side (so it would demand a
    // number here). `prefault` substitutes the value before parsing, which
    // keeps the default spelled the way the env var is.
    JWT_EXPIRES_IN: durationSecondsFromEnv.prefault('8h'),

    /* -- Session cookie --------------------------------------------------- */

    AUTH_COOKIE_NAME: z.string().min(1).default('easeit_session'),
    /**
     * Set to the registrable domain (`.yourdomain.com`) in production so the
     * cookie the API sets on api.yourdomain.com is readable by the admin app
     * on pms.yourdomain.com. Left unset in development: `localhost` is
     * host-only and cookies ignore the port, so :4000 and :3001 already share.
     */
    AUTH_COOKIE_DOMAIN: z.string().min(1).optional(),
    /**
     * Unset means "Secure in production, not in development". Overriding it
     * to false in production is refused below — an auth cookie sent over
     * cleartext is interceptable.
     */
    AUTH_COOKIE_SECURE: booleanFromEnv.optional(),

    /* -- Outbound mail ---------------------------------------------------- */

    /**
     * Unset in development selects the logging transport, which writes the
     * rendered message to the API log instead of sending it. Required in
     * production, where there is no fallback: without a transport no operator
     * could ever receive a code and every sign-in would fail.
     */
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    /** True for implicit TLS on 465. Leave false for STARTTLS on 587. */
    SMTP_SECURE: booleanFromEnv.default(false),
    SMTP_USER: z.string().min(1).optional(),
    /**
     * Whitespace is stripped before use.
     *
     * Google displays an App Password as four groups of four characters
     * ("xxxx xxxx xxxx xxxx") and people paste it exactly as shown. Gmail's
     * SMTP server rejects it with those spaces, and the resulting error is an
     * unhelpful "Username and Password not accepted" that looks like a wrong
     * password rather than a formatting problem. Normalising here means the
     * value can be pasted either way.
     */
    SMTP_PASS: z
      .string()
      .min(1)
      .transform((value) => value.replace(/\s+/g, ''))
      .optional(),
    /** RFC 5322 From header, e.g. `"EaseIt Security" <no-reply@example.com>`. */
    SMTP_FROM: z.string().min(1).default('EaseIt Security <no-reply@easeit.local>'),
    SMTP_REPLY_TO: z.string().min(1).optional(),

    /**
     * Which GSTIN verification provider to use.
     *
     * `mock` returns synthetic taxpayer data so the booking form can be built
     * and demonstrated without paid API credits. It is **refused in
     * production** by the refinement below, because a fabricated legal name is
     * not a harmless placeholder: it is the name a tax invoice is issued in,
     * and one that reached a real invoice would be filed, claimed against, and
     * discovered by an auditor rather than by us.
     */
    GST_PROVIDER: z.enum(['mock', 'sandbox', 'cashfree']).default('mock'),
    GST_API_KEY: z.string().min(1).optional(),
    GST_API_SECRET: z.string().min(1).optional(),
    /** Seconds before a provider lookup is abandoned. */
    GST_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(4_000),

    /** Comma-separated list of allowed browser origins. */
    API_CORS_ORIGINS: z.string().default(''),

    SWAGGER_ENABLED: booleanFromEnv.default(true),
  })
  .superRefine((env, ctx) => {
    // Applies in every environment: a transport configured with a username
    // and no password (or the reverse) authenticates as nobody and fails on
    // the first send, which is a long way from the typo that caused it.
    if (env.SMTP_HOST !== undefined) {
      const hasUser = env.SMTP_USER !== undefined;
      const hasPass = env.SMTP_PASS !== undefined;
      if (hasUser !== hasPass) {
        ctx.addIssue({
          code: 'custom',
          path: [hasUser ? 'SMTP_PASS' : 'SMTP_USER'],
          message:
            'SMTP_USER and SMTP_PASS must be set together. Set both for an ' +
            'authenticated relay, or neither for an open local one.',
        });
      }
    }

    // A live provider with no credentials would fall back to mock data
    // silently, which is the failure mode this whole feature has to avoid.
    if (env.GST_PROVIDER !== 'mock' && env.GST_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['GST_API_KEY'],
        message:
          `GST_PROVIDER is "${env.GST_PROVIDER}" but GST_API_KEY is unset. ` +
          'Set the key, or use GST_PROVIDER="mock" to work with clearly ' +
          'marked synthetic data.',
      });
    }

    if (env.NODE_ENV !== 'production') return;

    if (env.SMTP_HOST === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message:
          'SMTP_HOST is required in production: sign-in needs a real mail ' +
          'transport to deliver two-factor codes, and the development log ' +
          'fallback is not available here.',
      });
    }

    if (env.GST_PROVIDER === 'mock') {
      ctx.addIssue({
        code: 'custom',
        path: ['GST_PROVIDER'],
        message:
          'GST_PROVIDER cannot be "mock" in production. Mock lookups return ' +
          'invented company names, and a fabricated legal name on a tax ' +
          'invoice is a document somebody files and claims against.',
      });
    }

    if (env.AUTH_COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SECURE'],
        message: 'AUTH_COOKIE_SECURE cannot be disabled in production.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}

export function corsOrigins(env: Env): string[] {
  return env.API_CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
