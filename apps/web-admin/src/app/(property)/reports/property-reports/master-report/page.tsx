import type { Metadata } from 'next';

import { MasterReportView } from '@/components/reports/master-report/master-report-view';
import { fetchMasterReport } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireCookieHeader } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Master report',
  description: 'Detailed transaction and booking history for this property.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * The master report, at
 * `/reports/property-reports/master-report?hotelId=31346`.
 *
 * ===========================================================================
 * Note the route group: `(property)`, not `(dashboard)`.
 *
 * The brief placed this under `(dashboard)`, but every other report already
 * lives in `(property)` — `/reports`, `/reports/property-reports` and
 * `/reports/[reportType]` — and this one is property-scoped in exactly the
 * same way: it is addressed by `hotelId` and its figures come from a single
 * hotel's bookings. Putting it in the other group would give it a different
 * shell from the index page its back button returns to.
 *
 * Fetched on the server from the incoming request's cookie, so the first paint
 * already has rows. Every later change — window, dimension, filters, paging —
 * is a URL change that re-runs this component, which is why the client view
 * holds no copy of the data beyond what it is given.
 *
 * `page` and `limit` are read here rather than defaulted in the client,
 * because a bookmarked "page 3 of last month's cancellations" has to resolve
 * on the server for the first render to be the right one.
 * ===========================================================================
 */
export default async function MasterReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);

  const first = (key: string): string | undefined => {
    const value = params[key];
    const text = Array.isArray(value) ? value[0] : value;
    return text === undefined || text.trim() === '' ? undefined : text;
  };

  const report = await fetchMasterReport(
    hotelId,
    {
      startDate: first('startDate'),
      endDate: first('endDate'),
      dateDimension: first('dateDimension') as
        | 'CHECKOUT'
        | 'CHECKIN'
        | 'BOOKED'
        | 'STAY'
        | undefined,
      page: first('page') === undefined ? undefined : Number(first('page')),
      limit: first('limit') === undefined ? undefined : Number(first('limit')),
      bookingId: first('bookingId'),
      guest: first('guest'),
      source: first('source'),
      status: first('status'),
      roomType: first('roomType'),
      room: first('room'),
      columns: first('columns'),
    },
    { cookieHeader: await requireCookieHeader() },
  );

  return (
    <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      <MasterReportView report={report} hotelId={hotelId} />
    </main>
  );
}
