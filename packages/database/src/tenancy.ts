/**
 * Tenant scoping for every query (CLAUDE.md section 3.2; MT-02, MT-03, MT-04, MT-08).
 *
 * ===========================================================================
 * Three layers, each catching what the one above misses:
 *
 *   1. **The request's tenant scope**, held in AsyncLocalStorage. It is set by
 *      the auth guards from the authenticated session and a verified grant,
 *      never from anything the client sends -- or explicitly widened with
 *      `withoutTenantScope(reason, ...)`, which is logged.
 *
 *   2. **This Prisma extension.** Every operation on a tenant-scoped model is
 *      narrowed to the scope's property: `AND propertyId = <scope>` on every
 *      read, update and delete, and `propertyId` stamped on (or checked
 *      against) every create. A tenant-scoped operation with **no scope bound
 *      throws** rather than running across all ten hotels.
 *
 *   3. **PostgreSQL row-level security**, as the backstop. Every tenant table
 *      has a default-deny policy that admits a row only when the transaction's
 *      `app.current_property_id` names its property (or `app.tenant_bypass`
 *      is on). The extension sets that inside the same transaction as the
 *      query: a standalone operation runs as a two-statement transaction
 *      (`set_config`, then the query), and an interactive transaction sets it
 *      once at the start. A raw query, a relation include or a nested write
 *      the extension cannot see is still confined by the database.
 *
 * RLS binds only a role that is neither a superuser nor BYPASSRLS. The API
 * and worker therefore connect as `easeit_app` (scripts/db-app-role.mjs);
 * migrations, seeds and test fixtures keep the owner login, and are
 * unaffected by these policies on purpose.
 * ===========================================================================
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma, type PrismaClient } from '../generated/client/index.js';

/* -------------------------------------------------------------------------- */
/*  Scope                                                                     */
/* -------------------------------------------------------------------------- */

export type TenantScope =
  | { readonly kind: 'property'; readonly propertyId: string }
  | { readonly kind: 'bypass'; readonly reason: string };

const storage = new AsyncLocalStorage<TenantScope>();

/** The scope bound to the current async context, or null. */
export function currentTenantScope(): TenantScope | null {
  return storage.getStore() ?? null;
}

/** Run `work` with every query confined to one property. */
export function runInPropertyScope<T>(propertyId: string, work: () => T): T {
  return storage.run({ kind: 'property', propertyId }, work);
}

/**
 * Bind a property for the rest of the current async execution. For guards,
 * which cannot wrap the rest of the request in a callback.
 */
export function enterPropertyScope(propertyId: string): void {
  storage.enterWith({ kind: 'property', propertyId });
}

type BypassLogger = (reason: string) => void;
let logBypass: BypassLogger = () => undefined;

/** Where `withoutTenantScope` reports itself. The API wires its logger in. */
export function onTenantScopeBypass(logger: BypassLogger): void {
  logBypass = logger;
}

/**
 * Run `work` across properties (MT-08).
 *
 * Permitted only where crossing properties is the point: sign-in and session
 * resolution (a person's grants span hotels), portfolio dashboards and
 * reports, the outbox dispatcher, and night-audit orchestration. Every call
 * names its reason and is logged; a bypass is never ambient.
 */
export function withoutTenantScope<T>(reason: string, work: () => T): T {
  if (reason.trim().length === 0) throw new Error('withoutTenantScope() needs a reason.');
  logBypass(reason);
  return storage.run({ kind: 'bypass', reason }, work);
}

/** Raised when a tenant-scoped query runs with no scope, or writes another property's row. */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

/* -------------------------------------------------------------------------- */
/*  Which models                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Models scoped by property: those with a `propertyId` column, minus the
 * portfolio-global ones. `Role` has a nullable `propertyId` (global templates
 * and per-property custom roles) and is guarded by explicit access checks.
 * The RLS migration covers exactly the tables whose `propertyId` is NOT NULL,
 * and `tenant-isolation.test.mjs` asserts the two lists agree.
 */
export const PORTFOLIO_GLOBAL_MODELS: readonly string[] = [
  'Role',
  'Permission',
  'RolePermission',
  'Property',
  'User',
  'TwoFactorChallenge',
];

export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'propertyId'))
    .map((model) => model.name)
    .filter((name) => !PORTFOLIO_GLOBAL_MODELS.includes(name)),
);

export function isTenantScopedModel(model: string | undefined): boolean {
  return model !== undefined && TENANT_SCOPED_MODELS.has(model);
}

/* -------------------------------------------------------------------------- */
/*  Narrowing the arguments                                                   */
/* -------------------------------------------------------------------------- */

type Args = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown };

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

function withPropertyWhere(where: Record<string, unknown> | undefined, propertyId: string): Record<string, unknown> {
  // AND alongside whatever was asked, so a unique selector stays unique and a
  // predicate naming another property simply matches nothing.
  const base = where ?? {};
  const existing = base['AND'];
  const and = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return { ...base, AND: [...and, { propertyId }] };
}

function stamp(row: unknown, propertyId: string, model: string): unknown {
  if (typeof row !== 'object' || row === null) return row;
  const record = row as Record<string, unknown>;
  // A relation connect (`property: { connect }`) is left to RLS WITH CHECK.
  if ('property' in record) return record;
  const given = record['propertyId'];
  if (given === undefined) return { ...record, propertyId };
  if (given !== propertyId) {
    throw new TenantScopeError(`A ${model} row for another property was written inside a property scope.`);
  }
  return record;
}

/** The operation's arguments, confined to the scope's property. */
export function scopeArguments(
  model: string | undefined,
  operation: string,
  args: unknown,
  scope: TenantScope | null,
): unknown {
  if (!isTenantScopedModel(model)) return args;
  if (scope === null) {
    throw new TenantScopeError(
      `${String(model)}.${operation} ran with no tenant scope. Bind the property (the auth guard does ` +
        'this per request) or use withoutTenantScope(reason) deliberately.',
    );
  }
  if (scope.kind === 'bypass') return args;

  const propertyId = scope.propertyId;
  const input = { ...((args ?? {}) as Args) };
  if (WHERE_OPERATIONS.has(operation)) {
    input.where = withPropertyWhere(input.where, propertyId);
  }
  if (CREATE_OPERATIONS.has(operation)) {
    input.data = Array.isArray(input.data)
      ? input.data.map((row) => stamp(row, propertyId, String(model)))
      : stamp(input.data, propertyId, String(model));
  }
  if (operation === 'upsert') {
    const upsertArgs = input as Args & { create?: unknown };
    upsertArgs.create = stamp(upsertArgs.create, propertyId, String(model));
  }
  return input;
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                */
/* -------------------------------------------------------------------------- */

/** The RLS settings for a scope, applied inside the transaction that runs the query. */
function settingsFor(base: PrismaClient, scope: TenantScope): Prisma.PrismaPromise<unknown> {
  return scope.kind === 'bypass'
    ? base.$executeRaw`SELECT set_config('app.tenant_bypass', 'on', true), set_config('app.current_property_id', '', true)`
    : base.$executeRaw`SELECT set_config('app.current_property_id', ${scope.propertyId}, true), set_config('app.tenant_bypass', '', true)`;
}

async function applySettings(tx: Prisma.TransactionClient, scope: TenantScope | null): Promise<void> {
  if (scope === null) return;
  if (scope.kind === 'bypass') {
    await tx.$executeRaw`SELECT set_config('app.tenant_bypass', 'on', true), set_config('app.current_property_id', '', true)`;
  } else {
    await tx.$executeRaw`SELECT set_config('app.current_property_id', ${scope.propertyId}, true), set_config('app.tenant_bypass', '', true)`;
  }
}

/**
 * Wrap a raw client so every query is tenant-scoped and RLS-bound.
 *
 * The returned object has the PrismaClient surface; only `$transaction`
 * behaves differently: the callback form sets the scope once at the start,
 * and the array form is refused (its items would each try to open their own
 * transaction) -- use the callback form.
 */
export function createTenantClient(base: PrismaClient): PrismaClient {
  /**
   * Inside an interactive transaction: narrow the arguments only. The
   * transaction already carries the RLS settings (set by `$transaction`
   * below), and opening another transaction here would run on a different
   * connection, outside the caller's locks.
   */
  const inTransaction = base.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scopeArguments(model, operation, args, currentTenantScope()) as typeof args);
        },
      },
    },
  });

  /**
   * Standalone: narrow, then run the query in a two-statement transaction with
   * the RLS settings, so the setting and the query share one connection.
   *
   * Global models get the settings too whenever a scope is bound: a query on
   * `User` that filters or includes a tenant relation (`propertyRoles`) reads
   * a tenant table, and without the setting RLS hides every related row -- the
   * staff list returned nobody until this applied to all models. With no scope
   * a global query runs as it is (sign-in, before any property exists).
   */
  const standalone = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scope = currentTenantScope();
          const scoped = scopeArguments(model, operation, args, scope);
          if (scope === null) return query(scoped as typeof args);
          const [, result] = await base.$transaction([settingsFor(base, scope), query(scoped as typeof args)]);
          return result;
        },
      },
      async $queryRaw({ args, query }) {
        const scope = currentTenantScope();
        if (scope === null) return query(args);
        const [, result] = await base.$transaction([settingsFor(base, scope), query(args)]);
        return result;
      },
      async $executeRaw({ args, query }) {
        const scope = currentTenantScope();
        if (scope === null) return query(args);
        const [, result] = await base.$transaction([settingsFor(base, scope), query(args)]);
        return result;
      },
    },
  });

  const transaction = (arg: unknown, options?: unknown): unknown => {
    if (typeof arg !== 'function') {
      throw new TenantScopeError(
        'Array-form $transaction([...]) cannot carry the tenant scope; use $transaction(async (tx) => ...).',
      );
    }
    const work = arg as (tx: Prisma.TransactionClient) => Promise<unknown>;
    // The tx client comes from the narrowing-only extension; the RLS settings
    // are applied as its first statements.
    return (inTransaction as unknown as PrismaClient).$transaction(async (tx) => {
      await applySettings(tx, currentTenantScope());
      return work(tx);
    }, options as Parameters<PrismaClient['$transaction']>[1]);
  };

  // Safe: a query-only extension does not change the client's surface, so the
  // extended client is a PrismaClient for every caller; only $transaction is
  // replaced, with the same callback signature.
  return new Proxy(standalone as unknown as PrismaClient, {
    get(target, property, receiver) {
      if (property === '$transaction') return transaction;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}
