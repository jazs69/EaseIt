import type { Metadata } from 'next';
import { Moon } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { requireHotelId } from '@/lib/property-route';

export const metadata: Metadata = {
  title: 'Night audit',
  description: 'Run the audit, review each step and close the business date.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Night audit, at `/night-audit?hotelId=31336`.
 *
 * A real route in the `(property)` group, so the app launcher's tile does not
 * 404 and the unified top bar is present — it comes from
 * `(property)/layout.tsx`, the only layout that renders it.
 *
 * Deliberately a placeholder rather than a screen over invented data.
 * Needs the nightaudit module.
 */
export default async function NightAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  requireHotelId(params);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
      <PlaceholderScreen
        icon={Moon}
        title="Night audit"
        summary="Run the audit, review each step and close the business date."
        blockedBy="Needs the nightaudit module. CLAUDE.md section 3.3 requires the audit to run as a background job per property and never on a user request, so this screen exists to enqueue a run and poll its steps — neither the queue nor the night_audit_step table exists yet."
      />
    </main>
  );
}
