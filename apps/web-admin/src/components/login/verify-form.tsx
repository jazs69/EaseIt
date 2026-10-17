'use client';

/**
 * Step 2 of sign-in: the emailed one-time code.
 *
 * Laid out to match the credentials step it replaces — same centred mark, same
 * heading rhythm, same full-width action — so clearing the second factor reads
 * as one continuous flow rather than a different screen.
 *
 * Two behaviours worth noting because they are easy to get wrong:
 *
 *   * **Every failure branches on the API's `code`**, never on an HTTP status
 *     or a message string. "Wrong code, four left" and "this challenge is dead,
 *     start again" need entirely different outcomes, and only the code
 *     distinguishes them reliably.
 *   * **The countdowns are derived from the server's instants**
 *     (`resendAvailableAt`, `expiresAt`), not counted down from a local
 *     constant. A timer started at mount drifts, survives a tab suspend as a
 *     lie, and will happily offer a resend the server then refuses.
 */

import { cn, OtpInput } from '@repo/ui';
import {
  ErrorCode,
  TWO_FACTOR,
  type Session,
  type TwoFactorChallenge,
} from '@repo/types';
import { ArrowLeft, CircleAlert, Hexagon, Loader2, MailCheck, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { resendCode, verifyCode } from '@/lib/auth-client';

export interface VerifyFormProps {
  challenge: TwoFactorChallenge;
  /** The address typed at step 1, for the "signing in as" line. */
  email: string;
  onChallengeUpdated: (challenge: TwoFactorChallenge) => void;
  onVerified: (session: Session) => void;
  /** Challenge is dead — return to credentials, saying why. */
  onRestart: (reason: string) => void;
}

/** Seconds remaining until `isoInstant`, floored at zero. */
function secondsUntil(isoInstant: string, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(isoInstant) - nowMs) / 1_000));
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

export function VerifyForm({
  challenge,
  email,
  onChallengeUpdated,
  onVerified,
  onRestart,
}: VerifyFormProps) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendExhausted, setResendExhausted] = useState(challenge.resendsRemaining === 0);

  // One ticking clock drives both countdowns. Subscribing to a timer is a
  // genuine external side effect, so it does belong in an effect.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const resendInSeconds = secondsUntil(challenge.resendAvailableAt, nowMs);
  const codeExpiresInSeconds = secondsUntil(challenge.expiresAt, nowMs);
  const expired = codeExpiresInSeconds === 0;
  const canResend = resendInSeconds === 0 && !resending && !submitting && !resendExhausted;

  async function submit(submittedCode: string): Promise<void> {
    if (submitting || submittedCode.length !== challenge.codeLength) return;

    setSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const result = await verifyCode(challenge.challengeId, submittedCode);
      // Deliberately leaves `submitting` true: the spinner holds until the
      // route transition paints instead of flashing back to idle.
      onVerified(result.session);
    } catch (caught) {
      setSubmitting(false);
      setCode('');
      handleFailure(caught);
    }
  }

  function handleFailure(caught: unknown): void {
    if (caught instanceof ApiUnreachableError) {
      setError(caught.message);
      return;
    }

    if (!(caught instanceof ApiRequestError)) {
      setError('Verification is unavailable right now. Please try again.');
      return;
    }

    switch (caught.code) {
      // Terminal: the challenge can never be satisfied, so send the operator
      // back rather than leaving them typing into a dead field.
      case ErrorCode.OTP_ATTEMPTS_EXCEEDED:
      case ErrorCode.OTP_CHALLENGE_NOT_FOUND:
      case ErrorCode.ACCOUNT_DISABLED:
        onRestart(caught.message);
        return;

      case ErrorCode.OTP_RESEND_LIMIT:
        setResendExhausted(true);
        setError(caught.message);
        return;

      case ErrorCode.OTP_RESEND_TOO_SOON:
      case ErrorCode.RATE_LIMITED: {
        const retryAfter = caught.detail('retryAfterSeconds');
        setError(
          retryAfter === undefined
            ? caught.message
            : `${caught.message} (about ${String(retryAfter)}s)`,
        );
        return;
      }

      // OTP_INVALID carries `attemptsRemaining`, and OTP_EXPIRED explains
      // itself — both messages come from the API so the count shown is the
      // count the server is actually keeping.
      default:
        setError(caught.message);
    }
  }

  async function handleResend(): Promise<void> {
    if (!canResend) return;

    setResending(true);
    setError(null);

    try {
      const refreshed = await resendCode(challenge.challengeId);
      onChallengeUpdated(refreshed);
      setCode('');
      setResendExhausted(refreshed.resendsRemaining === 0);
      setNotice(
        refreshed.devMailFallback
          ? 'A new code was written to the API console.'
          : 'A new code is on its way.',
      );
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="flex w-full flex-col justify-center px-6 py-10 sm:px-10">
      <div className="mx-auto flex w-full max-w-sm flex-col">
        {/* Header — mirrors the credentials step so the two read as one flow. */}
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600">
            <Hexagon className="size-5 text-white" strokeWidth={2.5} aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-2">
            <h1 id="login-heading" className="text-3xl font-semibold tracking-tight text-white">
              Verify your email
            </h1>
            <p className="text-sm leading-relaxed text-balance text-zinc-500">
              We sent a {challenge.codeLength}-digit code to{' '}
              <span className="font-medium text-zinc-200">{challenge.maskedEmail}</span>. It is
              good for one use.
            </p>
          </div>
        </div>

        {/* Development transport notice. Only ever true when the API has no
            SMTP host configured — it refuses to boot without one in
            production, so this cannot appear there. */}
        {challenge.devMailFallback ? (
          <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-3.5 py-3">
            <Terminal className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" />
            <p className="text-[11px] leading-relaxed text-amber-200/90">
              <span className="font-medium text-amber-200">No mail transport configured.</span>{' '}
              The code was printed in the terminal running the API, not emailed. Set{' '}
              <code>SMTP_HOST</code> to deliver for real.
            </p>
          </div>
        ) : null}

        {error !== null ? (
          <div
            role="alert"
            className="mt-6 flex items-start gap-2.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3.5 py-3"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-400" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-rose-200">{error}</p>
          </div>
        ) : null}

        {error === null && notice !== null ? (
          <div
            role="status"
            className="mt-6 flex items-start gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-3"
          >
            <MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-emerald-200">{notice}</p>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(code);
          }}
          className="mt-6 flex flex-col gap-4"
          noValidate
        >
          <OtpInput
            value={code}
            onChange={(next) => {
              setCode(next);
              if (error !== null) setError(null);
            }}
            // Submitting on the last digit saves a deliberate click on the
            // overwhelmingly common happy path. The button stays for autofill,
            // for keyboard users who prefer it, and for a retry after a
            // failure.
            onComplete={(completed) => {
              void submit(completed);
            }}
            length={challenge.codeLength}
            disabled={submitting}
            invalid={error !== null}
            autoFocus
            label={`${String(challenge.codeLength)}-digit verification code`}
            describedBy="otp-help"
          />

          <p id="otp-help" className="text-center text-[11px] text-zinc-600">
            {expired ? (
              <span className="text-amber-300/90">
                This code has expired — request a new one below.
              </span>
            ) : (
              <>
                Expires in{' '}
                <span className="tabular text-zinc-400">
                  {formatCountdown(codeExpiresInSeconds)}
                </span>
              </>
            )}
          </p>

          <button
            type="submit"
            disabled={submitting || code.length !== challenge.codeLength}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-white py-2.5 text-sm font-medium text-black transition hover:bg-zinc-200 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Verifying…
              </>
            ) : (
              'Verify and continue'
            )}
          </button>
        </form>

        {/* Resend — the cooldown is the server's, read off its own instant. */}
        <div className="mt-5 flex flex-col items-center gap-1.5 text-center">
          {resendExhausted ? (
            <p className="text-xs text-zinc-500">
              No more codes can be sent for this sign-in.
            </p>
          ) : resendInSeconds > 0 ? (
            <p className="text-xs text-zinc-500">
              You can request another code in{' '}
              <span className="tabular text-zinc-400">{resendInSeconds}s</span>
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <span className="text-xs text-zinc-500">Did not get the code?</span>
              <button
                type="button"
                onClick={() => {
                  void handleResend();
                }}
                disabled={!canResend}
                className={cn(
                  'inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 transition-colors',
                  canResend ? 'hover:text-blue-300' : 'cursor-not-allowed opacity-50',
                )}
              >
                {resending ? (
                  <>
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  'Send a new one'
                )}
              </button>
            </div>
          )}

          {!resendExhausted && challenge.resendsRemaining <= 1 ? (
            <p className="text-[10px] text-zinc-600">
              {challenge.resendsRemaining === 1
                ? 'One resend left for this sign-in.'
                : null}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-center border-t border-white/[0.06] pt-5">
          <button
            type="button"
            onClick={() => {
              onRestart('');
            }}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:opacity-50"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Not {email}? Start over
          </button>
        </div>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-zinc-600">
          EaseIt will never ask you for this code by phone or message. Codes expire after{' '}
          {String(Math.round(TWO_FACTOR.CODE_TTL_SECONDS / 60))} minutes.
        </p>
      </div>
    </div>
  );
}
