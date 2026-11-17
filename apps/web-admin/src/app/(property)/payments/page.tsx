import type { Metadata } from 'next';
import { CreditCard } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { PaymentsScreen } from '@/components/payments/payments-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchPaymentsOverview } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Payments',
  description: 'Payments and refunds taken at this property, and Razorpay payment links.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Payments, at `/payments?hotelId=31336` (FO-16, FO-15).
 *
 * The week ending on the business date is fetched server-side. Reading needs
 * `folio:read`; the gateway switch is offered with `property:settings`.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { session, cookieHeader } = await requireSession();

  let overview;
  try {
    overview = await fetchPaymentsOverview(hotelId, {}, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={CreditCard}
            title="Payments"
            summary="Payments and refunds taken at this property, and Razorpay payment links."
            blockedBy="Your role at this property does not include reading folios (folio:read)."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Money taken and returned at this property, by the business date it was posted to.
        </p>
      </header>
      <PaymentsScreen
        hotelId={hotelId}
        initial={overview}
        canConfigure={session.permissions.includes('property:settings')}
      />
    </main>
  );
}
