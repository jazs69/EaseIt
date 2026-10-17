/**
 * Server-only session helpers.
 *
 * A server component has no ambient cookie jar — `fetch` from the server does
 * not carry the browser's cookies — so every API call made during a render has
 * to forward the incoming request's own `Cookie` header explicitly. Collecting
 * that here keeps the two-line `cookies()` dance out of every page, and keeps
 * one place to change if the session ever moves.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Session } from '@repo/types';

import { fetchSession } from './auth-client';

/** The incoming request's Cookie header, for forwarding to the API. */
export async function requireCookieHeader(): Promise<string> {
  return (await cookies()).toString();
}

/**
 * The current session, or a redirect to sign-in.
 *
 * Redirects rather than returning null: middleware has already bounced a
 * request carrying no cookie at all, so reaching here without a session means
 * the cookie was present but the API rejected it — expired, forged, or
 * belonging to a deactivated account. All three mean "sign in again".
 */
export async function requireSession(): Promise<{ session: Session; cookieHeader: string }> {
  const cookieHeader = await requireCookieHeader();
  const session = await fetchSession(cookieHeader);

  if (session === null) {
    redirect('/login');
  }

  return { session, cookieHeader };
}
