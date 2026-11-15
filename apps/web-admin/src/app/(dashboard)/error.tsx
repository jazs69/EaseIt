'use client';

/**
 * The error boundary for the group-level pages.
 *
 * ===========================================================================
 * Same job as the property boundary, different shell. `(dashboard)/layout.tsx`
 * renders the left rail rather than the top bar, and `error.tsx` replaces only
 * the segment's children — so the rail survives and the operator can still
 * reach another screen without using the browser's back button.
 *
 * It is a separate file rather than a shared component because the two groups
 * have genuinely different shells: one boundary serving both would have to
 * render inside whichever layout it was placed under, and placing it high
 * enough to cover both would lose the shell entirely.
 *
 * Like the property boundary, it never reads `error`: the prop is declared to
 * match Next's contract and left undestructured, so no message, stack, cause
 * or digest can reach the screen. React strips the message in production
 * anyway.
 * ===========================================================================
 */

import Link from 'next/link';
import { AlertTriangle, ArrowLeft, RotateCw } from 'lucide-react';

import { Button } from '@repo/ui/components/button';

export default function DashboardError({
  reset,
}: {
  // Declared to match Next's contract, deliberately not destructured.
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center sm:px-6">
      <div
        role="alert"
        className="flex flex-col items-center gap-4 rounded-xl border border-white/[0.1] bg-white/[0.02] px-6 py-10"
      >
        <AlertTriangle className="size-6 text-amber-400" aria-hidden="true" />

        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-white">
            This page could not be loaded
          </h1>
          <p className="max-w-md text-sm leading-relaxed text-zinc-400">
            The service may be temporarily unavailable, or your access may have changed. Nothing has
            been changed.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <Button type="button" onClick={reset}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/group-dashboard">
              <ArrowLeft aria-hidden="true" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
