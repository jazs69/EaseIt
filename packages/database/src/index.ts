/**
 * @repo/database — the single data-access path for EaseIt.
 *
 * Nothing outside this package imports the generated Prisma client directly;
 * the shared ESLint config enforces that. Everything goes through the
 * singleton exported here so that pooling, logging and (shortly) the
 * tenant-scoping client extension apply uniformly.
 */

import { PrismaClient, Prisma } from '../generated/client/index.js';

import { createPrismaClient } from './client-factory.js';

export * from '../generated/client/index.js';
export { Prisma };
export { createPrismaClient, connectionString } from './client-factory.js';

/* -------------------------------------------------------------------------- */
/*  Singleton                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Next.js dev mode and the Nest watcher both re-evaluate modules on every hot
 * reload. Without caching the instance on `globalThis`, each reload opens a
 * fresh connection pool and Postgres runs out of connections within minutes.
 */
const globalForPrisma = globalThis as unknown as {
  __easeitPrisma?: PrismaClient;
};

/**
 * The process-wide Prisma client. Import this rather than constructing your
 * own: `apps/api` wraps it in a Nest provider so `onModuleDestroy` can
 * disconnect cleanly on SIGTERM.
 */
export const prisma: PrismaClient = globalForPrisma.__easeitPrisma ?? createPrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.__easeitPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/* -------------------------------------------------------------------------- */
/*  Tenancy                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Models shared across the whole 10-hotel portfolio, which therefore carry no
 * `propertyId`. Everything *not* listed here is tenant-scoped and must be
 * filtered by `propertyId` on every read and write.
 *
 * The tenant-scoping client extension (CLAUDE.md section 3.2) reads this list
 * to decide which models to inject a `where` clause into, so it is
 * load-bearing: wrongly adding a model here silently disables tenant
 * isolation for it.
 */
export const PORTFOLIO_GLOBAL_MODELS: readonly Prisma.ModelName[] = [
  'Role',
  'Permission',
  'RolePermission',
  // `Property` is the tenant root itself and `User` is portfolio-wide
  // identity; both are guarded by explicit access checks rather than by a
  // blanket propertyId predicate.
  'Property',
  'User',
  // A second-factor challenge belongs to an identity, not to a hotel. It is
  // only ever read by id for the user who created it, and the sign-in flow
  // runs before any property has been resolved — so a propertyId predicate
  // would have nothing to filter on and would simply break login.
  'TwoFactorChallenge',
];

export function isTenantScopedModel(model: Prisma.ModelName): boolean {
  return !PORTFOLIO_GLOBAL_MODELS.includes(model);
}

/* -------------------------------------------------------------------------- */
/*  Error translation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Prisma codes worth translating at the repository boundary rather than
 * letting them reach a client as raw ORM output (CLAUDE.md section 5).
 */
export const PrismaErrorCode = {
  UNIQUE_CONSTRAINT: 'P2002',
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  RECORD_NOT_FOUND: 'P2025',
  TRANSACTION_TIMEOUT: 'P2028',
} as const;

/**
 * True for Postgres errors a reservation transaction may safely retry
 * (CLAUDE.md section 3.1):
 *   40001 serialization_failure
 *   23514 check_violation      — the oversell CHECK on inventory_day
 *   23P01 exclusion_violation  — two overlapping stays on one room
 */
export function isRetryableWriteConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const pgCode = (error.meta as { code?: string } | undefined)?.code;
  return pgCode === '40001' || pgCode === '23514' || pgCode === '23P01';
}
