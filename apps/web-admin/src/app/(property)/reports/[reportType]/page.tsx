import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ReportViewer } from '@/components/reports/report-viewer';
import { REPORT_BY_TYPE, reportTypeSchema } from '@repo/types';
import { fetchReport, reportCsvUrl } from '@/lib/properties-client';
import { firstParam, requireHotelId } from '@/lib/property-route';
import { requireCookieHeader } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Report',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * One report, at `/reports/sales?hotelId=31336&startDate=...&endDate=...`.
 *
 * ===========================================================================
 * A server component: the figures are fetched before the first paint, so the
 * page never shows an empty table that fills in afterwards. Window state lives
 * in the URL, so a given set of figures has a shareable address.
 *
 * Two refusals happen before any data is requested:
 *
 *   * An unknown `reportType` segment is a 404, not an empty report. The union
 *     is the contract; `/reports/made-up` is not a window with no rows, it is
 *     not a report.
 *   * A report the catalogue marks unavailable is also a 404 here, matching
 *     what the API does. Without this the directory's disabled button would be
 *     bypassable by typing the URL, and the user would meet a raw API error
 *     instead of the explanation the directory already gives them.
 * ===========================================================================
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportType: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reportType } = await params;
  const query = await searchParams;

  const parsed = reportTypeSchema.safeParse(reportType);
  if (!parsed.success) notFound();

  const definition = REPORT_BY_TYPE[parsed.data];
  if (!definition.availability.available) notFound();

  const hotelId = requireHotelId(query);
  const startDate = firstParam(query['startDate']);
  const endDate = firstParam(query['endDate']);

  const report = await fetchReport({
    hotelId,
    type: parsed.data,
    ...(startDate === undefined ? {} : { startDate }),
    ...(endDate === undefined ? {} : { endDate }),
    cookieHeader: await requireCookieHeader(),
  });

  const csvUrl = reportCsvUrl({
    hotelId,
    type: parsed.data,
    startDate: report.startDate,
    endDate: report.endDate,
  });

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-1">
        <Link
          href={`/reports/property-reports?hotelId=${encodeURIComponent(hotelId)}`}
          className="inline-flex w-fit items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All reports
        </Link>
        <h1 className="text-2xl font-bold tracking-tight text-white">{report.title}</h1>
        <p className="text-sm text-zinc-400">
          {report.propertyName}
          <span className="tabular ml-2 text-xs text-zinc-600">
            {report.propertyCode} · {report.rowCount} row{report.rowCount === 1 ? '' : 's'}
          </span>
        </p>
      </header>

      <ReportViewer report={report} hotelId={hotelId} csvUrl={csvUrl} />
    </main>
  );
}
