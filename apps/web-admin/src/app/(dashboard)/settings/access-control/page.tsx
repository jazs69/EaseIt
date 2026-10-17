import type { Metadata } from 'next';

import { AccessControlView } from '@/components/access-control/access-control-view';

export const metadata: Metadata = {
  title: 'Access Control',
  description: 'Manage staff, roles and granular permissions for this property.',
  robots: { index: false, follow: false },
};

/**
 * Settings → Access Control.
 *
 * The `(dashboard)` route group does not appear in the URL, so this serves
 * `/settings/access-control`. The page stays a server component; only the
 * interactive view opts into the client.
 */
export default function AccessControlPage() {
  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb" className="text-xs text-zinc-600">
          Settings <span aria-hidden="true">/</span>{' '}
          <span className="text-zinc-400">Access Control</span>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Access Control</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-500">
          Who can do what at this property. Roles bundle granular permissions; a staff member may
          hold several, and their effective access is the union of them all.
        </p>
      </header>

      <AccessControlView />
    </main>
  );
}
