/**
 * The property operations shell.
 *
 * ===========================================================================
 * Its own route group, and the only place `OpsTopBar` is rendered.
 *
 * Separate from `(dashboard)` because these screens use a top bar instead of
 * the group dashboard's left rail: the front desk works in one property for a
 * whole shift, so the rail's job — choosing between hotels — is already done
 * by the time anyone is here. Rendering both would put two navigation systems
 * on screen competing for the same decision, and would cost the reservation
 * grid the horizontal space it needs most.
 *
 * The bar lives here rather than in each page so that moving between
 * `/property-dashboard` and `/calendar` does not remount it: no flash, the
 * property switcher keeps its state, and `aria-current` on the icon row
 * actually means something. That became possible once the bar stopped needing
 * the server-fetched property and resolved it from the session's grants
 * instead — a layout cannot read search params, but a client component inside
 * one can.
 *
 * No width cap and no horizontal padding: the children are full-bleed. The
 * reservation grid is a room x date matrix that scrolls inside itself, and
 * every pixel of page gutter is a column the front desk cannot see.
 *
 * **The shell is exactly one viewport tall and does not scroll.** The document
 * no longer scrolls at all; the child area does. That is what pins the top bar
 * for good rather than relying on `position: sticky`, which any ancestor with
 * `overflow` silently breaks — and a navigation bar that works until somebody
 * adds an `overflow-hidden` three levels up is a bug waiting for a deadline.
 *
 * `h-dvh`, not `h-screen`: on mobile browsers `100vh` includes the collapsing
 * address bar, so a full-height shell is taller than what you can see and the
 * bottom row hides under the chrome.
 *
 * `min-h-0` on the child area is load-bearing. A flex child defaults to
 * `min-height: auto`, which refuses to shrink below its content — so without
 * it the scroll container grows to fit the grid instead of scrolling, and the
 * whole arrangement silently reverts to a long page.
 * ===========================================================================
 */

import type { ReactNode } from 'react';

import { OpsTopBar } from '@/components/property-dashboard/ops-top-bar';
import { SessionProvider } from '@/components/session-provider';
import { requireSession } from '@/lib/server-session';

export const dynamic = 'force-dynamic';

export default async function PropertyLayout({ children }: { children: ReactNode }) {
  const { session } = await requireSession();

  return (
    <SessionProvider session={session}>
      {/* `min-w-0` is load-bearing: without it a wide grid inside a flex
          column refuses to shrink and pushes the whole page into horizontal
          scroll instead of scrolling inside its own container. */}
      <div className="flex h-dvh flex-col overflow-hidden">
        <OpsTopBar session={session} />
        {/* The only scrolling region for ordinary pages. The reservation
            calendar opts out by sizing itself to this box and scrolling its
            own grid body instead, so nothing here ever overflows. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {children}
        </div>
      </div>
    </SessionProvider>
  );
}
