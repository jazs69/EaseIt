import { redirect } from 'next/navigation';

/**
 * The admin app's root.
 *
 * Middleware has already decided whether there is a session, so by the time
 * this renders the answer is yes — and the landing page for a signed-in staff
 * member is their group of properties. A signed-out visitor never reaches
 * here; they are redirected to /login before this route is invoked.
 *
 * This replaced a placeholder that rendered the RBAC catalog out of
 * @repo/types as a workspace-wiring smoke test. That check now lives in the
 * build itself — the group dashboard imports the same package — so the page
 * was a redundant screen a real operator could land on.
 */
export default function AdminRootPage(): never {
  redirect('/group-dashboard');
}
