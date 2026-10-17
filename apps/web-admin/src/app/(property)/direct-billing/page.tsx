import type { Metadata } from 'next';
import { Wallet } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { requireHotelId } from '@/lib/property-route';

export const metadata: Metadata = {
  title: 'Direct billing',
  description: 'City-ledger accounts, corporate invoicing and settlement against company contracts.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Direct billing, at `/direct-billing?hotelId=31336`.
 *
 * A real route in the `(property)` group, so the app launcher's tile does not
 * 404 and the unified top bar is present — it comes from
 * `(property)/layout.tsx`, the only layout that renders it.
 *
 * Deliberately a placeholder rather than a screen over invented data.
 * Needs the folios module.
 */
export default async function DirectBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  requireHotelId(params);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
      <PlaceholderScreen
        icon={Wallet}
        title="Direct billing"
        summary="City-ledger accounts, corporate invoicing and settlement against company contracts."
        blockedBy="Needs the folios module. Direct billing posts to a company's ledger rather than a guest folio, and there is no Folio table yet — so there is nothing to post to and no balance to invoice."
      />
    </main>
  );
}
