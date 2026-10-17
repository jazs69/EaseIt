import { redirect } from 'next/navigation';

import { firstParam } from '@/lib/property-route';

export const dynamic = 'force-dynamic';

/**
 * `/reports` is the directory's older address.
 *
 * It was the app launcher's target before the directory existed. Rather than
 * leave two screens claiming to be "reports", this forwards to the real one,
 * carrying the property across — an operator with the old link bookmarked
 * lands where they meant to.
 */
export default async function ReportsIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = firstParam(params['hotelId']);

  redirect(
    hotelId === undefined || hotelId.trim().length === 0
      ? '/group-dashboard'
      : `/reports/property-reports?hotelId=${encodeURIComponent(hotelId)}`,
  );
}
