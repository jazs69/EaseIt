/**
 * The report directory's card grid.
 *
 * ===========================================================================
 * A server component — nothing here is interactive beyond navigation.
 *
 * Each card reads its own availability from the shared catalogue. Four of the
 * nine reports need tables that do not exist, and those cards say so instead
 * of offering a button that would open a grid of zeros. That distinction is
 * the point of the screen: a general manager who opens "Guest ledger" and sees
 * every tax at ₹0.00 will file that as a fact about the business, not about
 * the schema.
 *
 * The blocked cards are still *rendered*, not hidden. A report that silently
 * disappears is indistinguishable from one that was never specified, and the
 * operator has no way to ask when it is coming.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import { REPORT_CATALOGUE } from '@repo/types';
import { ArrowRight, Lock } from 'lucide-react';
import Link from 'next/link';

export interface ReportCardGridProps {
  hotelId: string;
}

export function ReportCardGrid({ hotelId }: ReportCardGridProps) {
  const scoped = `hotelId=${encodeURIComponent(hotelId)}`;

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
      {REPORT_CATALOGUE.map((report) => {
        const open = report.availability.available;

        return (
          <article
            key={report.type}
            className={cn(
              'flex flex-col rounded-xl border p-5 transition-all',
              'bg-[#0f141f]/70',
              open
                ? 'border-white/[0.08] hover:border-white/20'
                : 'border-white/[0.05]',
            )}
          >
            <div className="flex-1">
              {report.isMostUsed ? (
                <span className="mb-3 inline-block rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                  Most used
                </span>
              ) : null}

              {!open ? (
                <span className="mb-3 inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/[0.12] px-2 py-0.5 text-[10px] font-medium text-amber-400">
                  <Lock className="size-2.5" aria-hidden="true" />
                  Not built yet
                </span>
              ) : null}

              <h2
                className={cn(
                  'text-sm font-semibold',
                  open ? 'text-white' : 'text-zinc-400',
                )}
              >
                {report.title}
              </h2>

              <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
                {report.description}
              </p>

              {/* The reason, in the operator's language. Not an error — nothing
                  went wrong; the report is downstream of work not yet done. */}
              {!open && report.availability.blockedBy !== null ? (
                <p className="mt-3 border-l-2 border-amber-500/30 pl-2.5 text-[11px] leading-relaxed text-amber-200/70">
                  {report.availability.blockedBy}
                </p>
              ) : null}
            </div>

            <div className="mt-4">
              {open ? (
                <Link
                  href={`/reports/${report.type}?${scoped}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-zinc-800"
                >
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                  Open report
                </Link>
              ) : (
                <button
                  type="button"
                  disabled
                  title={report.availability.blockedBy ?? 'Not available yet'}
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/[0.06] bg-zinc-900/50 px-3.5 py-2 text-xs font-medium text-zinc-600"
                >
                  <Lock className="size-3.5" aria-hidden="true" />
                  Unavailable
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
