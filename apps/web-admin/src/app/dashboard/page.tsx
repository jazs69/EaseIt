import { redirect } from 'next/navigation';

/**
 * Legacy landing route.
 *
 * `/dashboard` was where sign-in used to go, when a session meant exactly one
 * property. It now means a *group* of properties, so the landing page is
 * `/group-dashboard` and the per-property shell is
 * `/properties/{propertyId}/dashboard`.
 *
 * Kept as a redirect rather than deleted: bookmarks exist, and so do any links
 * still pointing here. Nothing renders, so there is no second copy of the
 * dashboard to keep in step.
 */
export default function LegacyDashboardRedirect(): never {
  redirect('/group-dashboard');
}
