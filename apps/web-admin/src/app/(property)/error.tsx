'use client';

/**
 * The error boundary for every property-scoped page.
 *
 * ===========================================================================
 * WHY THIS EXISTS. The pages in this group fetch from the API during server
 * rendering, and `apiFetch` throws on any non-OK response. Nothing caught it,
 * so a 404 from an unknown `hotelId` — which is also what the API returns when
 * you simply hold no grant at a property — surfaced as a full-screen Next.js
 * stack overlay in development, and as Next's generic crash page in
 * production.
 *
 * IT RENDERS INSIDE THE SHELL. `error.tsx` replaces the segment's children,
 * not its layout, so `(property)/layout.tsx` still wraps this: the top bar,
 * the property switcher and the icon navigation all survive. That is the whole
 * reason this file sits here rather than at the app root — an operator who
 * hits a bad property can still switch to a good one without a back button.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   * It does not read `error`. The prop is declared so the signature matches
 *     what Next passes, and then never destructured, which is what makes
 *     "no message, no stack, no cause, no digest" structural rather than a
 *     rule somebody has to remember. React strips the message in production
 *     builds anyway, so branching on it would work in dev and quietly stop
 *     working in prod.
 *
 *   * It does not try to tell 403 from 404. The API answers not-found for
 *     "no such property" and "you hold no role there" alike, on purpose
 *     (CLAUDE.md section 3.2) — a 403 would confirm the property exists to
 *     someone with no access. Guessing here would either leak that or tell an
 *     operator their data is missing when their access merely changed. The
 *     copy below names both possibilities and claims neither.
 *
 * No effects, no state, no time or randomness — nothing that could differ
 * between the server and client render.
 * ===========================================================================
 */

import Link from 'next/link';
import { AlertTriangle, ArrowLeft, RotateCw } from 'lucide-react';

import { Button } from '@repo/ui/components/button';

export default function PropertyError({
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
            The property may not exist, your access to it may have changed, or the service may be
            temporarily unavailable. Nothing has been changed.
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
              Back to properties
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
