/**
 * Route gating for the staff dashboard.
 *
 * ===========================================================================
 * What this is, and deliberately is not.
 *
 * This checks that a session cookie is *present*, not that it is *valid*. It
 * does not verify the signature, and that is on purpose:
 *
 *   * Verifying here would put `JWT_SECRET` into the admin app's environment.
 *     The signing key belongs to exactly one process — the API — and copying
 *     it into a second deployment doubles the places it can leak from for no
 *     security gain.
 *   * It would also not be the real check. Every page under `/dashboard`
 *     fetches its data from the API, which verifies the token on every request
 *     and rejects it regardless of what middleware concluded. Authorisation
 *     lives there (CLAUDE.md section 3.2).
 *
 * So this layer exists for one honest reason: to turn "render a shell, fetch,
 * get a 401, redirect" into an immediate redirect. A forged cookie gets past
 * middleware and then fails at the API, which is the correct ordering — the
 * cheap check is cheap, and the authoritative check is authoritative.
 *
 * Because it cannot tell valid from invalid, it no longer makes any decision
 * that depends on knowing. It used to redirect away from `/login` whenever a
 * cookie merely existed, which produced a closed redirect cycle for every
 * operator whose session had expired or been revoked — the sign-in form became
 * unreachable. `decideAuthRoute` in `lib/auth-routing.ts` holds that rule now,
 * with the reasoning, and the "you are already signed in" redirect moved to the
 * login page, which can ask the API and only acts on a confirmed answer.
 *
 * The decisions live in that module rather than here so they can be unit
 * tested: this file imports `next/server`, which plain Node cannot load, and
 * an open-redirect guard that cannot be tested is not a guard.
 * ===========================================================================
 */

import { NextResponse, type NextRequest } from 'next/server';

import { decideAuthRoute, SESSION_COOKIE_NAME } from '@/lib/auth-routing';

export function middleware(request: NextRequest): NextResponse {
  const route = decideAuthRoute({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    // Presence only. See the note above on why validity is not checked here.
    hasSession: request.cookies.has(SESSION_COOKIE_NAME),
  });

  if (route.kind === 'allow') return NextResponse.next();

  // `to` is always a same-origin path built by `decideAuthRoute`; resolving it
  // against the request keeps the origin and port of the current deployment.
  return NextResponse.redirect(new URL(route.to, request.url));
}

export const config = {
  /**
   * Everything except Next's own asset routes and the favicon. Matching the
   * dashboard routes by name instead would silently leave each new
   * authenticated route unguarded until somebody remembered to add it here.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
