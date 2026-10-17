'use client';

/**
 * Monthly trajectory — one metric at a time, as an area chart.
 *
 * ===========================================================================
 * Inline SVG rather than a charting library.
 *
 * This is one single-series area chart with a crosshair tooltip. Recharts is
 * 7.1 MB unpacked, and CLAUDE.md section 6.4 asks what the existing stack
 * cannot do before a dependency is added — for twelve points on a linear scale,
 * the answer is "nothing". If the product later needs many chart types, a
 * library earns its place; it does not earn it here.
 *
 * Design decisions follow the data-visualisation method:
 *
 *   * **One series, so no legend.** The card title and the metric selector
 *     name it; a legend box for a single line is noise.
 *   * **Colour follows the metric, not its rank.** Each measure keeps its own
 *     hue whichever is selected, so switching never repaints meaning. The four
 *     hues were validated against this card's `#0f141f` surface — lightness
 *     band, chroma floor, CVD separation and 3:1 contrast all pass.
 *   * **The line breaks where there is no data.** A month with no capacity
 *     configured is not zero revenue; plotting it as zero invents a dip. Those
 *     months are drawn as a gap with a hollow marker.
 *   * **Non-scaling strokes.** The SVG scales to its container, so without
 *     `vector-effect` a 2px line would thin or thicken with the viewport.
 *   * **Hit targets are full-height columns**, not the 8px markers, so hovering
 *     is forgiving.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  PERFORMANCE_METRIC_LABELS,
  performanceMetricSchema,
  type MonthlyPerformance,
  type PerformanceMetric,
} from '@repo/types';
import { useState } from 'react';

import { formatMoney } from '@/lib/money';

/** One hue per metric, validated against the `#0f141f` card surface. */
const METRIC_COLOUR: Record<PerformanceMetric, string> = {
  revenue: '#3987e5',
  occupancy: '#199e70',
  adr: '#c98500',
  revpar: '#d55181',
};

const VIEW_WIDTH = 760;
const VIEW_HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 } as const;

const PLOT_WIDTH = VIEW_WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom;

/** The raw value of a metric for one month, or null where there is no data. */
function valueOf(point: MonthlyPerformance, metric: PerformanceMetric): number | null {
  if (!point.hasData) return null;
  switch (metric) {
    case 'revenue':
      return point.revenueMinor;
    case 'occupancy':
      return point.occupancy;
    case 'adr':
      return point.adrMinor;
    case 'revpar':
      return point.revParMinor;
  }
}

export interface MonthlyPerformanceChartProps {
  monthlyData: readonly MonthlyPerformance[];
  currency: string;
}

export function MonthlyPerformanceChart({
  monthlyData,
  currency,
}: MonthlyPerformanceChartProps) {
  const [metric, setMetric] = useState<PerformanceMetric>('revenue');
  const [hovered, setHovered] = useState<number | null>(null);

  const colour = METRIC_COLOUR[metric];
  const isMoney = metric !== 'occupancy';

  const values = monthlyData.map((point) => valueOf(point, metric));
  const present = values.filter((value): value is number => value !== null);
  // A flat-zero series would divide by zero below; 1 keeps the baseline at the
  // bottom rather than through the middle.
  const maxValue = Math.max(1, ...present);

  const stepX = monthlyData.length > 1 ? PLOT_WIDTH / (monthlyData.length - 1) : 0;
  const pointAt = (index: number, value: number): { x: number; y: number } => ({
    x: PAD.left + index * stepX,
    y: PAD.top + PLOT_HEIGHT - (value / maxValue) * PLOT_HEIGHT,
  });

  /**
   * Line and fill, split into runs of consecutive months that have data.
   *
   * Building one path per run is what produces the gap: a single path through
   * the missing months would draw a straight line across them, which reads as
   * real data.
   */
  const runs: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    current.push(pointAt(index, value));
  });
  if (current.length > 0) runs.push(current);

  const formatValue = (value: number): string =>
    isMoney ? formatMoney(value, currency) : `${String(value)}%`;

  const axisLabel = (value: number): string => {
    if (!isMoney) return `${String(Math.round(value))}%`;
    const major = value / 100;
    if (major >= 10_000_000) return `${(major / 10_000_000).toFixed(1)}Cr`;
    if (major >= 100_000) return `${(major / 100_000).toFixed(1)}L`;
    if (major >= 1_000) return `${(major / 1_000).toFixed(0)}k`;
    return String(Math.round(major));
  };

  /**
   * Gridline fractions, top to bottom, each with the value it marks.
   *
   * A label is drawn only when it differs from the one below it. With no data
   * the scale collapses to the floor of 1 minor unit, every tick rounds to the
   * same "0", and five stacked zeros read as a broken axis rather than as an
   * empty one — so only the baseline survives.
   */
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    fraction,
    label: axisLabel(maxValue * (1 - fraction)),
  }));
  const hoveredPoint = hovered === null ? null : monthlyData[hovered];
  const hoveredValue = hovered === null ? null : values[hovered];

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-[#0f141f]/70 p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-white">Monthly performance</h2>
          <p className="text-[11px] text-zinc-500">
            {PERFORMANCE_METRIC_LABELS[metric]} by month, {monthlyData[0]?.monthKey.slice(0, 4)}
          </p>
        </div>

        <label className="flex items-center gap-1.5">
          <span className="sr-only">Metric</span>
          <select
            value={metric}
            onChange={(event) => {
              setMetric(event.target.value as PerformanceMetric);
              setHovered(null);
            }}
            className="rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1 text-[11px] font-medium text-white focus:border-blue-500 focus:outline-none"
          >
            {performanceMetricSchema.options.map((option) => (
              <option key={option} value={option} className="bg-zinc-900">
                {PERFORMANCE_METRIC_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="relative">
        <svg
          viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
          className="h-56 w-full"
          role="img"
          aria-label={`${PERFORMANCE_METRIC_LABELS[metric]} by month. ${present.length} of ${String(monthlyData.length)} months have data.`}
        >
          <defs>
            <linearGradient id={`fill-${metric}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colour} stopOpacity="0.28" />
              <stop offset="100%" stopColor={colour} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Recessive grid: present enough to read a value against, never
              competing with the data. */}
          {axisTicks.map((tick, index) => {
            const y = PAD.top + PLOT_HEIGHT * tick.fraction;
            const next = axisTicks[index + 1];
            const showLabel = next === undefined || next.label !== tick.label;
            return (
              <g key={tick.fraction}>
                <line
                  x1={PAD.left}
                  y1={y}
                  x2={VIEW_WIDTH - PAD.right}
                  y2={y}
                  stroke="rgba(255,255,255,0.07)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                {showLabel ? (
                  <text
                    x={PAD.left - 8}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-zinc-600 text-[9px]"
                  >
                    {tick.label}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* Fill and line, one path per run of consecutive data. */}
          {runs.map((run, index) => {
            const first = run[0];
            const last = run[run.length - 1];
            if (first === undefined || last === undefined) return null;
            const baseline = PAD.top + PLOT_HEIGHT;
            const line = run.map((point) => `${String(point.x)},${String(point.y)}`).join(' ');

            return (
              <g key={index}>
                <polygon
                  points={`${String(first.x)},${String(baseline)} ${line} ${String(last.x)},${String(baseline)}`}
                  fill={`url(#fill-${metric})`}
                />
                <polyline
                  points={line}
                  fill="none"
                  stroke={colour}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}

          {/* Crosshair for the hovered month. */}
          {hovered !== null && hoveredValue !== null && hoveredValue !== undefined ? (
            <line
              x1={pointAt(hovered, hoveredValue).x}
              y1={PAD.top}
              x2={pointAt(hovered, hoveredValue).x}
              y2={PAD.top + PLOT_HEIGHT}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* Markers. Hollow where a month has no data, so the gap is explicit
              rather than just an absence. */}
          {values.map((value, index) => {
            const x = PAD.left + index * stepX;
            if (value === null) {
              return (
                <circle
                  key={index}
                  cx={x}
                  cy={PAD.top + PLOT_HEIGHT}
                  r={3}
                  fill="none"
                  stroke="rgba(255,255,255,0.2)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            }
            const point = pointAt(index, value);
            const active = hovered === index;
            return (
              <circle
                key={index}
                cx={point.x}
                cy={point.y}
                r={active ? 5 : 3.5}
                fill={colour}
                // A surface-coloured ring, so an overlapping marker still reads
                // as a distinct mark.
                stroke="#0f141f"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* Month labels. */}
          {monthlyData.map((point, index) => (
            <text
              key={point.monthKey}
              x={PAD.left + index * stepX}
              y={VIEW_HEIGHT - 10}
              textAnchor="middle"
              className={cn(
                'text-[9px]',
                hovered === index ? 'fill-zinc-200' : 'fill-zinc-600',
              )}
            >
              {point.month}
            </text>
          ))}

          {/* Hit targets: full-height columns, far bigger than the markers. */}
          {monthlyData.map((point, index) => (
            <rect
              key={`hit-${point.monthKey}`}
              x={PAD.left + index * stepX - stepX / 2}
              y={PAD.top}
              width={Math.max(stepX, 1)}
              height={PLOT_HEIGHT}
              fill="transparent"
              onMouseEnter={() => {
                setHovered(index);
              }}
              onMouseLeave={() => {
                setHovered(null);
              }}
            />
          ))}
        </svg>

        {/* Tooltip. Text wears ink tokens; the colour chip beside it carries
            identity, so the numbers stay legible. */}
        {hoveredPoint !== undefined && hoveredPoint !== null ? (
          <div
            className="pointer-events-none absolute top-2 rounded-lg border border-white/[0.12] bg-[#0b0e16] px-2.5 py-1.5 shadow-xl"
            style={{
              left: `${String(((PAD.left + (hovered ?? 0) * stepX) / VIEW_WIDTH) * 100)}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <p className="text-[10px] font-semibold text-zinc-200">{hoveredPoint.monthKey}</p>
            <p className="flex items-center gap-1.5 text-[11px]">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: colour }}
              />
              <span className="tabular font-semibold text-white">
                {hoveredValue === null || hoveredValue === undefined
                  ? 'No data'
                  : formatValue(hoveredValue)}
              </span>
            </p>
            {hoveredPoint.hasData ? (
              <p className="tabular text-[9px] text-zinc-500">
                {hoveredPoint.roomNightsSold} room-nights sold
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* The table view the method asks for, so the data is never colour-only. */}
      <details className="group">
        <summary className="cursor-pointer text-[10px] text-zinc-600 transition-colors hover:text-zinc-400">
          Show as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              {PERFORMANCE_METRIC_LABELS[metric]} by month
            </caption>
            <thead>
              <tr className="border-b border-white/[0.08]">
                <th scope="col" className="py-1 pr-3 text-[9px] font-semibold tracking-wider text-zinc-600 uppercase">
                  Month
                </th>
                <th scope="col" className="py-1 text-right text-[9px] font-semibold tracking-wider text-zinc-600 uppercase">
                  {PERFORMANCE_METRIC_LABELS[metric]}
                </th>
              </tr>
            </thead>
            <tbody>
              {monthlyData.map((point, index) => {
                const value = values[index];
                return (
                  <tr key={point.monthKey} className="border-b border-white/[0.04] last:border-b-0">
                    <td className="py-1 pr-3 text-[10px] text-zinc-400">{point.monthKey}</td>
                    <td className="tabular py-1 text-right text-[10px] text-zinc-200">
                      {value === null || value === undefined ? '—' : formatValue(value)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
