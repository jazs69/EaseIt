/**
 * The authenticated shell for every route in the `(dashboard)` group.
 *
 * Resolves the session once, on the server, from the httpOnly cookie, and
 * provides it to the client components below — this is the layer that replaced
 * the client-side session stub the permission hook used to read.
 *
 * The sidebar lives here rather than in each page so that navigating between
 * group screens does not remount it: its collapse state and scroll position
 * survive, which is the point of a layout.
 */

import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/dashboard/app-sidebar';
import { SessionProvider } from '@/components/session-provider';
import { requireSession } from '@/lib/server-session';

// Per-request by definition — never statically rendered or cached.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { session } = await requireSession();

  return (
    <SessionProvider session={session}>
      <div className="flex min-h-screen">
        <AppSidebar />
        {/* `min-w-0` is load-bearing: without it a wide table inside a flex
            child refuses to shrink and pushes the whole page into horizontal
            scroll instead of scrolling inside its own container. */}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </SessionProvider>
  );
}
