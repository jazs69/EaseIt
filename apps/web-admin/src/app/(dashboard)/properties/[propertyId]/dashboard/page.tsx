import { redirect } from 'next/navigation';

/**
 * Superseded per-property route.
 *
 * This was the property shell before the operations dashboard existed. It now
 * forwards to `/property-dashboard?hotelId=…`, which is the real screen.
 *
 * Kept as a redirect rather than deleted because the group dashboard pointed
 * here until recently and links may still exist. The uuid is passed straight
 * through: `hotelId` accepts a code or a uuid, and either way the API resolves
 * it against the caller's own grants, so forwarding an id the operator has no
 * access to still lands on a not-found.
 */
export default async function LegacyPropertyDashboardRedirect({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  redirect(`/property-dashboard?hotelId=${encodeURIComponent(propertyId)}`);
}
