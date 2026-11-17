import type { Metadata } from 'next';
import { Wallet } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { DirectBillingScreen } from '@/components/direct-billing/direct-billing-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchDirectBilling } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Direct billing',
  description: 'Company accounts on the city ledger: balances, aging and payments.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Direct billing, at `/direct-billing?hotelId=31336` (GP-07).
 *
 * The accounts are fetched server-side. A user without
 * `financial_reports:read` gets a plain explanation, not an error page; the
 * payment form is offered only with `direct_billing:manage`, which the server
 * enforces regardless.
 */
export default async function DirectBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { session, cookieHeader } = await requireSession();

  let overview;
  try {
    overview = await fetchDirectBilling(hotelId, { cookieHeader });
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={Wallet}
            title="Direct billing"
            summary="Company accounts on the city ledger: balances, aging and payments."
            blockedBy="Your role at this property does not include financial reports (financial_reports:read). Ask an administrator to grant it."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Direct billing</h1>
        <p className="text-sm text-muted-foreground">
          What each company owes this property, how old it is, and the payments against it.
        </p>
      </header>
      <DirectBillingScreen
        hotelId={hotelId}
        initial={overview}
        canManage={session.permissions.includes('direct_billing:manage')}
      />
    </main>
  );
}
