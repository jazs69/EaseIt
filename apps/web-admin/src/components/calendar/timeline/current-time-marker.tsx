'use client';

/**
 * The live red "now" line.
 *
 * ===========================================================================
 * Positioned by CSS grid, not by measuring pixels.
 *
 * The marker is an overlay that reuses the grid's own
 * `grid-template-columns`, placing itself in today's column and offsetting
 * inside it by a percentage. That is what lets it stay correct in Week view,
 * where columns are `minmax(140px, 1fr)` and therefore have no width the
 * client can know — a `left: index * columnWidth` calculation would need the
 * measured width and would drift on every resize, zoom and font change.
 *
 * Offsets, both reducing to a fraction of one column:
 *
 *   Hour columns (Day view): a column is 60 minutes, so the line sits at
 *     (minutes % 60) / 60 across the current hour's column.
 *   Day columns (Week / 10-day / Month): a column is 1440 minutes, so the
 *     line sits at minutes / 1440 across today's column.
 *
 * Renders nothing when the property's current date is outside the window, and
 * nothing before hydration (the tick is null on the server).
 *
 * Both halves read the property's own timezone, never the browser's: the
 * column comes from `todayIndex`, which the server derived from the property's
 * IANA zone, and the offset from `minutesPastMidnightAt` in that same zone. A
 * clerk whose laptop is set to another timezone still sees the line where the
 * hotel's clock puts it.
 * ===========================================================================
 */

import type { TimelineCalendar } from '@repo/types';

import { minutesPastMidnightAt, useMinuteTick } from './use-minute-tick';

export interface CurrentTimeMarkerProps {
  calendar: TimelineCalendar;
  /** The same grid template the header and rows use. */
  gridTemplate: string;
}

export function CurrentTimeMarker({ calendar, gridTemplate }: CurrentTimeMarkerProps) {
  const tick = useMinuteTick();

  // Today is off-screen, or we are still on the server pass.
  if (calendar.todayIndex < 0 || tick === null) return null;

  const minutes = minutesPastMidnightAt(tick, calendar.property.timezone);

  // Which column the line falls in, and how far across it.
  const { columnIndex, fraction } =
    calendar.columnKind === 'hour'
      ? { columnIndex: Math.floor(minutes / 60), fraction: (minutes % 60) / 60 }
      : { columnIndex: calendar.todayIndex, fraction: minutes / 1440 };

  if (columnIndex < 0 || columnIndex >= calendar.columns.length) return null;

  const label = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
    minutes % 60,
  ).padStart(2, '0')}`;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 grid"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {/* +2 skips the sticky room-label column. The cell is only a positioning
          context; the line inside it carries the intra-column offset. */}
      <div
        className="relative"
        style={{ gridColumn: columnIndex + 2, gridRow: 1 }}
      >
        <span
          className="absolute top-0 bottom-0 w-[1.5px] bg-red-500"
          style={{ left: `${String(fraction * 100)}%` }}
        >
          <span className="absolute -top-0.5 -left-[3px] size-2 rounded-full bg-red-500" />
          <span className="absolute -top-5 left-1 rounded bg-red-500 px-1 py-px text-[9px] font-bold whitespace-nowrap text-white">
            {label}
          </span>
        </span>
      </div>
    </div>
  );
}
