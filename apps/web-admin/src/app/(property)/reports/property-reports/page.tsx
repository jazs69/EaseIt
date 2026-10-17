import type { Metadata } from 'next';

import { ReportCardGrid } from '@/components/reports/report-card-grid';
import { requireHotelId } from '@/lib/property-route';

export const metadata: Metadata = {
  title: 'Property reports',
  description: 'Operational and financial reports for one property.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * The property report directory, at `/reports/property-reports?hotelId=31336`.
 *
 * ===========================================================================
 * A server component in the `(property)` shell, so the top bar and the active
 * property context come from `(property)/layout.tsx`.
 *
 * The brief named `app/(dashboard)/reports/property-reports/`, but that group
 * carries the group sidebar and not the top bar — and the same brief requires
 * the property navigation bar with the active hotelId. `(property)` is the
 * only shell that provides it.
 *
 * Note the routing shape: this sits beside the dynamic `[reportType]` segment,
 * and Next resolves a static segment before a parametric one, so
 * `/reports/property-reports` reaches this directory rather than being read as
 * a report named "property-reports". The report type union would reject that
 * name anyway, so the failure mode is a clean 400 rather than a wrong page.
 * ===========================================================================
 */
export default async function PropertyReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Property Reports</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Operational and financial reports for this property. Figures come from the same
          inventory counters the booking path enforces against.
        </p>
      </header>

      <ReportCardGrid hotelId={hotelId} />
    </main>
  );
}
