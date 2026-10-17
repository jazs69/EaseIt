import type { Metadata } from 'next';
import { CreditCard } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { requireHotelId } from '@/lib/property-route';

export const metadata: Metadata = {
  title: 'Payments',
  description: 'Captures, refunds and settlement for the bookings at this property.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Payments, at `/payments?hotelId=31336`.
 *
 * A real route in the `(property)` group, so the app launcher's tile does not
 * 404 and the unified top bar is present — it comes from
 * `(property)/layout.tsx`, the only layout that renders it.
 *
 * Deliberately a placeholder rather than a screen over invented data.
 * Needs the folios module and a live payment-gateway integration.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  requireHotelId(params);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
      <PlaceholderScreen
        icon={CreditCard}
        title="Payments"
        summary="Captures, refunds and settlement for the bookings at this property."
        blockedBy="Needs the folios module and a live payment-gateway integration. Razorpay onboarding state is modelled, but no capture path exists — and a payment screen that cannot take money is worse than none, because it implies one was taken."
      />
    </main>
  );
}
