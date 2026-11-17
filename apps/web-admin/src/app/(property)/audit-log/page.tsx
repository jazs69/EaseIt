import type { Metadata } from 'next';
import { ScrollText } from 'lucide-react';

import { AuditLogViewer } from '@/components/audit-log/audit-log-viewer';
import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchAuditLog, fetchAuditLogFacets } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Audit log',
  description: 'Who changed what at this property, with the values before and after.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * The audit log, at `/audit-log?hotelId=31336` (AD-03).
 *
 * The first page and the filter options are fetched server-side. A user
 * without `audit_log:read` gets a plain explanation, not an error page.
 */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { cookieHeader } = await requireSession();

  let page;
  let facets;
  try {
    [page, facets] = await Promise.all([
      fetchAuditLog(hotelId, {}, { cookieHeader }),
      fetchAuditLogFacets(hotelId, { cookieHeader }),
    ]);
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={ScrollText}
            title="Audit log"
            summary="Who changed what at this property, with the values before and after."
            blockedBy="Your role at this property does not include the audit log (audit_log:read). Ask an administrator to grant it."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every recorded change at this property, newest first. Times and dates are in the hotel’s
          timezone ({page.timeZone}).
        </p>
      </header>
      <AuditLogViewer hotelId={hotelId} initial={page} facets={facets} />
    </main>
  );
}
