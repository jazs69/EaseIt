'use client';

/**
 * The report viewer: filter bar, table, totals, CSV.
 *
 * ===========================================================================
 * One generic table rather than nine bespoke ones.
 *
 * Every report arrives with its own `columns`, each carrying a `kind`, so the
 * renderer formats by declared type rather than by guessing from the value. A
 * column of room counts and a column of paise are both numbers on the wire,
 * and only the server knows which one is money — guessing would eventually
 * print ₹52.00 for 52 rooms.
 *
 * Window state lives in the **URL**, because each change is a different server
 * query: a GM can bookmark "last month's sales", the back button steps through
 * their own history, and a refresh lands on the same figures.
 *
 * Sorting is client-side and deliberately so — it reorders the rows already on
 * screen, with no round trip, and the window cap keeps that set small enough
 * for it to be instant.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import type { ReportColumn, ReportResponse, ReportRow } from '@repo/types';
import { ArrowDown, ArrowUp, Download, Info, Loader2, Printer, RefreshCw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import { formatMoney } from '@/lib/money';
import { shiftIsoDate } from '@/lib/calendar-format';

export interface ReportViewerProps {
  report: ReportResponse;
  hotelId: string;
  csvUrl: string;
}

/** Formats one cell by its declared kind. */
function renderCell(
  value: string | number | null | undefined,
  column: ReportColumn,
  currency: string,
): string {
  if (value === null || value === undefined) return '—';

  switch (column.kind) {
    case 'money':
      return typeof value === 'number' ? formatMoney(value, currency) : String(value);
    case 'percent':
      return typeof value === 'number' ? `${String(value)}%` : String(value);
    default:
      return String(value);
  }
}

export function ReportViewer({ report, hotelId, csvUrl }: ReportViewerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  function navigate(changes: Record<string, string | null>): void {
    const next = new URLSearchParams(searchParams.toString());
    next.set('hotelId', hotelId);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    startTransition(() => {
      router.push(`/reports/${report.type}?${next.toString()}`, { scroll: false });
    });
  }

  /**
   * Presets are computed from the report's own `generatedFor` — the property's
   * business date — never from the browser's clock. A night auditor working at
   * 02:00 local time would otherwise get "today" meaning the wrong day
   * (CLAUDE.md section 3.3).
   */
  const today = report.generatedFor;
  const presets = [
    { label: 'Today', start: today, end: today },
    {
      label: 'Yesterday',
      start: shiftIsoDate(today, -1),
      end: shiftIsoDate(today, -1),
    },
    { label: 'This month', start: `${today.slice(0, 7)}-01`, end: today },
  ];

  const sortedRows = useMemo((): ReportRow[] => {
    if (sort === null) return [...report.rows];

    return [...report.rows].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      // Nulls sort last whichever direction, because "no value" is not a
      // small value — an unassigned room is not room zero.
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;

      const comparison =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));

      return sort.dir === 'asc' ? comparison : -comparison;
    });
  }, [report.rows, sort]);

  function toggleSort(key: string): void {
    setSort((current) =>
      current === null || current.key !== key
        ? { key, dir: 'asc' }
        : current.dir === 'asc'
          ? { key, dir: 'desc' }
          : null,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.08] bg-[#0f141f]/70 p-3">
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] tracking-wider text-zinc-500 uppercase">From</span>
          <input
            type="date"
            value={report.startDate}
            onChange={(event) => {
              if (event.target.value.length > 0) navigate({ startDate: event.target.value });
            }}
            className="tabular rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
          />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-[10px] tracking-wider text-zinc-500 uppercase">To</span>
          <input
            type="date"
            value={report.endDate}
            onChange={(event) => {
              if (event.target.value.length > 0) navigate({ endDate: event.target.value });
            }}
            className="tabular rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
          />
        </label>

        <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900/60 p-0.5">
          {presets.map((preset) => {
            const active =
              report.startDate === preset.start && report.endDate === preset.end;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  navigate({ startDate: preset.start, endDate: preset.end });
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-white/[0.1] text-white'
                    : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {pending ? (
            <Loader2 className="size-4 animate-spin text-blue-400" aria-hidden="true" />
          ) : null}

          <button
            type="button"
            onClick={() => {
              startTransition(() => {
                router.refresh();
              });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:border-white/25"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </button>

          <button
            type="button"
            onClick={() => {
              window.print();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:border-white/25"
          >
            <Printer className="size-3.5" aria-hidden="true" />
            Print
          </button>

          {/* An ordinary link, so the browser's own download machinery handles
              the Content-Disposition filename and the progress UI. */}
          <a
            href={csvUrl}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-black transition hover:bg-zinc-200"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Download CSV
          </a>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            {report.title} for {report.propertyName}, {report.startDate} to {report.endDate}
          </caption>
          <thead>
            <tr className="border-b border-white/[0.08] bg-white/[0.02]">
              {report.columns.map((column) => {
                const active = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                    className={cn(
                      'px-3 py-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase',
                      column.kind === 'text' || column.kind === 'date'
                        ? 'text-left'
                        : 'text-right',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        toggleSort(column.key);
                      }}
                      className={cn(
                        'inline-flex items-center gap-1 transition-colors hover:text-zinc-300',
                        column.kind === 'text' || column.kind === 'date'
                          ? ''
                          : 'flex-row-reverse',
                      )}
                    >
                      {column.label}
                      {active ? (
                        sort.dir === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        )
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={report.columns.length}
                  className="px-3 py-8 text-center text-sm text-zinc-500"
                >
                  No rows for {report.startDate} to {report.endDate}.
                </td>
              </tr>
            ) : (
              sortedRows.map((row, index) => (
                <tr
                  key={index}
                  className="border-b border-white/[0.04] transition-colors last:border-b-0 hover:bg-white/[0.02]"
                >
                  {report.columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'tabular px-3 py-2 text-xs text-zinc-300',
                        column.kind === 'text' || column.kind === 'date'
                          ? 'text-left'
                          : 'text-right',
                      )}
                    >
                      {renderCell(row[column.key], column, report.currency)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>

          {report.totals !== null ? (
            <tfoot>
              <tr className="border-t border-white/[0.12] bg-white/[0.03]">
                {report.columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'tabular px-3 py-2 text-xs font-semibold text-white',
                      column.kind === 'text' || column.kind === 'date'
                        ? 'text-left'
                        : 'text-right',
                    )}
                  >
                    {renderCell(report.totals?.[column.key], column, report.currency)}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {/* Caveats. Printed under the table rather than hidden in a tooltip: a
          figure with a known approximation in it should carry that
          approximation wherever it goes. */}
      {report.notes.length > 0 ? (
        <ul className="flex flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
          {report.notes.map((note) => (
            <li key={note} className="flex items-start gap-2 text-[11px] leading-relaxed text-zinc-500">
              <Info className="mt-0.5 size-3 shrink-0 text-zinc-600" aria-hidden="true" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
