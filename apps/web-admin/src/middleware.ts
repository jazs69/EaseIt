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
 * ===========================================================================
 */

import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = process.env.NEXT_PUBLIC_AUTH_COOKIE_NAME ?? 'easeit_session';

/** Everything a signed-out visitor may reach. */
const PUBLIC_PATHS = ['/login'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    // Already signed in and asking for the login screen: send them on. Note
    // this is a presence check too, so an expired cookie bounces to the group
    // dashboard, which then redirects back — one extra hop, and the cookie is
    // cleared on the way. Preferable to parsing a token here.
    if (hasSession) {
      return NextResponse.redirect(new URL('/group-dashboard', request.url));
    }
    return NextResponse.next();
  }

  if (!hasSession) {
    const signIn = new URL('/login', request.url);
    // Preserved so the operator lands where they were trying to go. Only the
    // path and query are kept — taking a full URL from the request would let
    // a crafted link turn this into an open redirect.
    if (pathname !== '/') {
      signIn.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    }
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except Next's own asset routes and the favicon. Matching the
   * dashboard routes by name instead would silently leave each new
   * authenticated route unguarded until somebody remembered to add it here.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
