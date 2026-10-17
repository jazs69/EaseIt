import type { Metadata } from 'next';
import { Settings } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { requireHotelId } from '@/lib/property-route';

export const metadata: Metadata = {
  title: 'Property config',
  description: 'Timezone, currency, desk times, tax rules and board basis for this property.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Property configuration, at `/settings/property-config?hotelId=31336`.
 *
 * ===========================================================================
 * Note where this sits: `(property)/settings/...`, while
 * `/settings/access-control` lives in `(dashboard)`. Two route groups now each
 * own part of `/settings/*`, which Next resolves fine — the leaf paths differ —
 * but which means the two settings screens wear different shells, one with the
 * top bar and one with the group sidebar.
 *
 * That is worth calling out rather than hiding: access control is itself
 * property-scoped and arguably belongs in this shell too. Moving it is a
 * separate change with its own navigation consequences, so this page takes the
 * path the brief specified and leaves the inconsistency visible.
 *
 * Deliberately a placeholder. The settings this screen edits — timezone,
 * currency, desk times, rounding policy, inclusive-vs-exclusive tax — are
 * exactly the values the night audit, the folio and every money calculation
 * read. An editor that writes them before those consumers exist would be
 * changing inputs to arithmetic nothing performs yet, with no audit trail:
 * CLAUDE.md section 3.4 requires every mutation of tax or money configuration
 * to write an `audit_log` row in the same transaction, and that table is not
 * built.
 * ===========================================================================
 */
export default async function PropertyConfigPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  requireHotelId(params);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
      <PlaceholderScreen
        icon={Settings}
        title="Property configuration"
        summary="Timezone, currency, desk times, tax rules and board basis for this property."
        blockedBy="Needs the audit_log table and the modules that consume these settings. Section 3.4 requires every change to tax or money configuration to write an audit row in the same transaction, so an editor without it would mutate the inputs to every folio calculation leaving no record of who changed what."
      />
    </main>
  );
}
