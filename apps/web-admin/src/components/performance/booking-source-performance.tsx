'use client';

/**
 * Revenue and room-nights per sales channel, as horizontal bars.
 *
 * ===========================================================================
 * Built from CSS rather than a charting library.
 *
 * Eight horizontal bars on a linear scale is layout, not visualisation
 * machinery, and CLAUDE.md section 6.4 asks what the existing stack cannot do
 * before a dependency is added. Recharts is 7.1 MB unpacked and would arrive
 * for this and the monthly chart alone. Divs also give the bars real text
 * nodes, so the labels are selectable and the whole thing degrades to a
 * readable list with styles off — an SVG `<text>` does neither.
 *
 * Decisions that follow the data-visualisation method:
 *
 *   * **One measure at a time, so no legend.** The toggle names what is drawn.
 *   * **One hue, varying length.** This is a magnitude encoding; a colour per
 *     channel would imply the rows are different kinds of thing and would
 *     repaint as the ordering changed.
 *   * **The fill is `#3b4758`, which is 1.95:1 against this card.** Below the
 *     3:1 floor, so the method requires relief rather than permission: every
 *     bar carries its value in ink in a fixed column, and a table view is one
 *     click away. The number is never carried by the fill alone. `#55657a` is
 *     the nearest slate that clears 3:1 if the bar should stand on its own.
 *   * **Hit targets are whole rows**, not the 24px bars.
 *   * **Zero keeps its row.** A channel that sold nothing is information, and
 *     a chart whose rows appear and vanish between Today and MTD cannot be
 *     compared against itself. Empty rows get a dim stub so the row reads as
 *     empty rather than as a failed render.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import type { BookingSourceMetricType, BookingSourcePerformance } from '@repo/types';
import { useState } from 'react';

import { formatMoney, formatMoneyCompact, formatMoneyRounded } from '@/lib/money';

/** The fill from the spec. See the contrast note above. */
const BAR_FILL = '#3b4758';
const BAR_FILL_HOVER = '#55657a';

const MODES: readonly { value: BookingSourceMetricType; label: string }[] = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'rooms_sold', label: 'Rooms sold' },
];

/**
 * Axis ticks on a 1 / 2 / 2.5 / 5 x 10^n ladder.
 *
 * Ticks have to land on numbers a reader recognises. Dividing the maximum into
 * five equal parts gives ₹4,13,333 and similar, which is arithmetically fine
 * and unreadable — so the step is snapped up to the next round value and the
 * axis is allowed to extend past the longest bar.
 */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];

  const rawStep = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) *
    magnitude;

  // Runs until a tick is at or past the maximum, so the top tick always
  // covers the longest bar. Stopping at `value <= max` instead leaves the axis
  // short of the data — ₹54,200 against a ₹40k axis is a 135% bar, which the
  // track clips to 100%, making the two largest channels render identically.
  // Overshooting the axis is free; under-running it silently loses the ranking.
  const ticks: number[] = [];
  for (let value = 0; ; value += step) {
    ticks.push(Math.round(value));
    if (value >= max) break;
  }
  return ticks;
}

export interface BookingSourcePerformanceProps {
  bookingSources: BookingSourcePerformance;
  currency: string;
  /** For the subtitle, so the card states which window it is describing. */
  periodLabel: string;
}

export function BookingSourcePerformance({
  bookingSources,
  currency,
  periodLabel,
}: BookingSourcePerformanceProps) {
  const [mode, setMode] = useState<BookingSourceMetricType>(bookingSources.metricType);
  const [hovered, setHovered] = useState<string | null>(null);

  const isRevenue = mode === 'revenue';

  const valueOf = (row: BookingSourcePerformance['sources'][number]): number =>
    isRevenue ? row.revenueMinor : row.roomNightsSold;

  const formatValue = (value: number): string =>
    isRevenue ? formatMoneyRounded(value, currency) : String(value);

  const formatTick = (value: number): string =>
    isRevenue ? formatMoneyCompact(value, currency) : String(value);

  // Ordered by size within the selected measure, so the chart answers "who is
  // biggest" at a glance. The canonical order is kept for the table view,
  // where a stable row order matters more than ranking.
  const ranked = [...bookingSources.sources].sort((a, b) => valueOf(b) - valueOf(a));
  const ticks = niceTicks(Math.max(...ranked.map((row) => valueOf(row))));
  const axisMax = ticks[ticks.length - 1] ?? 1;

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-white/[0.08] bg-[#0f141f]/70 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lg font-semibold text-white">Booking Source Performance</h2>
          <p className="text-[11px] text-zinc-500">
            {isRevenue ? 'Revenue' : 'Room-nights'} by sales channel · {periodLabel}
          </p>
        </div>

        {/* Segmented pill. Two mutually exclusive views of one dataset, so a
            switch rather than a dropdown — both options stay visible. */}
        <div
          role="group"
          aria-label="Measure"
          className="flex items-center gap-0.5 rounded-full border border-white/10 bg-zinc-900/60 p-0.5"
        >
          {MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={mode === option.value}
              onClick={() => {
                setMode(option.value);
                setHovered(null);
              }}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                mode === option.value
                  ? 'bg-white/[0.1] text-white'
                  : 'text-zinc-400 hover:bg-white/[0.05] hover:text-white',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {bookingSources.isEmpty ? (
        <p className="py-6 text-center text-sm text-zinc-500">
          No channel recorded a booking in this period.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {ranked.map((row) => {
              const value = valueOf(row);
              const share = isRevenue ? row.revenueSharePercent : row.roomNightsSharePercent;
              const active = hovered === row.source;
              const widthPercent = axisMax === 0 ? 0 : (value / axisMax) * 100;

              return (
                <div
                  key={row.source}
                  // The whole row is the hit target, far larger than the bar.
                  onMouseEnter={() => {
                    setHovered(row.source);
                  }}
                  onMouseLeave={() => {
                    setHovered(null);
                  }}
                  className="relative grid grid-cols-[7.5rem_1fr_5.5rem] items-center gap-3 rounded-lg px-1 py-0.5 transition-colors hover:bg-white/[0.02]"
                >
                  <span className="truncate text-xs font-medium tracking-wide text-zinc-400 uppercase">
                    {row.label}
                  </span>

                  {/* Track, then fill. The track makes an empty row read as
                      empty rather than as a row that failed to draw. */}
                  <span className="relative block h-7 w-full overflow-hidden rounded-r-lg bg-white/[0.03]">
                    {value === 0 ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 w-[2px] rounded-full bg-white/[0.12]"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 rounded-r-lg transition-[background-color,width] duration-150"
                        style={{
                          width: `${String(Math.max(widthPercent, 0.4))}%`,
                          backgroundColor: active ? BAR_FILL_HOVER : BAR_FILL,
                        }}
                      />
                    )}
                  </span>

                  {/* The obligated relief: the value in ink, always, in a
                      fixed column that does not depend on the fill. */}
                  <span className="tabular text-right text-xs font-semibold text-zinc-200">
                    {formatValue(value)}
                  </span>

                  {active ? (
                    <div className="pointer-events-none absolute top-full left-28 z-20 mt-0.5 w-56 rounded-lg border border-white/[0.12] bg-[#0b0e16] px-3 py-2 shadow-xl">
                      <p className="text-[11px] font-semibold text-white">{row.label}</p>
                      <dl className="mt-1 flex flex-col gap-0.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <dt className="text-[10px] text-zinc-500">Revenue</dt>
                          <dd className="tabular text-[11px] text-zinc-200">
                            {formatMoney(row.revenueMinor, currency)}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <dt className="text-[10px] text-zinc-500">Room-nights</dt>
                          <dd className="tabular text-[11px] text-zinc-200">
                            {row.roomNightsSold}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <dt className="text-[10px] text-zinc-500">
                            Share of {isRevenue ? 'revenue' : 'room-nights'}
                          </dt>
                          <dd className="tabular text-[11px] text-zinc-200">{share}%</dd>
                        </div>
                      </dl>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* X axis, aligned to the plot column by the same grid as the rows. */}
          <div className="grid grid-cols-[7.5rem_1fr_5.5rem] gap-3 px-1">
            <span />
            <span className="relative block h-4 border-t border-white/[0.06]">
              {ticks.map((tick, index) => (
                <span
                  key={tick}
                  className="tabular absolute top-1 text-[9px] text-zinc-600"
                  style={{
                    left: `${String(axisMax === 0 ? 0 : (tick / axisMax) * 100)}%`,
                    // The last tick sits on the right edge and would overflow.
                    transform:
                      index === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                  }}
                >
                  {formatTick(tick)}
                </span>
              ))}
            </span>
            <span />
          </div>

          <footer className="flex flex-wrap items-baseline justify-between gap-2 border-t border-white/[0.06] pt-3">
            <span className="text-[11px] text-zinc-500">
              {isRevenue ? 'Total revenue' : 'Total room-nights'} across all channels
            </span>
            <span className="tabular text-sm font-semibold text-white">
              {isRevenue
                ? formatMoneyRounded(bookingSources.totalRevenueMinor, currency)
                : bookingSources.totalRoomNightsSold}
            </span>
          </footer>

          {/* Table view — the method's requirement, and the relief the
              low-contrast fill obligates. Canonical order, not ranked, so the
              rows stay put between measures. */}
          <details>
            <summary className="cursor-pointer text-[10px] text-zinc-600 transition-colors hover:text-zinc-400">
              Show as a table
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">
                  Revenue, room-nights and share of total for each booking source.
                </caption>
                <thead>
                  <tr className="border-b border-white/[0.08]">
                    <th
                      scope="col"
                      className="py-1 pr-3 text-[9px] font-semibold tracking-wider text-zinc-600 uppercase"
                    >
                      Source
                    </th>
                    <th
                      scope="col"
                      className="py-1 pr-3 text-right text-[9px] font-semibold tracking-wider text-zinc-600 uppercase"
                    >
                      Revenue
                    </th>
                    <th
                      scope="col"
                      className="py-1 pr-3 text-right text-[9px] font-semibold tracking-wider text-zinc-600 uppercase"
                    >
                      Room-nights
                    </th>
                    <th
                      scope="col"
                      className="py-1 text-right text-[9px] font-semibold tracking-wider text-zinc-600 uppercase"
                    >
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bookingSources.sources.map((row) => (
                    <tr
                      key={row.source}
                      className="border-b border-white/[0.04] last:border-b-0"
                    >
                      <td className="py-1 pr-3 text-[10px] text-zinc-400">{row.label}</td>
                      <td className="tabular py-1 pr-3 text-right text-[10px] text-zinc-200">
                        {formatMoney(row.revenueMinor, currency)}
                      </td>
                      <td className="tabular py-1 pr-3 text-right text-[10px] text-zinc-200">
                        {row.roomNightsSold}
                      </td>
                      <td className="tabular py-1 text-right text-[10px] text-zinc-200">
                        {isRevenue ? row.revenueSharePercent : row.roomNightsSharePercent}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
