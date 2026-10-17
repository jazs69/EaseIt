/**
 * The identity an authentication guard puts on the request.
 *
 * Deliberately minimal: identity only. Roles and permissions are *not* carried
 * here — they are resolved per request against the active property by
 * `ActivePropertyGuard`, so a revoked grant takes effect immediately rather
 * than when a token happens to expire (CLAUDE.md section 5).
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  /**
   * Which factors this session cleared. Always includes `pwd`; includes `otp`
   * once the emailed code was accepted. Carried so a future route can demand
   * a two-factored session for a sensitive action rather than accepting any
   * valid token.
   */
  authMethods: readonly ('pwd' | 'otp')[];
  /**
   * The property this session was issued for, from the token's `pid` claim.
   *
   * A *preference*, not an authorisation: `ActivePropertyGuard` still
   * re-verifies the grant on every request, and ignores this entirely in
   * favour of the route's own `:propertyId`. It exists so that rebuilding the
   * session (`GET /auth/session`) lands the operator back where they were.
   */
  activePropertyId: string | null;
}

/** Fastify request as the auth and property guards leave it. */
export interface AuthenticatedRequest {
  user?: AuthenticatedUser;
  activePropertyContext?: import('@repo/types').ActivePropertyContext;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  ip?: string;
  id: string;
}
