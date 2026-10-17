/**
 * The client half of two-step sign-in.
 *
 * Note what is *not* here: any notion of a token. The API sets the session as
 * an httpOnly cookie, so this module never sees it, never stores it, and
 * cannot leak it. What it does persist is the outstanding challenge id, which
 * is a one-use handle worth nothing without the operator's mailbox — see
 * `rememberChallenge` for why that is safe and why it uses sessionStorage.
 */

import {
  authenticatedResponseSchema,
  loginResultSchema,
  sessionSchema,
  twoFactorChallengeSchema,
  type AuthenticatedResponse,
  type LoginRequest,
  type LoginResult,
  type Session,
  type TwoFactorChallenge,
} from '@repo/types';

import { apiFetch, ApiRequestError } from './api';

/* -------------------------------------------------------------------------- */
/*  Calls                                                                     */
/* -------------------------------------------------------------------------- */

export function requestSignIn(credentials: LoginRequest): Promise<LoginResult> {
  return apiFetch('/auth/login', loginResultSchema, {
    method: 'POST',
    body: credentials,
  });
}

export function verifyCode(
  challengeId: string,
  code: string,
): Promise<AuthenticatedResponse> {
  return apiFetch('/auth/verify-otp', authenticatedResponseSchema, {
    method: 'POST',
    body: { challengeId, code },
  });
}

export function resendCode(challengeId: string): Promise<TwoFactorChallenge> {
  return apiFetch('/auth/resend-otp', twoFactorChallengeSchema, {
    method: 'POST',
    body: { challengeId },
  });
}

export function signOut(): Promise<void> {
  return apiFetch('/auth/logout', null, { method: 'POST' });
}

/**
 * The current session, or null when there is none.
 *
 * `cookieHeader` is for server components, which have no ambient cookie jar
 * and must forward the incoming request's own header.
 */
export async function fetchSession(cookieHeader?: string): Promise<Session | null> {
  try {
    return await apiFetch('/auth/session', sessionSchema, {
      ...(cookieHeader === undefined ? {} : { cookieHeader }),
    });
  } catch (error) {
    // Not signed in is an ordinary outcome of asking, not an error. Anything
    // else — a 500, an unreachable API — propagates, because rendering a
    // signed-out shell because the API is down hides a real fault.
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
      return null;
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*  Challenge persistence                                                     */
/* -------------------------------------------------------------------------- */

const CHALLENGE_KEY = 'easeit.pms.2fa.challenge';

/**
 * Keeps the open challenge across a page refresh.
 *
 * ===========================================================================
 * Storing this in the browser is safe, and worth being explicit about why:
 *
 *   * It is **not a credential.** The challenge id alone authenticates
 *     nobody; it has to be presented together with a code that only reaches
 *     the operator's mailbox.
 *   * It is **attempt-bounded.** Five wrong codes and the server burns it.
 *   * It is **short-lived.** Ten minutes per code, thirty for the challenge.
 *
 * `sessionStorage`, not `localStorage`: a front-desk terminal is shared, and
 * a half-finished sign-in must not still be sitting there for the next shift.
 * Every access is wrapped — storage throws in private mode and with site data
 * blocked, and a verification screen that cannot persist its handle should
 * degrade to "refresh loses it", never to a crash.
 * ===========================================================================
 */
export interface RememberedChallenge {
  challenge: TwoFactorChallenge;
  /** Shown as "signing in as…", and used to prefill on a restart. */
  email: string;
}

/* -- The store ------------------------------------------------------------- */

/**
 * Exposed as an external store (`useSyncExternalStore`) rather than copied
 * into component state behind an effect.
 *
 * Storage genuinely *is* an external system, and the effect-then-setState
 * version is the cascading render the react-hooks rule rejects: it renders the
 * credentials step, then immediately re-renders the verification step. The
 * store subscribes properly, and `getServerSnapshot` returning null is what
 * makes SSR and hydration agree — React renders the server snapshot while
 * hydrating and only then reconciles with the client's.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToChallenge(listener: Listener): () => void {
  listeners.add(listener);
  // `storage` fires for sessionStorage too, in other tabs of the same origin.
  const onStorage = (): void => {
    emitChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * `useSyncExternalStore` demands a referentially stable snapshot, and parsing
 * allocates a fresh object every call — returning a new one each time is an
 * infinite render loop. Cached against the raw string, so the object identity
 * only changes when the stored value actually does.
 */
let rawCache: string | null = null;
let valueCache: RememberedChallenge | null = null;
let cachePrimed = false;

function safeRead(): string | null {
  try {
    return sessionStorage.getItem(CHALLENGE_KEY);
  } catch {
    // Private mode, or site data blocked.
    return null;
  }
}

export function getChallengeSnapshot(): RememberedChallenge | null {
  const raw = safeRead();
  if (!cachePrimed || raw !== rawCache) {
    rawCache = raw;
    valueCache = raw === null ? null : parseChallenge(raw);
    cachePrimed = true;
  }
  return valueCache;
}

/** No storage during SSR, so the server always renders the credentials step. */
export function getChallengeServerSnapshot(): RememberedChallenge | null {
  return null;
}

export function rememberChallenge(remembered: RememberedChallenge): void {
  try {
    sessionStorage.setItem(CHALLENGE_KEY, JSON.stringify(remembered));
  } catch {
    // Non-fatal: the screen still works, a refresh just starts over.
  }
  emitChange();
}

export function forgetChallenge(): void {
  try {
    sessionStorage.removeItem(CHALLENGE_KEY);
  } catch {
    // Nothing to do; the entry expires with the tab regardless.
  }
  emitChange();
}

/** Narrows untrusted storage back to a challenge. Never trusts the JSON. */
function parseChallenge(raw: string): RememberedChallenge | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { challenge, email } = parsed as Record<string, unknown>;
    if (typeof email !== 'string') return null;

    // Validated rather than trusted: storage is user-writable, and this value
    // decides what the screen claims to be doing.
    const result = twoFactorChallengeSchema.safeParse(challenge);
    if (!result.success) return null;

    // A challenge past the server's absolute window is already dead there, so
    // showing it would only offer a countdown that can never succeed. Note
    // this does not write to storage — a snapshot getter must stay pure, or it
    // re-enters the store it is being read from.
    if (Date.parse(result.data.expiresAt) + 20 * 60 * 1_000 < Date.now()) {
      return null;
    }

    return { challenge: result.data, email };
  } catch {
    return null;
  }
}
