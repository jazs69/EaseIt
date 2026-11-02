'use client';

/**
 * Holds the two-step sign-in state machine: credentials, then the emailed code.
 *
 * One client component rather than two routes. A `/login/verify` page would
 * have to be reachable by URL, which means either a challenge id in the query
 * string — a one-use handle in browser history and in any shared link — or a
 * route that is simply blank when visited directly. A step machine has neither
 * problem.
 *
 * The open challenge lives in the `auth-client` store, not in local state, so
 * which step to show is read straight from the thing that persists it. That is
 * what lets a refresh mid-verification resume instead of starting over, with
 * no copy of the same fact in two places to fall out of step.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import type { TwoFactorChallenge } from '@repo/types';

import {
  forgetChallenge,
  getChallengeServerSnapshot,
  getChallengeSnapshot,
  rememberChallenge,
  subscribeToChallenge,
} from '@/lib/auth-client';
import { signedInDestination } from '@/lib/auth-routing';

import { LoginForm } from './login-form';
import { VerifyForm } from './verify-form';

export function SignInPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The store is the single source of truth for "is there an open challenge".
  const pending = useSyncExternalStore(
    subscribeToChallenge,
    getChallengeSnapshot,
    getChallengeServerSnapshot,
  );

  // Not persisted: a reason only makes sense for the transition that produced
  // it, and surviving a refresh would show a stale explanation.
  const [restartReason, setRestartReason] = useState<string | null>(null);

  function handleChallenge(challenge: TwoFactorChallenge, email: string): void {
    setRestartReason(null);
    rememberChallenge({ challenge, email });
  }

  function handleChallengeUpdated(challenge: TwoFactorChallenge): void {
    if (pending === null) return;
    rememberChallenge({ challenge, email: pending.email });
  }

  function handleRestart(reason: string): void {
    forgetChallenge();
    setRestartReason(reason.length > 0 ? reason : null);
  }

  function handleAuthenticated(): void {
    // The session arrives in the response body, but nothing is kept here: the
    // dashboard reads it server-side from the httpOnly cookie that the same
    // response set. Caching a copy in the client is how a stale permission set
    // ends up gating a UI.
    forgetChallenge();
    /**
     * Back to wherever they were headed, or the group dashboard.
     *
     * =====================================================================
     * `next` is written by middleware when it turns an unauthenticated
     * request away, and until now nothing read it: this line was a hard-coded
     * `/group-dashboard`, so a clerk who followed a link to one folio,
     * signed in, and landed on the portfolio picker had to find their way
     * back by hand.
     *
     * It is run through `signedInDestination` rather than used as given.
     * The parameter reaches this component through the URL bar, so it is
     * attacker input regardless of who wrote it first, and a raw
     * `router.replace(next)` would be an open redirect — `//evil.com` starts
     * with a slash and is an authority, not a path. Anything that is not a
     * plainly safe same-origin path is discarded for the default.
     * =====================================================================
     *
     * `replace`, not `push`: the sign-in screen must not be one Back press
     * away from an authenticated session.
     *
     * The group dashboard as the fallback, not a property: a staff member may
     * hold roles at several hotels, and the server does not guess which one
     * they meant. Those with exactly one still choose it explicitly, which is
     * what makes the active property an audited decision rather than a
     * default.
     */
    router.replace(signedInDestination(searchParams.get('next')));
    // Discards any cached server render of the dashboard from a previous
    // session, so the new operator's own data is what renders.
    router.refresh();
  }

  if (pending !== null) {
    return (
      <VerifyForm
        challenge={pending.challenge}
        email={pending.email}
        onChallengeUpdated={handleChallengeUpdated}
        onVerified={handleAuthenticated}
        onRestart={handleRestart}
      />
    );
  }

  return (
    <LoginForm
      onChallenge={handleChallenge}
      onAuthenticated={handleAuthenticated}
      initialError={restartReason}
    />
  );
}
