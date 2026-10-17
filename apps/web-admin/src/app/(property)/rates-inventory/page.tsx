import type { Metadata } from 'next';
import { SlidersHorizontal } from 'lucide-react';
import { redirect } from 'next/navigation';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';

export const metadata: Metadata = {
  title: 'Rates & inventory',
  description: 'Rack rates, restrictions and channel distribution for one property.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Rates & inventory, at `/rates-inventory?hotelId=31336`.
 *
 * ===========================================================================
 * A real route in the `(property)` group, so the icon does not 404 and the
 * unified top bar is present — it comes from `(property)/layout.tsx`, which is
 * the only layout that renders it. The brief named
 * `app/(dashboard)/rates-inventory/`, but that group carries the group sidebar
 * and *not* the top bar, so putting it there would have contradicted the same
 * brief's requirement that this screen show the unified navbar.
 *
 * Deliberately a placeholder rather than a rate grid over invented numbers.
 * What this screen has to show does not exist yet in any truthful form:
 *
 *   * `rates` owns rate plans, the rate calendar, derived and linked rates and
 *     promotions. There is no RatePlan table, so there are no rates to edit.
 *   * `inventory` owns per-date restrictions — stop-sell, closed-to-arrival,
 *     minimum and maximum stay. `inventory_day` today holds only the counters
 *     the oversell CHECK guards (`physical`, `sold`, `blocked`,
 *     `overbookingAllowance`); no restriction columns exist.
 *   * `channels` owns the ARI push outbox and the per-channel mappings. A rate
 *     editor that cannot push is a form that silently disagrees with what the
 *     OTAs are selling, which is worse than no editor.
 *
 * Writing a rate here before those exist would mean either a form that
 * discards its input or one that writes to a table the booking path does not
 * read — and a rate the booking engine ignores is how a hotel sells a room at
 * last year's price.
 * ===========================================================================
 */
export default async function RatesInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = first(params['hotelId']);

  // Property-scoped, so it needs a property. Same contract as `/calendar`:
  // back to the picker rather than guessing a hotel the caller may hold no
  // grant at (CLAUDE.md section 3.2).
  if (hotelId === undefined || hotelId.trim().length === 0) {
    redirect('/group-dashboard');
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
      <PlaceholderScreen
        icon={SlidersHorizontal}
        title="Rates & inventory"
        summary="Rack rates, stop-sells, minimum stay restrictions and channel distribution for this property."
        blockedBy="Needs the rates, inventory-restriction and channels modules. There is no RatePlan table, inventory_day carries no restriction columns, and nothing can push ARI to the OTAs yet — so any rate shown or saved here would disagree with what the channels are actually selling."
      />
    </main>
  );
}
