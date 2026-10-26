import type { Metadata } from 'next';

import { PropertyConfigView } from '@/components/property-config/property-config-view';
import { requireCookieHeader } from '@/lib/server-session';
import { requireHotelId } from '@/lib/property-route';
import { fetchPropertySetup } from '@/lib/properties-client';

export const metadata: Metadata = {
  title: 'Property config',
  description: 'Desk times, GST slabs, amenities, policies and media for this property.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Property configuration, at `/settings/property-config?hotelId=31336`.
 *
 * ===========================================================================
 * This replaced a placeholder, and it is worth saying what unblocked it.
 *
 * The placeholder named one blocker: section 3.4 requires every mutation of
 * tax or money configuration to write an `audit_log` row in the same
 * transaction, and an editor without that would change the inputs to every
 * folio calculation leaving no record of who changed what. `audit_log` now
 * exists, and each write here does exactly that — so the reason not to build
 * this screen has gone, and the screen is here.
 *
 * It also named a second: that these settings had no consumers. That is now
 * only half true, and the tabs say which half. Desk times place reservation
 * strips on the calendar, and the GST slabs price every quote and every folio
 * line — those are live. Fees, the structured cancellation terms and the media
 * list are recorded but not yet read by anything, and each of those sections
 * carries a notice saying so rather than letting an operator assume otherwise.
 *
 * Fetched on the server so the first paint has data, then handed to a client
 * component that owns the editing. Property identity is deliberately not
 * editable here — see `general-tab.tsx`.
 *
 * Note where this sits: `(property)/settings/...`, while
 * `/settings/access-control` lives in `(dashboard)`. Two route groups each own
 * part of `/settings/*`, which Next resolves fine — the leaf paths differ —
 * but which means the two settings screens wear different shells. Access
 * control is itself property-scoped and arguably belongs in this one; moving
 * it is a separate change with its own navigation consequences, so the
 * inconsistency stays visible rather than being papered over here.
 * ===========================================================================
 */
export default async function PropertyConfigPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);

  const setup = await fetchPropertySetup(hotelId, {
    cookieHeader: await requireCookieHeader(),
  });

  return (
    <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      <PropertyConfigView setup={setup} hotelId={hotelId} />
    </main>
  );
}
