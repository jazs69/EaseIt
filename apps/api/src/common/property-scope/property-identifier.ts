/**
 * One definition of "which property is this request about, and may this user
 * see it".
 *
 * ===========================================================================
 * Why this file exists.
 *
 * Thirteen services each carried their own copy of the same two decisions:
 * how a `:hotelId` route parameter is matched against a property, and that the
 * match must go through a `UserPropertyRole` grant. The copies had not drifted
 * -- the UUID pattern was character-identical in all thirteen -- but thirteen
 * copies of a security predicate is a question of when, not whether. Nothing
 * stopped a fourteenth service from resolving a property without the grant
 * join, and nothing would have noticed.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not own the query. Each call site keeps its own `findFirst` or
 * `findMany`, its own `select` projection, its own return shape, and its own
 * choice of throwing or returning `null` -- those differ for real reasons (a
 * site that needs the user's roles must use `findMany`, because one user can
 * hold several roles at one property) and collapsing them would have been a
 * rewrite dressed up as a refactor. Only the two decisions above moved.
 *
 * It does not decide property-status policy either. Nine of the thirteen sites
 * do not filter on property status and four do, so `operableOnly` is a
 * REQUIRED argument rather than a default: every call site states its own
 * answer, and the inconsistency becomes visible at thirteen call sites instead
 * of invisible in thirteen copies. Whether nine or four are right is a product
 * decision, and making it silently inside this change would have been the
 * wrong way to settle it.
 *
 * It does not read request state. No AsyncLocalStorage, no Prisma client
 * extension, no row-level security -- those are a different, larger design.
 * These are pure functions over their arguments, which is also what lets the
 * unit suite execute them: a decorated Nest service could not be imported by a
 * `.mjs` test, because decorators are not type syntax and Node's type
 * stripping cannot erase them.
 * ===========================================================================
 */

/**
 * Type-only, deliberately.
 *
 * `@repo/database`'s entry point constructs a Prisma client at module scope,
 * which needs `DATABASE_URL`. A value import would therefore make this file
 * impossible to load in a unit test -- and being loadable without a database
 * is the whole reason the logic lives in pure functions rather than an
 * injected service. `import type` is erased, so nothing is loaded at runtime.
 */
import type { Prisma } from '@repo/database';
import { OPERABLE_PROPERTY_STATUSES } from '@repo/types';

/**
 * The pattern every one of the thirteen copies used, character for character.
 *
 * ===========================================================================
 * Copied, not improved. It accepts any 8-4-4-4-12 hex shape, case
 * insensitively, with no UUID version or variant validation -- so a
 * `00000000-0000-0000-0000-000000000000` is treated as an id, and so is a v1
 * or v7 UUID. That is deliberate: this file consolidates thirteen behaviours,
 * it does not change one. Tightening the pattern would silently reclassify
 * some identifier as a code and send it to a different column, which is
 * exactly the class of change a consolidation must not make.
 *
 * It is also why `''` and `'   '` resolve as *codes*: `.test()` says no, so
 * the `else` branch takes them. They match no property, which is the correct
 * outcome and the same one as today.
 * ===========================================================================
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which property column a `:hotelId` route parameter should be matched against.
 *
 * `codeOrId` is typed `string` because that is what it always is: all thirteen
 * call sites receive it from `@Param('hotelId')`, a Fastify route parameter,
 * which cannot be absent or non-string and cannot be an empty path segment.
 * The contract is kept honest rather than widened to handle inputs no caller
 * can produce -- and TypeScript's strict mode stops one appearing.
 */
export function propertyWhereFromIdentifier(codeOrId: string): { id: string } | { code: string } {
  return UUID_SHAPE.test(codeOrId) ? { id: codeOrId } : { code: codeOrId };
}

export interface GrantedPropertyWhereInput {
  /** The authenticated user. Never a client-supplied value. */
  userId: string;
  /** The `:hotelId` route parameter: a property code, or a property UUID. */
  codeOrId: string;
  /**
   * Whether to require an operable property status.
   *
   * Required, not defaulted: see the file header. Four call sites pass `true`
   * and nine pass `false`, each preserving what it does today.
   */
  operableOnly: boolean;
}

/**
 * The `where` for finding a property the user actually holds a grant on.
 *
 * ===========================================================================
 * The `userId` clause is the authorisation, and that is the whole point.
 *
 * `:hotelId` is never treated as a property id. It is only ever a *match
 * candidate* inside a predicate whose first clause is the authenticated
 * `userId`, so an identifier naming a property the user has no grant on
 * matches zero rows and the caller reports not-found. A client cannot widen
 * this by supplying anything, because the only thing it supplies is the
 * candidate.
 *
 * `userId` is a required field of a required argument, so this function cannot
 * be called without one; a unit test additionally asserts that the returned
 * predicate always carries it, because "the query was accidentally
 * unfiltered" is the one failure here that would be catastrophic and silent.
 * ===========================================================================
 */
export function grantedPropertyWhere({
  userId,
  codeOrId,
  operableOnly,
}: GrantedPropertyWhereInput): Prisma.UserPropertyRoleWhereInput {
  const identifier = propertyWhereFromIdentifier(codeOrId);

  return {
    userId,
    property: operableOnly
      ? { status: { in: [...OPERABLE_PROPERTY_STATUSES] }, ...identifier }
      : identifier,
  };
}
