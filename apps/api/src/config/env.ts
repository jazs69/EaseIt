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

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),

  /** Pooled connection used at runtime. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Unpooled connection for Prisma Migrate. Optional outside migrations. */
  DIRECT_URL: z.string().min(1).optional(),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters of real entropy'),
  JWT_EXPIRES_IN: z.string().default('8h'),

  /** Comma-separated list of allowed browser origins. */
  API_CORS_ORIGINS: z.string().default(''),

  SWAGGER_ENABLED: booleanFromEnv.default(true),
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
