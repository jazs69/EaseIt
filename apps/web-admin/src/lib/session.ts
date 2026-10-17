/**
 * Client-side form validation and terminal preferences for sign-in.
 *
 * ===========================================================================
 * What used to be here, and where it went.
 *
 * This file held `signInStub`, which compared a seeded password in the browser
 * and wrote a fake session into `sessionStorage`. All of it is gone. Sign-in is
 * now `apps/api`'s `auth` module:
 *
 *   * credentials go to `POST /api/v1/auth/login`              -> auth-client.ts
 *   * the second factor goes to `POST /api/v1/auth/verify-otp` -> auth-client.ts
 *   * **the API** sets the session as an httpOnly cookie       -> session-cookie.ts
 *   * the session is read server-side from that cookie         -> fetchSession()
 *   * routes are gated in middleware, not by reading storage   -> middleware.ts
 *
 * No session is cached in the browser any more, and no token is reachable from
 * JavaScript at all. What remains in storage is one convenience that is not a
 * credential: the email address this terminal last used.
 * ===========================================================================
 */

import { loginRequestSchema, type LoginRequest } from '@repo/types';

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export interface FieldErrors {
  email?: string;
  password?: string;
}

/**
 * Validates against `loginRequestSchema` from @repo/types rather than a second
 * local schema — one wire contract, one definition (CLAUDE.md section 5). Note
 * this makes the identifier an **email**, not a free-form username: widening it
 * means changing the shared DTO first.
 *
 * This is for immediate feedback only. The API validates the same schema again
 * and is the decision that counts.
 */
export function validateCredentials(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};

  if (email.trim().length === 0) {
    errors.email = 'Enter your work email.';
  }
  if (password.length === 0) {
    errors.password = 'Enter your password.';
  }
  if (Object.keys(errors).length > 0) {
    return errors;
  }

  const parsed = loginRequestSchema.safeParse({ email, password });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === 'email' && errors.email === undefined) {
        errors.email = 'That does not look like a valid email address.';
      }
      if (field === 'password' && errors.password === undefined) {
        errors.password = issue.message;
      }
    }
  }

  return errors;
}

/**
 * Email-only check, used for on-blur feedback before a password has been
 * typed. Reuses the email field of the shared DTO rather than a second regex.
 */
export function validateEmail(email: string): string | undefined {
  if (email.trim().length === 0) return undefined;
  const parsed = loginRequestSchema.shape.email.safeParse(email);
  return parsed.success ? undefined : 'That does not look like a valid email address.';
}

export function toLoginRequest(email: string, password: string): LoginRequest | null {
  const parsed = loginRequestSchema.safeParse({ email, password });
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/*  Remembered email (a convenience, not a credential)                        */
/* -------------------------------------------------------------------------- */

/**
 * Read through `useSyncExternalStore`, not through a `useEffect` that calls
 * `setState` on mount. The effect version triggers the cascading render the
 * react-hooks lint rule flags, and it also renders one frame with the wrong
 * value before correcting itself.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode, or site data blocked.
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Non-fatal: the field just starts empty next time.
  }
}

/** Subscribes to both in-tab writes and cross-tab `storage` events. */
export function subscribeToTerminalPreferences(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (): void => {
    emitChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export const REMEMBERED_EMAIL_KEY = 'easeit.pms.terminal.email';

export function rememberEmail(email: string | null): void {
  safeSet(REMEMBERED_EMAIL_KEY, email);
  emitChange();
}

/** A string snapshot is a primitive, so it needs no reference cache. */
export function getRememberedEmailSnapshot(): string {
  return safeGet(REMEMBERED_EMAIL_KEY) ?? '';
}

export function getRememberedEmailServerSnapshot(): string {
  return '';
}
