import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { FolioView } from '@/components/folio/folio-view';
import { fetchFolioPage } from '@/lib/properties-client';
import { requireCookieHeader } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Folio',
  description: 'Guest ledger and billing for one booking.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The folio and billing page, at `/folio/SFBOOKING_31001_A03?hotelId=31001`.
 *
 * ===========================================================================
 * Routed by booking code, scoped by hotel.
 *
 * The code is what a clerk reads off a registration card and says down the
 * phone, so it is what the URL carries — a uuid here would be unreadable and
 * unshareable. It is unique *per property*, which is why `hotelId` is
 * required rather than optional: without it the code is ambiguous, and the API
 * resolves both through the caller's own grants so another hotel's booking
 * comes back not-found rather than as data (CLAUDE.md section 3.2).
 *
 * Fetched server-side so the first paint is the real ledger. The figures on
 * this page are the ones a guest is handed at check-out; a skeleton that
 * reflows into numbers is the wrong experience for them.
 * ===========================================================================
 */
export default async function FolioPageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ bookingCode: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { bookingCode } = await params;
  const query = await searchParams;
  const hotelId = first(query['hotelId']);

  if (hotelId === undefined || hotelId.trim().length === 0) {
    // A booking code with no property is ambiguous by construction, so there
    // is nothing to render. Back to the picker, which is the next action.
    redirect('/group-dashboard');
  }

  const folio = await fetchFolioPage(hotelId, decodeURIComponent(bookingCode), {
    cookieHeader: await requireCookieHeader(),
  });

  return (
    <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      <FolioView folio={folio} hotelId={hotelId} />
    </main>
  );
}
