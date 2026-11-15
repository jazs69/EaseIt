'use client';

/**
 * The application-level error boundary.
 *
 * ===========================================================================
 * THE GAP THIS CLOSES. A segment's `error.tsx` wraps that segment's children,
 * not its own layout — so `(property)/error.tsx` cannot catch a failure thrown
 * by `(property)/layout.tsx` itself. That layout calls `requireSession()`,
 * which absorbs 401 and 403 by redirecting to sign-in but lets a 500 or an
 * unreachable API propagate. Without this file those failures escape every
 * group boundary and reach Next's default crash page.
 *
 * It renders inside the ROOT layout, so the page keeps its fonts, theme and
 * background — but neither group shell is present, because the layout that
 * would have drawn it is the thing that failed. The navigation offered is
 * therefore a plain link rather than a rail or a top bar.
 *
 * This is NOT `global-error.tsx`. That file replaces the root layout itself
 * and is only reached when the root layout throws, which the audit did not
 * establish as in scope. Adding one would mean hand-writing `<html>` and
 * `<body>` and re-declaring the theme, for a case nothing has demonstrated.
 *
 * As with the group boundaries, `error` is declared and never destructured:
 * no message, stack, cause or digest can reach the screen.
 * ===========================================================================
 */

import Link from 'next/link';
import { AlertTriangle, RotateCw } from 'lucide-react';

import { Button } from '@repo/ui/components/button';

export default function AppError({
  reset,
}: {
  // Declared to match Next's contract, deliberately not destructured.
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <div
        role="alert"
        className="flex flex-col items-center gap-4 rounded-xl border border-white/[0.1] bg-white/[0.02] px-6 py-10"
      >
        <AlertTriangle className="size-6 text-amber-400" aria-hidden="true" />

        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-white">Something went wrong</h1>
          <p className="max-w-md text-sm leading-relaxed text-zinc-400">
            EaseIt could not finish loading this page. The service may be temporarily unavailable.
            Nothing has been changed.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <Button type="button" onClick={reset}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/group-dashboard">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
