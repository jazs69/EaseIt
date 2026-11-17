import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { InventoryHorizonCard } from '@/components/inventory/inventory-horizon-card';
import { RatePlansScreen } from '@/components/rates/rate-plans-screen';
import { fetchInventoryHorizon, fetchRatePlans, fetchRoomTypes } from '@/lib/properties-client';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Rates & inventory',
  description: 'Rate plans and the availability calendar for one property.',
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
 * A route in the `(property)` group, so it inherits the unified top bar from
 * `(property)/layout.tsx` — the only layout that renders it.
 *
 * WHAT CHANGED HERE. This screen used to be a `PlaceholderScreen`, because
 * there was no `RatePlan` table and so nothing truthful to show. Scope F1 adds
 * the table, the endpoints and the management UI, so the placeholder is gone
 * and rate plans are real, authorable configuration.
 *
 * WHAT IS STILL NOT HERE, and is stated on the screen rather than omitted
 * silently:
 *
 *   * **Plans price a booking only when chosen in the booking form** (F9);
 *     otherwise the rack rate applies. Extra-guest charges, promotions and
 *     stay restrictions (minimum stay, closed to arrival or departure; AV-07)
 *     apply to plan-priced bookings only, and the screen says so.
 *   * **No stop-sell** on the room type as a whole: a restriction belongs to a
 *     plan, and a rack-rate booking names none.
 *   * **No channel distribution.** A rate editor that cannot push would
 *     silently disagree with what the OTAs are selling.
 *
 * The inventory horizon card stays exactly as it was: it is the other
 * genuinely truthful control on this screen, and it is unrelated to rates.
 *
 * All three fetches are server-side so the first paint already carries the
 * data, and all three go through `requireSession`, so an expired session
 * redirects rather than rendering an empty screen. A failure in any of them
 * reaches `(property)/error.tsx`, which keeps the top bar and offers a retry.
 * ===========================================================================
 */
export default async function RatesInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = first(params['hotelId']);

  // Property-scoped, so it needs a property. Same contract as `/calendar` and
  // `/rooms`: back to the picker rather than guessing a hotel the caller may
  // hold no grant at (CLAUDE.md section 3.2).
  if (hotelId === undefined || hotelId.trim().length === 0) {
    redirect('/group-dashboard');
  }

  const { session, cookieHeader } = await requireSession();

  const horizon = await fetchInventoryHorizon(hotelId, { cookieHeader });
  // Room types are needed to render the assignment picker, not merely to
  // display: a plan must apply to at least one category.
  const roomTypes = await fetchRoomTypes(hotelId, { cookieHeader });
  // The API decides the default filter (active plans only), so every client
  // agrees about it rather than each inventing its own idea of "the list".
  const ratePlans = await fetchRatePlans(hotelId, {}, { cookieHeader });

  // Read from the session rather than guessed: the API refuses a write without
  // `rates:manage` regardless, but a button that always 403s is worse than one
  // that explains itself.
  const canExtend = session.permissions.includes('property:settings');
  const canManageRates = session.permissions.includes('rates:manage');

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Rates &amp; inventory</h1>
        <p className="text-sm text-muted-foreground">
          Rate plans and how far ahead this property can sell.
        </p>
      </header>

      <InventoryHorizonCard hotelId={hotelId} horizon={horizon} canExtend={canExtend} />

      <RatePlansScreen
        hotelId={hotelId}
        initialPlans={ratePlans.items}
        roomTypes={roomTypes}
        currency={ratePlans.currency}
        canManage={canManageRates}
      />
    </main>
  );
}
