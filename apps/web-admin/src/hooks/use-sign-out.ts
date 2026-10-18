'use client';

/**
 * Signing out, in one place.
 *
 * ===========================================================================
 * The sidebar and the account popover both offer it, so it lives here.
 *
 * Two implementations of "end the session" is how one of them ends up skipping
 * a step — and the step most likely to be skipped is the one nobody sees, like
 * discarding the half-finished two-factor challenge.
 *
 * WHAT THIS DOES *NOT* DO, AND WHY
 * There are no tokens to purge from `localStorage` or `sessionStorage`. The
 * session is an HttpOnly cookie that JavaScript cannot read or write, which is
 * the point of it — an XSS on this app cannot exfiltrate the session. So there
 * is no `removeItem('accessToken')` here, because there was never a
 * `setItem('accessToken')`.
 *
 * There is no query cache to clear either. The admin shell is Server
 * Components: data is fetched per request on the server and held in Next's
 * router cache, not in a client-side store. `router.refresh()` is what
 * discards it, and it is the real equivalent of `queryClient.clear()`.
 *
 * The sidebar's collapsed/expanded preference is deliberately left alone. It
 * is a per-browser display preference, not session state, and resetting the
 * furniture of a shared terminal on every sign-out would be a small daily
 * annoyance for no security benefit.
 * ===========================================================================
 */

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { forgetChallenge, signOut } from '@/lib/auth-client';

export interface SignOutState {
  signingOut: boolean;
  signOutNow: () => Promise<void>;
}

export function useSignOut(): SignOutState {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOutNow = useCallback(async (): Promise<void> => {
    setSigningOut(true);

    try {
      // Clears the cookie *and* revokes every session token the account holds,
      // so a copy of the token cannot be replayed for the rest of its life.
      await signOut();
    } catch {
      /**
       * Deliberately swallowed, and this is the one place it is right to.
       *
       * The operator asked to leave. Stranding them on a dashboard because the
       * API was unreachable is the worse outcome, and the cookie they keep is
       * rejected on its next use anyway. The alternative — surfacing the error
       * and staying put — protects nothing and traps somebody at a terminal
       * they are walking away from.
       */
    }

    // A half-finished two-factor challenge is the one piece of auth state that
    // does live in the browser. Signing out must not leave the next person at
    // this terminal holding it.
    forgetChallenge();

    // `replace`, not `push`: Back must not return to the dashboard. Middleware
    // would bounce it to /login anyway, but leaving the entry in history means
    // a visible flash of a screen the operator has signed out of.
    router.replace('/login');
    // Discards the router cache, so no server-rendered page from the old
    // session is replayed from memory.
    router.refresh();
  }, [router]);

  return { signingOut, signOutNow };
}
