/**
 * Per-property breakdown.
 *
 * ===========================================================================
 * A server component, and a real `<table>`.
 *
 * Nothing here is interactive, so none of it needs to ship to the browser; and
 * tabular data belongs in a table rather than a grid of divs — a screen reader
 * announces the column when it reads the cell, which is the difference between
 * "4,861" and "ADR, 4,861".
 *
 * Each row is formatted in **its own** currency, taken from the row rather than
 * from the portfolio header. A Colombo property reporting LKR must not have its
 * figures relabelled INR because ten of its eleven siblings are Indian; the
 * header's total is the figure that has to carry the mixed-currency warning,
 * not these.
 *
 * The share bar is drawn from the revenue column, so it cannot disagree with
 * it. It is a magnitude, so it is one hue at varying length — not a categorical
 * colour per row, which would imply the rows are different kinds of thing.
 * ===========================================================================
 */

import type { PropertyPerformanceRow } from '@repo/types';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { formatMoney, formatMoneyRounded } from '@/lib/money';

/** Signed YoY revenue change, or an em dash where there is no prior base. */
function YoyCell({ percent }: { percent: number | null }) {
  if (percent === null) {
    return <span className="text-zinc-600">—</span>;
  }
  if (percent === 0) {
    return <span className="tabular text-zinc-400">0.0%</span>;
  }

  const up = percent > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;

  return (
    <span
      className={`tabular inline-flex items-center gap-0.5 ${
        up ? 'text-emerald-400' : 'text-rose-400'
      }`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {up ? '+' : ''}
      {percent.toFixed(1)}%
    </span>
  );
}

export interface PropertyPerformanceTableProps {
  rows: readonly PropertyPerformanceRow[];
  /** True when the comparison was requested, so the YoY column is meaningful. */
  compared: boolean;
}

export function PropertyPerformanceTable({ rows, compared }: PropertyPerformanceTableProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Property breakdown</h2>
        <p className="text-[11px] text-zinc-500">
          {rows.length} {rows.length === 1 ? 'property' : 'properties'}, highest revenue first
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full min-w-[56rem] border-collapse text-left">
          <caption className="sr-only">
            Revenue, occupancy, ADR and RevPAR for each property in the selected period.
          </caption>
          <thead>
            <tr className="border-b border-white/[0.08] bg-white/[0.02]">
              <th
                scope="col"
                className="px-3 py-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Property
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Rooms
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Nights sold
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Occupancy
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                ADR
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                RevPAR
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Revenue
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Share
              </th>
              {compared ? (
                <th
                  scope="col"
                  className="px-3 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
                >
                  YoY
                </th>
              ) : null}
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={compared ? 9 : 8} className="px-3 py-8 text-center text-sm text-zinc-500">
                  No properties in scope for this period.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.propertyId}
                  className="border-b border-white/[0.04] transition-colors last:border-b-0 hover:bg-white/[0.02]"
                >
                  <th scope="row" className="px-3 py-2.5 font-normal">
                    <span className="block truncate text-xs font-medium text-white">
                      {row.name}
                    </span>
                    <span className="tabular block text-[10px] text-zinc-600">
                      {row.propertyCode}
                    </span>
                  </th>
                  <td className="tabular px-3 py-2.5 text-right text-xs text-zinc-300">
                    {row.rooms}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-xs text-zinc-300">
                    {row.roomNightsSold}
                    <span className="text-zinc-600">/{row.roomNightsAvailable}</span>
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-xs text-zinc-300">
                    {row.occupancy}%
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-xs text-zinc-300">
                    {row.adrMinor === null ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      formatMoney(row.adrMinor, row.currency)
                    )}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-xs text-zinc-300">
                    {formatMoney(row.revParMinor, row.currency)}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-xs font-semibold text-white">
                    {formatMoneyRounded(row.revenueMinor, row.currency)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center justify-end gap-2">
                      {/* The bar is recessive and the number is the data; the
                          bar exists to make the ordering scannable. */}
                      <span
                        aria-hidden="true"
                        className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-white/[0.06]"
                      >
                        <span
                          className="block h-full rounded-full bg-[#3987e5]"
                          style={{ width: `${String(Math.min(100, row.revenueSharePercent))}%` }}
                        />
                      </span>
                      <span className="tabular w-10 text-right text-xs text-zinc-400">
                        {row.revenueSharePercent}%
                      </span>
                    </span>
                  </td>
                  {compared ? (
                    <td className="px-3 py-2.5 text-right text-xs">
                      <YoyCell percent={row.yoyGrowthPercent} />
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
