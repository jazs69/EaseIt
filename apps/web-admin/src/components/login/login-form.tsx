'use client';

/**
 * Step 1 of sign-in: credentials.
 *
 * A correct password here does not sign anybody in — it earns a two-factor
 * challenge, which this component hands upward to `SignInPanel`. The stubbed
 * client-side password comparison that used to live behind this form is gone;
 * `requestSignIn` posts to the API's `auth` module and the API decides.
 */

import { cn } from '@repo/ui';
import { ErrorCode, type TwoFactorChallenge } from '@repo/types';
import { CircleAlert, Eye, EyeOff, Hexagon, Loader2, Lock, Mail } from 'lucide-react';
import { useState, useSyncExternalStore, type FormEvent } from 'react';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { requestSignIn } from '@/lib/auth-client';
import { DemoFill } from './demo-fill';

import {
  getRememberedEmailServerSnapshot,
  getRememberedEmailSnapshot,
  rememberEmail,
  subscribeToTerminalPreferences,
  toLoginRequest,
  validateCredentials,
  validateEmail,
  type FieldErrors,
} from '@/lib/session';

/* -------------------------------------------------------------------------- */
/*  Field                                                                     */
/* -------------------------------------------------------------------------- */

const INPUT_BASE =
  'w-full rounded-lg border bg-zinc-900/60 px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 transition-colors focus:outline-none focus:ring-1';
const INPUT_OK = 'border-white/10 focus:border-blue-500 focus:ring-blue-500';
const INPUT_ERROR = 'border-rose-500/50 focus:border-rose-500 focus:ring-rose-500';

/* -------------------------------------------------------------------------- */
/*  Form                                                                      */
/* -------------------------------------------------------------------------- */

export interface LoginFormProps {
  /** Called when the password is accepted and a code has been sent. */
  onChallenge: (challenge: TwoFactorChallenge, email: string) => void;
  /**
   * Called when the API signed the operator in without a second factor.
   *
   * Unreachable today — `POST /auth/login` always answers
   * `two_factor_required` — but the union it comes from is what a future
   * remembered-device or SSO path would use, and handling it here means that
   * path does not have to touch this component.
   */
  onAuthenticated: () => void;
  /** Carried back from a dead challenge, e.g. "too many incorrect codes". */
  initialError?: string | null;
}

export function LoginForm({
  onChallenge,
  onAuthenticated,
  initialError = null,
}: LoginFormProps) {
  // Read the remembered address through the external store rather than an
  // on-mount effect: no cascading render, and no first frame showing an empty
  // field before the saved value arrives.
  const rememberedEmail = useSyncExternalStore(
    subscribeToTerminalPreferences,
    getRememberedEmailSnapshot,
    getRememberedEmailServerSnapshot,
  );

  // `null` means "the operator has not touched this field yet", so the
  // remembered value shows through until they do.
  const [emailInput, setEmailInput] = useState<string | null>(null);
  const [rememberInput, setRememberInput] = useState<boolean | null>(null);

  const email = emailInput ?? rememberedEmail;
  const remember = rememberInput ?? rememberedEmail.length > 0;

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const fieldErrors = validateCredentials(email, password);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    const request = toLoginRequest(email, password);
    if (request === null) {
      setErrors({ email: 'That does not look like a valid email address.' });
      return;
    }

    setSubmitting(true);
    try {
      const result = await requestSignIn(request);

      // Remembered only once the credentials were accepted, so a typo is not
      // what gets saved. The address is a convenience; the password is never
      // stored anywhere.
      rememberEmail(remember ? request.email : null);

      // Branching on the tag, not sniffing fields: the API answers
      // `authenticated` for a future remembered-device or SSO path, and this
      // component should not have to be rewritten when it does.
      if (result.status === 'two_factor_required') {
        onChallenge(result.challenge, request.email);
        return;
      }

      // Already authenticated without a second factor. Navigation is the
      // parent's job: it owns the router, and a hard `location.assign` would
      // throw away the client router's state for no benefit.
      onAuthenticated();
    } catch (caught) {
      setSubmitting(false);
      setFormError(describeFailure(caught));

      // A rejected password should not stay in the field on a shared
      // terminal, and clearing it also makes the retry unambiguous.
      if (caught instanceof ApiRequestError && caught.code === ErrorCode.INVALID_CREDENTIALS) {
        setPassword('');
      }
    }
  }

  return (
    <div className="flex w-full flex-col justify-center px-6 py-10 sm:px-10">
      <div className="mx-auto w-full max-w-sm">
        {/* Header — centred logo, title and subtitle. */}
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600">
            <Hexagon className="size-5 text-white" strokeWidth={2.5} aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-2">
            <h1 id="login-heading" className="text-3xl font-semibold tracking-tight text-white">
              Log in
            </h1>
            <p className="text-sm leading-relaxed text-balance text-zinc-500">
              Autonomous front-desk management, channel sync and unified folios for your assigned
              property.
            </p>
          </div>
        </div>

        {/* Form-level error */}
        {formError !== null && formError.length > 0 ? (
          <div
            role="alert"
            className="mt-6 flex items-start gap-2.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3.5 py-3"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-400" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-rose-200">{formError}</p>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="mt-6 flex flex-col gap-4"
          noValidate
        >
          {/* Email */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-xs font-medium text-zinc-300">
              Work email
            </label>
            <div className="relative">
              <Mail
                className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-500"
                aria-hidden="true"
              />
              <input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(event) => {
                  setEmailInput(event.target.value);
                }}
                onBlur={() => {
                  const message = validateEmail(email);
                  setErrors((previous) => {
                    const next: FieldErrors = { ...previous };
                    if (message === undefined) {
                      delete next.email;
                    } else {
                      next.email = message;
                    }
                    return next;
                  });
                }}
                placeholder="you@yourhotel.com"
                aria-invalid={errors.email !== undefined}
                aria-describedby={errors.email !== undefined ? 'email-error' : undefined}
                className={cn(
                  INPUT_BASE,
                  'pl-10',
                  errors.email !== undefined ? INPUT_ERROR : INPUT_OK,
                )}
              />
            </div>
            {errors.email !== undefined ? (
              <p id="email-error" className="text-[11px] text-rose-300">
                {errors.email}
              </p>
            ) : null}
          </div>

          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-xs font-medium text-zinc-300">
              Password
            </label>
            <div className="relative">
              <Lock
                className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-500"
                aria-hidden="true"
              />
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                placeholder="••••••••••••"
                aria-invalid={errors.password !== undefined}
                aria-describedby={errors.password !== undefined ? 'password-error' : undefined}
                className={cn(
                  INPUT_BASE,
                  'pr-11 pl-10',
                  errors.password !== undefined ? INPUT_ERROR : INPUT_OK,
                )}
              />
              <button
                type="button"
                onClick={() => {
                  setShowPassword((value) => !value);
                }}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-zinc-500 transition-colors hover:text-zinc-200"
              >
                {showPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {errors.password !== undefined ? (
              <p id="password-error" className="text-[11px] text-rose-300">
                {errors.password}
              </p>
            ) : null}
          </div>

          {/* Remember + forgot */}
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="remember"
              className="group inline-flex cursor-pointer items-center gap-2.5"
            >
              <input
                id="remember"
                name="remember"
                type="checkbox"
                checked={remember}
                onChange={(event) => {
                  setRememberInput(event.target.checked);
                }}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className="grid size-4 shrink-0 place-items-center rounded border border-white/15 bg-zinc-900/60 transition-colors peer-checked:border-blue-500 peer-checked:bg-blue-500 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500/50 peer-checked:[&>svg]:scale-100"
              >
                <svg
                  viewBox="0 0 12 12"
                  className="size-3 scale-0 text-white transition-transform"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2.5 6.5 5 9l4.5-5.5" />
                </svg>
              </span>
              <span className="text-xs text-zinc-400 transition-colors group-hover:text-zinc-300">
                Remember this terminal
              </span>
            </label>

            <a
              href="#forgot-password"
              className="text-sm text-zinc-400 transition hover:text-blue-400"
            >
              Forgot password?
            </a>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-white py-2.5 text-sm font-medium text-black transition hover:bg-zinc-200 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Sending code…
              </>
            ) : (
              'Continue with email code'
            )}
          </button>

          <p className="text-center text-[11px] text-zinc-600">
            We will email you a single-use code to finish signing in.
          </p>
        </form>

        <div className="mt-4">
          <DemoFill
            disabled={submitting}
            onFill={(nextEmail, nextPassword) => {
              setEmailInput(nextEmail);
              setPassword(nextPassword);
              setErrors({});
              setFormError(null);
            }}
          />
        </div>

        {/* Legal */}
        <p className="mt-6 text-center text-[11px] leading-relaxed text-zinc-600">
          <span>
            By signing in, you agree to property audit logging and our{' '}
            <a
              href="#terms"
              className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Terms of Service
            </a>{' '}
            &amp;{' '}
            <a
              href="#privacy"
              className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Privacy Policy
            </a>
            .
          </span>
        </p>
      </div>
    </div>
  );
}

/**
 * Turns a failure into copy.
 *
 * The API's own message is preferred wherever it has one, because it is the
 * side that knows *why* — how many attempts are left, how long to wait. This
 * only adds what the client knows better: that the API is unreachable at all.
 */
function describeFailure(caught: unknown): string {
  if (caught instanceof ApiUnreachableError) {
    return caught.message;
  }

  if (caught instanceof ApiRequestError) {
    const retryAfter = caught.detail('retryAfterSeconds');
    if (caught.code === ErrorCode.RATE_LIMITED && retryAfter !== undefined) {
      return `${caught.message} (about ${String(retryAfter)}s)`;
    }
    return caught.message;
  }

  return 'Sign-in is unavailable right now. Please try again.';
}
