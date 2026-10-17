import type { Metadata } from 'next';
import { Activity } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { requireHotelId } from '@/lib/property-route';

export const metadata: Metadata = {
  title: 'Revenue',
  description: 'Per-property revenue, ADR and RevPAR against the booked window.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Revenue, at `/revenue?hotelId=31336`.
 *
 * A real route in the `(property)` group, so the app launcher's tile does not
 * 404 and the unified top bar is present — it comes from
 * `(property)/layout.tsx`, the only layout that renders it.
 *
 * Deliberately a placeholder rather than a screen over invented data.
 * Needs the reporting module's property-level figures.
 */
export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  requireHotelId(params);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
      <PlaceholderScreen
        icon={Activity}
        title="Revenue"
        summary="Per-property revenue, ADR and RevPAR against the booked window."
        blockedBy="Needs the reporting module's property-level figures. The portfolio-wide equivalent is already built at /group-performance; this screen is its per-property counterpart and must read the same closed-day snapshots rather than recomputing them differently."
      />
    </main>
  );
}
