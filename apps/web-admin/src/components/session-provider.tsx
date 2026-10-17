'use client';

/**
 * Carries the server-resolved session to client components.
 *
 * The session is fetched once, on the server, by the `(dashboard)` layout, and
 * handed down as a prop. Client components read it from this context rather
 * than fetching it themselves, which keeps three things true:
 *
 *   * **One source.** Every component sees the same permission set from the
 *     same instant, instead of racing one request each.
 *   * **No client-side cache of authority.** Nothing is written to storage, so
 *     there is no stale copy to go out of date and nothing for a user to edit.
 *     A navigation re-renders the layout and re-reads the session.
 *   * **It is still only a rendering hint.** The API re-resolves permissions
 *     from the database on every request (CLAUDE.md section 3.2), so what is
 *     held here can only ever hide or show a control — never grant anything.
 */

import type { Session } from '@repo/types';
import { createContext, useContext, type ReactNode } from 'react';

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/**
 * The current session.
 *
 * Throws outside the provider rather than returning null. A component that
 * needs the session but is rendered outside an authenticated layout is a
 * wiring bug, and silently handing it `null` would show it as an operator with
 * no permissions — which looks like a broken role assignment and sends the
 * next person debugging the database.
 */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) {
    throw new Error(
      'useSession was called outside SessionProvider. Render this component ' +
        'inside the (dashboard) layout, which resolves the session server-side.',
    );
  }
  return session;
}

/** The session, or null outside the provider. For optional chrome. */
export function useOptionalSession(): Session | null {
  return useContext(SessionContext);
}
