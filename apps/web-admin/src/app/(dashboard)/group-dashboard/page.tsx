import type { Metadata } from 'next';

import { GroupDashboardView } from '@/components/group/group-dashboard-view';
import { fetchMyGroup, parseStatusFilter } from '@/lib/properties-client';
import { requireCookieHeader } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Group dashboard',
  description: 'Every property in your group, and the one you are working in.',
  robots: { index: false, follow: false },
};

// The property set is per-user and must never be cached or prerendered.
export const dynamic = 'force-dynamic';

/**
 * The post-login landing page.
 *
 * Fetched on the server with `status=ALL`, deliberately: the toolbar's status
 * filter runs client-side over the loaded set, so the server has to hand over
 * everything the operator may see or switching to "All statuses" would have
 * nothing new to reveal. The URL's `?status=` becomes the *initial* client
 * filter, which keeps a shared or bookmarked link honest without making every
 * filter change a round trip.
 *
 * Ten properties makes this trivially affordable (CLAUDE.md section 1). The
 * API supports server-side `status` and `search` for when it is not.
 */
export default async function GroupDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawStatus = params['status'];
  const initialStatus = parseStatusFilter(
    Array.isArray(rawStatus) ? rawStatus[0] : rawStatus,
  );

  const group = await fetchMyGroup({
    status: 'ALL',
    cookieHeader: await requireCookieHeader(),
  });

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Welcome to your group dashboard
        </h1>
        <p className="text-sm text-zinc-500">
          You have{' '}
          <span className="tabular font-medium text-zinc-300">{group.totalUnfiltered}</span>{' '}
          {group.totalUnfiltered === 1 ? 'property' : 'properties'}.
        </p>
      </header>

      {group.totalUnfiltered === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-amber-400/25 bg-amber-500/[0.04] px-6 py-16 text-center">
          <p className="text-sm font-medium text-amber-200">
            No properties are assigned to your account yet.
          </p>
          <p className="max-w-md text-xs leading-relaxed text-amber-200/70">
            Access is granted per property. Ask an administrator to assign you a role, then reload
            this page.
          </p>
        </div>
      ) : (
        <GroupDashboardView properties={group.properties} initialStatus={initialStatus} />
      )}
    </main>
  );
}
