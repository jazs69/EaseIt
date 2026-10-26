'use client';

/**
 * The master report grid: sixteen columns, per-column filters, sticky totals.
 *
 * ===========================================================================
 * The totals row is the reason this is careful.
 *
 * It is pinned under the rows and labelled "Total", and it reports the server's
 * figures for the **whole filtered set** — not a sum of what is on screen.
 * Summing the visible rows would put "Total ₹5,600" under page one of forty
 * and there would be nothing to tell the reader which it was. The row count
 * beside the label says what the figure covers.
 *
 * Column filters are debounced and sent to the server for the same reason: a
 * client-side filter narrows only the loaded page, and the totals would then
 * describe a set the table is not showing.
 * ===========================================================================
 */

import { Filter, Loader2 } from 'lucide-react';
import Link from 'next/link';
import type { MasterReportResponse, MasterReportRow, ReportColumn } from '@repo/types';
import { cn } from '@repo/ui';

import { formatMoney } from '@/lib/money';

/** Which columns accept a per-column filter, and under which query key. */
export const FILTERABLE: Record<string, string> = {
  bookingId: 'bookingId',
  guest: 'guest',
  source: 'source',
  status: 'status',
  roomTypes: 'roomType',
  rooms: 'room',
};

/**
 * Sticky offsets, as constants because four call sites have to agree.
 *
 * `left-0` is the selection checkbox and `left-10` the first data column —
 * which the view always orders as the booking ID, so the row stays
 * identifiable when the operator scrolls forty columns sideways. Each sticky
 * cell carries its own background, because a transparent one lets the columns
 * underneath show through as it passes over them.
 *
 * The z-indices layer the corners: the header's first cell sits above both the
 * header row and the sticky column, which otherwise fight over the top-left.
 */
const STICKY_HEAD = 'sticky top-0 z-20 bg-zinc-900';
const STICKY_FILTER = 'sticky top-[29px] z-20 bg-zinc-900';
const STICKY_LEFT_0 = 'sticky left-0 z-30';
const STICKY_LEFT_1 = 'sticky left-10 z-10';

const STATUS_TONE: Record<string, string> = {
  CONFIRMED: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  CHECKED_IN: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  CHECKED_OUT: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
  CANCELLED: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  NO_SHOW: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  ON_HOLD: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  TENTATIVE: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
};

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

/** `2026-10-19` -> `Oct 19, 2026`. */
function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function isNumeric(column: ReportColumn): boolean {
  return column.kind === 'number' || column.kind === 'money' || column.kind === 'percent';
}

export interface MasterReportTableProps {
  report: MasterReportResponse;
  hotelId: string;
  filters: Record<string, string>;
  onFilterChange: (key: string, value: string) => void;
  selected: ReadonlySet<string>;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  pending: boolean;
}

export function MasterReportTable({
  report,
  hotelId,
  filters,
  onFilterChange,
  selected,
  onToggleRow,
  onToggleAll,
  pending,
}: MasterReportTableProps) {
  /**
   * Already narrowed by the server.
   *
   * The column selection is a query parameter, so the response carries exactly
   * the columns asked for — the table does not filter a wider set locally.
   * That is what keeps the CSV export and the screen in step: both are built
   * from the same `columns` list.
   */
  const columns = report.columns;
  const allOnPageSelected =
    report.rows.length > 0 && report.rows.every((row) => selected.has(row.reservationId));

  return (
    <div className="relative max-h-[70vh] overflow-auto rounded-xl border border-white/[0.08]">
      {pending ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/40 backdrop-blur-[1px]">
          <Loader2 className="size-5 animate-spin text-zinc-400" aria-hidden="true" />
          <span className="sr-only">Loading</span>
        </div>
      ) : null}

      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Master report for {report.propertyName}, {report.startDate} to {report.endDate}
        </caption>

        <thead>
          <tr className="border-b border-white/[0.08]">
            <th scope="col" className={cn(STICKY_HEAD, STICKY_LEFT_0, 'w-10 px-3 py-2')}>
              <input
                type="checkbox"
                checked={allOnPageSelected}
                onChange={onToggleAll}
                aria-label="Select every booking on this page"
                className="size-3.5 cursor-pointer accent-blue-500"
              />
            </th>
            {columns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  STICKY_HEAD,
                  'px-3 py-2 text-[10px] font-semibold tracking-wider whitespace-nowrap text-zinc-500 uppercase',
                  isNumeric(column) ? 'text-right' : 'text-left',
                  index === 0 && STICKY_LEFT_1,
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>

          {/* Per-column filters. Only the columns the server can filter on
              carry an input — offering one over a column the API cannot
              narrow would be a box that silently does nothing. */}
          <tr className="border-b border-white/[0.08]">
            <th className={cn(STICKY_FILTER, STICKY_LEFT_0, 'px-3 py-1.5')} />
            {columns.map((column, index) => {
              const queryKey = FILTERABLE[column.key];
              return (
                <th
                  key={column.key}
                  className={cn(
                    STICKY_FILTER,
                    'px-2 py-1.5',
                    index === 0 && STICKY_LEFT_1,
                  )}
                >
                  {queryKey === undefined ? null : (
                    <span className="relative flex items-center">
                      <Filter
                        className="pointer-events-none absolute left-2 size-3 text-zinc-600"
                        aria-hidden="true"
                      />
                      <input
                        type="text"
                        value={filters[queryKey] ?? ''}
                        onChange={(event) => {
                          onFilterChange(queryKey, event.target.value);
                        }}
                        placeholder="Search…"
                        aria-label={`Filter by ${column.label}`}
                        className="w-full min-w-[7rem] rounded-md border border-white/[0.08] bg-white/[0.03] py-1 pr-2 pl-7 text-[11px] font-normal text-white outline-none transition-colors placeholder:text-zinc-600 focus:border-blue-500/60"
                      />
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {report.rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + 1}
                className="px-3 py-10 text-center text-xs text-zinc-500"
              >
                No bookings matched. Widen the date range or clear a column filter.
              </td>
            </tr>
          ) : (
            report.rows.map((row) => (
              <tr
                key={row.reservationId}
                className={cn(
                  'border-b border-white/[0.04] transition-colors hover:bg-white/[0.02]',
                  selected.has(row.reservationId) && 'bg-blue-500/[0.06]',
                )}
              >
                <td
                  className={cn(
                    STICKY_LEFT_0,
                    'px-3 py-2',
                    selected.has(row.reservationId) ? 'bg-[#0d1424]' : 'bg-zinc-950',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(row.reservationId)}
                    onChange={() => {
                      onToggleRow(row.reservationId);
                    }}
                    aria-label={`Select booking ${row.bookingId}`}
                    className="size-3.5 cursor-pointer accent-blue-500"
                  />
                </td>
                {columns.map((column, index) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-3 py-2 text-xs whitespace-nowrap',
                      isNumeric(column) ? 'text-right tabular-nums' : 'text-left',
                      index === 0 && STICKY_LEFT_1,
                      index === 0 &&
                        (selected.has(row.reservationId) ? 'bg-[#0d1424]' : 'bg-zinc-950'),
                    )}
                  >
                    <Cell row={row} column={column} currency={report.currency} hotelId={hotelId} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>

        <tfoot className="sticky bottom-0 z-20">
          <tr className="border-t border-white/[0.12]">
            <td className={cn(STICKY_LEFT_0, 'bg-zinc-900 px-3 py-2.5')} />
            {columns.map((column, index) => (
              <td
                key={column.key}
                className={cn(
                  'bg-zinc-900 px-3 py-2.5 text-xs font-semibold whitespace-nowrap text-white',
                  isNumeric(column) ? 'text-right tabular-nums' : 'text-left',
                  index === 0 && STICKY_LEFT_1,
                )}
              >
                {index === 0 ? (
                  <span>
                    Total
                    {/* What the figure covers, so nobody reads a filtered
                        total as the whole property. */}
                    <span className="ml-1.5 font-normal text-zinc-500">
                      ({String(report.totals.bookingCount)} bookings)
                    </span>
                  </span>
                ) : (
                  <TotalCell
                    value={report.totals.byColumn[column.key]}
                    column={column}
                    currency={report.currency}
                  />
                )}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * A totals cell, or a dash where the column has no meaningful sum.
 *
 * Driven by whether the server put a figure under this column's key, not by a
 * list of names held here — so a new summable column needs no change in the
 * table.
 */
function TotalCell({
  value,
  column,
  currency,
}: {
  value: number | undefined;
  column: ReportColumn;
  currency: string;
}) {
  if (value === undefined) return <span className="text-zinc-600">-</span>;
  if (column.kind === 'money') return <>{formatMoney(value, currency)}</>;
  return <>{String(value)}</>;
}

/** One cell, formatted by its column's declared kind. */
function Cell({
  row,
  column,
  currency,
  hotelId,
}: {
  row: MasterReportRow;
  column: ReportColumn;
  currency: string;
  hotelId: string;
}) {
  const value = (row as unknown as Record<string, string | number | null>)[column.key];

  if (column.key === 'bookingId') {
    return (
      <Link
        href={`/folio/${encodeURIComponent(row.bookingId)}?hotelId=${encodeURIComponent(hotelId)}`}
        className="font-medium text-blue-400 underline-offset-2 hover:text-blue-300 hover:underline"
      >
        {row.bookingId}
      </Link>
    );
  }

  if (column.key === 'status') {
    return (
      <span
        className={cn(
          'inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide',
          STATUS_TONE[row.status] ?? 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
        )}
      >
        {statusLabel(row.status)}
      </span>
    );
  }

  if (value === null || value === undefined || value === '') {
    return <span className="text-zinc-600">-</span>;
  }

  if (column.kind === 'money' && typeof value === 'number') {
    return (
      <span className={cn(column.key === 'balanceMinor' && value > 0 && 'text-amber-300')}>
        {formatMoney(value, currency)}
      </span>
    );
  }

  if (column.kind === 'date' && typeof value === 'string') {
    return <>{formatDate(value)}</>;
  }

  if (column.key === 'leadTimeDays' && typeof value === 'number') {
    // "1 days" is what the reference shows; "1 day" is what English wants.
    return <>{`${String(value)} ${value === 1 ? 'day' : 'days'}`}</>;
  }

  return <>{String(value)}</>;
}
