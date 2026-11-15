'use client';

/**
 * The three signed-out account pages (AU-08, AU-14):
 *
 *   forgot  -- ask for a reset link. The answer is the same for every address.
 *   reset   -- set a new password with an emailed link.
 *   accept  -- set a first password with an invitation link.
 *
 * The link's token travels in the URL *fragment* (`#token=...`), which
 * browsers never send to a server, so it is read here, client-side, and never
 * appears in an access log or a Referer header. It is removed from the
 * address bar as soon as it has been read.
 */

import { passwordPolicySchema } from '@repo/types';
import { CheckCircle2, KeyRound, Loader2, Mail } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { ApiRequestError } from '@/lib/api';
import { requestPasswordReset, setPasswordWithToken } from '@/lib/auth-client';

type Mode = 'forgot' | 'reset' | 'accept';

const COPY: Record<Mode, { title: string; lead: string; button: string }> = {
  forgot: {
    title: 'Reset your password',
    lead: 'Enter your work email. If it belongs to an account, we will email a link to set a new password.',
    button: 'Email me a link',
  },
  reset: {
    title: 'Set a new password',
    lead: 'Choose a new password. Every device signed in to your account will be signed out.',
    button: 'Set password',
  },
  accept: {
    title: 'Welcome to EaseIt',
    lead: 'Choose a password to finish setting up your account.',
    button: 'Set password',
  },
};

const inputClass =
  'h-11 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-blue-500/50';

/**
 * The token, read from the fragment once and kept: the fragment is then cleared
 * from the address bar, and later renders must still see what was read.
 * `undefined` on the server and before the first client read.
 */
let cachedToken: string | null | undefined;
function readToken(): string | null {
  if (cachedToken === undefined) {
    const match = /(?:^#|&)token=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
    cachedToken = match?.[1] ?? null;
  }
  return cachedToken;
}
const noSubscription = (): (() => void) => () => undefined;

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'AUTH_TOKEN_INVALID') {
      return 'This link is invalid or has expired, or it has already been used. Ask for a new one.';
    }
    if (error.code === 'RATE_LIMITED') return 'Too many attempts. Wait a few minutes and try again.';
    return error.message;
  }
  return 'Something went wrong. Check your connection and try again.';
}

export function AccountLinkForm({ mode }: { mode: Mode }) {
  const copy = COPY[mode];
  // The server cannot see a fragment; the client reads it on hydration.
  const fragmentToken = useSyncExternalStore(noSubscription, readToken, () => undefined);
  const token = mode === 'forgot' ? null : (fragmentToken ?? null);
  const tokenRead = mode === 'forgot' || fragmentToken !== undefined;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'forgot' || fragmentToken === undefined) return;
    // Out of the address bar and the history entry, now that it is in memory.
    if (window.location.hash !== '') window.history.replaceState(null, '', window.location.pathname);
  }, [mode, fragmentToken]);

  const policy = mode === 'forgot' ? null : passwordPolicySchema.safeParse(password);
  const policyMessage = policy === null || policy.success || password.length === 0 ? null : policy.error.issues[0]?.message;
  const mismatch = mode !== 'forgot' && confirm.length > 0 && confirm !== password;
  const canSubmit =
    !busy &&
    (mode === 'forgot'
      ? email.trim().length > 3
      : token !== null && policy?.success === true && confirm === password);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'forgot') {
        await requestPasswordReset({ email: email.trim().toLowerCase() });
        setDone('If that address belongs to an account, a link is on its way. It works once, for 30 minutes.');
      } else if (token !== null) {
        const result = await setPasswordWithToken(mode === 'reset' ? 'reset' : 'invitation', {
          token,
          newPassword: password,
        });
        setDone(`Your password is set. Sign in as ${result.email}.`);
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#09090b] px-4 py-10 text-zinc-100">
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#0f141f] p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-2">
          {mode === 'forgot' ? (
            <Mail className="size-5 text-blue-400" aria-hidden="true" />
          ) : (
            <KeyRound className="size-5 text-blue-400" aria-hidden="true" />
          )}
          <h1 className="text-lg font-semibold">{copy.title}</h1>
        </div>

        {done !== null ? (
          <div className="flex flex-col gap-4">
            <p role="status" className="flex items-start gap-2 text-sm text-emerald-300">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {done}
            </p>
            <Link href="/login" className="text-sm text-blue-400 hover:text-blue-300">
              Go to sign in
            </Link>
          </div>
        ) : mode !== 'forgot' && tokenRead && token === null ? (
          <div className="flex flex-col gap-4">
            <p role="alert" className="text-sm text-rose-300">
              This page needs the link from your email. Open the link again, or ask for a new one.
            </p>
            <Link href="/forgot-password" className="text-sm text-blue-400 hover:text-blue-300">
              Ask for a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
            <p className="text-sm text-zinc-400">{copy.lead}</p>

            {mode === 'forgot' ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">Work email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  placeholder="you@yourhotel.com"
                  className={inputClass}
                  required
                />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">New password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                    }}
                    className={inputClass}
                    aria-describedby="password-rules"
                    required
                  />
                  <span id="password-rules" className="text-[11px] text-zinc-500">
                    At least 12 characters, with an uppercase letter, a lowercase letter and a digit.
                  </span>
                  {policyMessage !== null && policyMessage !== undefined ? (
                    <span className="text-[11px] text-amber-300">{policyMessage}</span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-400">Confirm password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(event) => {
                      setConfirm(event.target.value);
                    }}
                    className={inputClass}
                    required
                  />
                  {mismatch ? <span className="text-[11px] text-amber-300">The passwords do not match.</span> : null}
                </label>
              </>
            )}

            {error !== null ? (
              <p role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-xs text-rose-200">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit}
              className="flex h-11 items-center justify-center gap-2 rounded-lg bg-blue-500 text-sm font-semibold text-white transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {copy.button}
            </button>

            <Link href="/login" className="text-center text-xs text-zinc-500 hover:text-zinc-300">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
