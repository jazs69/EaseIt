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

// The scope, the scoping extension and the RLS settings live in one place.
export {
  createTenantClient,
  currentTenantScope,
  enterPropertyScope,
  isTenantScopedModel,
  onTenantScopeBypass,
  PORTFOLIO_GLOBAL_MODELS,
  runInPropertyScope,
  scopeArguments,
  TENANT_SCOPED_MODELS,
  TenantScopeError,
  withoutTenantScope,
  type TenantScope,
} from './tenancy.js';

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
