'use client';

/**
 * The room × column matrix.
 *
 * ===========================================================================
 * One grid template, shared by five things.
 *
 * The header, the inventory strip, every room row, the footer and the live
 * marker all set `grid-template-columns` from the same string. That is what
 * keeps them aligned with no measurement in JavaScript — and it is what makes
 * Week view's `minmax(140px, 1fr)` possible at all. A fixed `--day-col` would
 * fill the screen only at one viewport width; `1fr` stretches to consume the
 * container and the whole stack stretches with it.
 *
 * `minmax(min, 1fr)` is doing two jobs: it never lets a column shrink below
 * readable width (so the container scrolls instead), and it shares any surplus
 * equally (so there is no dead margin on a wide screen).
 *
 * Block spans arrive from the server in *column units*, already clamped to the
 * window — half-open for dates, minute-mapped for hours. There is no date
 * arithmetic in this file at all.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import type {
  TimelineBlock,
  TimelineCalendar,
  TimelineCategory,
  TimelineColumn,
  TimelineRoom,
  TimelineTimeframe,
} from '@repo/types';
import { BrushCleaning, ChevronDown, Wrench } from 'lucide-react';
import { useState } from 'react';

import { formatMoneyRounded } from '@/lib/money';
import { CurrentTimeMarker } from './current-time-marker';

/**
 * Minimum column width per timeframe.
 *
 * Week is the spec's 140px. Month is deliberately tight — 31 columns of a
 * readable width would be 1300px of horizontal scrolling, so it trades label
 * detail (a bare date number and one weekday letter) for a month that fits.
 */
const COLUMN_MIN: Record<TimelineTimeframe, string> = {
  day: '3.75rem',
  week: '140px',
  ten_days: '104px',
  month: '42px',
};

const ROOM_COLUMN = '11.5rem';

const BLOCK_TONE: Record<TimelineBlock['colourVariant'], string> = {
  amber: 'bg-amber-500/25 border-amber-400/50 text-amber-100 hover:bg-amber-500/40',
  emerald: 'bg-emerald-500/25 border-emerald-400/50 text-emerald-100 hover:bg-emerald-500/40',
  zinc: 'bg-zinc-500/25 border-zinc-400/40 text-zinc-200 hover:bg-zinc-500/40',
  slate: 'bg-slate-500/25 border-slate-400/40 text-slate-200 hover:bg-slate-500/40',
  rose: 'bg-rose-500/25 border-rose-400/50 text-rose-100 hover:bg-rose-500/40',
};

export interface TimelineGridProps {
  /** Opens the create-reservation modal pre-filled from a clicked cell. */
  onCreateAt: (seed: {
    roomId: string;
    roomNumber: string;
    roomTypeId: string;
    arrivalDate: string;
  }) => void;
  calendar: TimelineCalendar;
  onSelectBlock: (block: TimelineBlock) => void;
}

export function TimelineGrid({ calendar, onSelectBlock, onCreateAt }: TimelineGridProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const columnCount = calendar.columns.length;
  const columnMin = COLUMN_MIN[calendar.timeframe];
  const gridTemplate = `${ROOM_COLUMN} repeat(${String(columnCount)}, minmax(${columnMin}, 1fr))`;
  const isMonth = calendar.timeframe === 'month';
  const isHourly = calendar.columnKind === 'hour';

  function toggleCategory(categoryId: string): void {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }

  const roomsById = new Map(calendar.rooms.map((room) => [room.id, room]));
  const rowProps = {
    gridTemplate,
    columnCount,
    onSelectBlock,
    columns: calendar.columns,
    onCreateAt,
  };

  return (
    /**
     * The scroll container for both axes, and the reason the header rows pin.
     *
     * `sticky` resolves against the nearest scrolling ancestor. Previously
     * that was the document, so the column headers tracked the page scroll;
     * now it is this box, so they stay put while the room rows move under
     * them — and they still travel sideways with the columns, which is what a
     * date header has to do.
     *
     * `min-h-0` lets it shrink inside the flex column rather than growing to
     * fit every room and handing the scrolling back to the page.
     */
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/[0.08] bg-[#0b0b0d]">
      {/* The content is at least as wide as its columns demand, so it scrolls
          when it has to and stretches when there is room. */}
      <div
        className="relative"
        style={{
          minWidth: `calc(${ROOM_COLUMN} + ${String(columnCount)} * ${columnMin})`,
        }}
      >
        <CurrentTimeMarker calendar={calendar} gridTemplate={gridTemplate} />

        {/*
          ---- Pinned header block ------------------------------------

          The column header and the inventory strip pin as **one unit**.

          They used to pin separately, with the strip at a hardcoded
          `top-[57px]` — the header's measured height in Week view. But the
          header is not 57px tall in every view, because the number of label
          lines differs: Week and 10-day print weekday, date and year (57px),
          Month prints a date number and one weekday letter (47px), and Day
          prints a bare `00:00` (37px). So in Day view the strip pinned 20px
          below the header and in Month view 10px below it, and room 101
          scrolled up through that gap — appearing *between* the date headers
          and the occupancy figures, which is exactly the reported defect.

          Wrapping them removes the constant instead of correcting it. A
          number that has to match a rendered height is wrong the moment a
          label line is added, and nothing in the type system would have
          caught it; a wrapper is right by construction in all four views.

          `z-20`, not higher: the live marker is z-30 and is meant to draw its
          line and time chip over these rows.
        */}
        <div className="sticky top-0 z-20">
          <div
            className="grid border-b border-white/[0.1] bg-[#0e0e11]"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div className="sticky left-0 z-10 flex items-center border-r border-white/[0.1] bg-[#0e0e11] px-3 py-2.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
              Rooms
            </div>
            {calendar.columns.map((column) => (
              <div
                key={column.key}
                className={cn(
                  'flex flex-col items-center justify-center border-r border-white/[0.06] px-0.5 py-2',
                  column.isWeekend && !isHourly && 'bg-white/[0.02]',
                  column.isToday && 'bg-rose-500/[0.07]',
                  column.startsMonth && isMonth && 'border-l border-l-white/20',
                )}
              >
                {/* Month view stacks the date number over a single weekday
                  letter; everything else reads weekday, then date, then year. */}
                {isMonth ? (
                  <>
                    <span className="tabular text-[11px] font-semibold text-zinc-200">
                      {column.primaryLabel}
                    </span>
                    <span
                      className={cn(
                        'text-[9px] font-medium',
                        column.isToday ? 'text-rose-300' : 'text-zinc-600',
                      )}
                    >
                      {column.secondaryLabel}
                    </span>
                  </>
                ) : (
                  <>
                    {column.secondaryLabel !== null ? (
                      <span
                        className={cn(
                          'text-[10px] font-semibold tracking-wide',
                          column.isToday ? 'text-rose-300' : 'text-zinc-500',
                        )}
                      >
                        {column.secondaryLabel}
                      </span>
                    ) : null}
                    <span className="tabular text-[11px] font-medium text-zinc-200">
                      {column.primaryLabel}
                    </span>
                    {column.tertiaryLabel !== null ? (
                      <span className="tabular text-[9px] text-zinc-600">
                        {column.tertiaryLabel}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* ---- Inventory strip ---------------------------------------- */}
          <div
            className="grid border-b border-white/[0.1] bg-[#101014]"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div className="sticky left-0 z-10 flex items-center border-r border-white/[0.1] bg-[#101014] px-3 py-2 text-[10px] font-semibold text-zinc-400">
              All rooms &mdash; sold / total
            </div>

            {/* Day view has 24 columns but one day of inventory, so the figure
              spans the whole strip rather than being repeated 24 times. */}
            {isHourly ? (
              <div
                className="flex items-center justify-center gap-2 border-r border-white/[0.06] px-2 py-1.5"
                style={{ gridColumn: `2 / span ${String(columnCount)}` }}
              >
                {calendar.dailySummary[0] === undefined ? null : (
                  <>
                    <span className="tabular text-[11px] font-bold text-white">
                      {calendar.dailySummary[0].sold}/{calendar.dailySummary[0].total}
                    </span>
                    <span className="tabular text-[10px] text-zinc-500">
                      {calendar.dailySummary[0].available} available on {calendar.windowStart}
                    </span>
                  </>
                )}
              </div>
            ) : (
              calendar.dailySummary.map((summary) => (
                <div
                  key={summary.date}
                  className="flex flex-col items-center justify-center border-r border-white/[0.06] px-0.5 py-1.5"
                  title={`${String(summary.sold)} sold, ${String(summary.blocked)} blocked, ${String(summary.available)} available of ${String(summary.total)}`}
                >
                  <span className="tabular text-[11px] font-bold text-white">
                    {summary.sold}/{summary.total}
                  </span>
                  {isMonth ? null : (
                    <span
                      className={cn(
                        'tabular text-[9px]',
                        summary.available === 0 ? 'text-rose-400' : 'text-zinc-500',
                      )}
                    >
                      {summary.available} avail
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ---- Rows --------------------------------------------------- */}
        {calendar.viewMode === 'by-category'
          ? calendar.categories.map((category) => (
              <CategoryGroup
                key={category.id}
                category={category}
                rooms={category.roomIds
                  .map((id) => roomsById.get(id))
                  .filter((room): room is TimelineRoom => room !== undefined)}
                collapsed={collapsed.has(category.id)}
                isHourly={isHourly}
                onToggle={() => {
                  toggleCategory(category.id);
                }}
                {...rowProps}
              />
            ))
          : calendar.rooms.map((room) => <RoomRow key={room.id} room={room} {...rowProps} />)}

        {/* ---- Available footer --------------------------------------- */}
        <div
          className="sticky bottom-0 z-20 grid border-t border-white/[0.1] bg-[#101014]"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          <div className="sticky left-0 z-10 flex items-center border-r border-white/[0.1] bg-[#101014] px-3 py-2 text-[10px] font-semibold text-zinc-400">
            Available rooms
          </div>
          {isHourly ? (
            <div
              className="flex items-center justify-center border-r border-white/[0.06] py-2"
              style={{ gridColumn: `2 / span ${String(columnCount)}` }}
            >
              <span className="tabular text-[11px] font-bold text-emerald-300">
                {calendar.dailySummary[0]?.available ?? 0}/{calendar.dailySummary[0]?.total ?? 0}
              </span>
            </div>
          ) : (
            calendar.dailySummary.map((summary) => (
              <div
                key={summary.date}
                className="flex items-center justify-center border-r border-white/[0.06] px-0.5 py-2"
              >
                <span
                  className={cn(
                    'tabular text-[11px] font-bold',
                    summary.available === 0
                      ? 'text-rose-400'
                      : summary.occupancyPercentage >= 80
                        ? 'text-amber-300'
                        : 'text-emerald-300',
                  )}
                >
                  {isMonth
                    ? summary.available
                    : `${String(summary.available)}/${String(summary.total)}`}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Category group                                                            */
/* -------------------------------------------------------------------------- */

function CategoryGroup({
  category,
  rooms,
  collapsed,
  isHourly,
  onToggle,
  gridTemplate,
  columnCount,
  onSelectBlock,
  columns,
  onCreateAt,
}: {
  category: TimelineCategory;
  rooms: readonly TimelineRoom[];
  collapsed: boolean;
  isHourly: boolean;
  onToggle: () => void;
  gridTemplate: string;
  columnCount: number;
  onSelectBlock: (block: TimelineBlock) => void;
  columns: readonly TimelineColumn[];
  onCreateAt: (seed: {
    roomId: string;
    roomNumber: string;
    roomTypeId: string;
    arrivalDate: string;
  }) => void;
}) {
  return (
    <>
      <div
        className="grid border-b border-white/[0.08] bg-white/[0.035]"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="sticky left-0 z-10 flex items-center gap-1.5 border-r border-white/[0.1] bg-[#15151a] px-2 py-2 text-left"
        >
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-zinc-500 transition-transform',
              collapsed && '-rotate-90',
            )}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[11px] font-semibold text-white">{category.name}</span>
            <span className="tabular text-[9px] text-zinc-500">
              {category.inventory} rooms &middot;{' '}
              {formatMoneyRounded(category.baseRateMinor, category.currency)}
            </span>
          </span>
        </button>

        {/* The per-category availability row only makes sense against dates. */}
        {isHourly ? (
          <div style={{ gridColumn: `2 / span ${String(columnCount)}` }} />
        ) : (
          category.dailyAvailable.map((day) => (
            <div
              key={day.date}
              className="flex items-center justify-center border-r border-white/[0.06] bg-white/[0.02] px-0.5"
              title={`${String(day.available)} of ${String(day.total)} available in ${category.name}`}
            >
              <span
                className={cn(
                  'tabular text-[10px] font-semibold',
                  day.available === 0 ? 'text-rose-400' : 'text-zinc-300',
                )}
              >
                {day.available}
              </span>
            </div>
          ))
        )}
      </div>

      {collapsed
        ? null
        : rooms.map((room) => (
            <RoomRow
              key={room.id}
              room={room}
              gridTemplate={gridTemplate}
              columnCount={columnCount}
              onSelectBlock={onSelectBlock}
              columns={columns}
              onCreateAt={onCreateAt}
            />
          ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Room row                                                                  */
/* -------------------------------------------------------------------------- */

function RoomRow({
  room,
  gridTemplate,
  columnCount,
  onSelectBlock,
  columns,
  onCreateAt,
}: {
  room: TimelineRoom;
  gridTemplate: string;
  columnCount: number;
  onSelectBlock: (block: TimelineBlock) => void;
  columns: readonly TimelineColumn[];
  onCreateAt: (seed: {
    roomId: string;
    roomNumber: string;
    roomTypeId: string;
    arrivalDate: string;
  }) => void;
}) {
  return (
    <div
      className="grid border-b border-white/[0.05]"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div
        className={cn(
          'sticky left-0 z-10 flex items-center gap-1.5 border-r border-white/[0.1] bg-[#0b0b0d] px-3 py-1.5',
          !room.isSellable && 'opacity-50',
        )}
      >
        <span className="tabular truncate text-[11px] font-semibold text-zinc-200">
          {room.roomNumber}
        </span>
        {room.needsCleaning ? (
          <span
            title={`Needs cleaning (${room.housekeepingStatus})`}
            className="inline-flex shrink-0 items-center rounded bg-pink-500/20 px-1 py-0.5"
          >
            <BrushCleaning className="size-2.5 text-pink-300" aria-hidden="true" />
            <span className="sr-only">Needs cleaning</span>
          </span>
        ) : null}
        {!room.isSellable ? (
          <span
            title="Out of order — not sellable"
            className="inline-flex shrink-0 items-center rounded bg-zinc-600/30 px-1 py-0.5"
          >
            <Wrench className="size-2.5 text-zinc-400" aria-hidden="true" />
            <span className="sr-only">Out of order</span>
          </span>
        ) : null}
      </div>

      {/* Empty cells. They carry the column separators where nothing is
          booked, and each one is the click target that opens a new booking
          pre-filled with this room and that date. Blocks render after these
          and sit over them via grid-column, so a cell under an existing stay
          is covered rather than bookable.

          A room that is out of order gets a plain div: it cannot be sold, so
          offering to sell it would be a dead end discovered only on submit. */}
      {Array.from({ length: columnCount }, (_, index) => {
        const column = columns[index];

        if (!room.isSellable || column === undefined) {
          return (
            <div
              key={index}
              className="min-h-9 border-r border-white/[0.04]"
              style={{ gridColumn: index + 2, gridRow: 1 }}
            />
          );
        }

        return (
          <button
            key={index}
            type="button"
            title={`New booking · room ${room.roomNumber} · ${column.date}`}
            aria-label={`Create a booking in room ${room.roomNumber} on ${column.date}`}
            onClick={() => {
              onCreateAt({
                roomId: room.id,
                roomNumber: room.roomNumber,
                roomTypeId: room.roomTypeId,
                arrivalDate: column.date,
              });
            }}
            className="min-h-9 border-r border-white/[0.04] transition-colors hover:bg-blue-500/[0.12]"
            style={{ gridColumn: index + 2, gridRow: 1 }}
          />
        );
      })}

      {room.blocks.map((block) => (
        <BlockCell key={block.id} block={block} onSelect={onSelectBlock} />
      ))}
    </div>
  );
}

/**
 * One reservation block.
 *
 * The grid item spans whole columns; the button inside is inset by the
 * sub-column fractions. Those insets are percentages of the *item*, so one
 * column is `100 / span` percent — which is how a 14:35 arrival renders 58% of
 * the way into the 14:00 column without anyone measuring a pixel.
 */
function BlockCell({
  block,
  onSelect,
}: {
  block: TimelineBlock;
  onSelect: (block: TimelineBlock) => void;
}) {
  const leftPercent = (block.leadFraction / block.gridSpan) * 100;
  const rightPercent = (block.trailFraction / block.gridSpan) * 100;

  /**
   * How wide the block actually renders, in column units.
   *
   * Not `gridSpan`: a one-night stay now *spans* two columns, because it runs
   * from check-in on the arrival date to check-out the next morning, but it
   * only fills about 0.9 of a column between them. Keying the meal-plan badge
   * off the span would print it on blocks far too narrow to hold it.
   */
  const widthInColumns = block.gridSpan - block.leadFraction - block.trailFraction;

  return (
    <div
      className="relative z-10 min-h-9"
      style={{
        gridColumn: `${String(block.gridStartIndex + 2)} / span ${String(block.gridSpan)}`,
        gridRow: 1,
      }}
    >
      <button
        type="button"
        onClick={() => {
          onSelect(block);
        }}
        title={[
          block.guestName,
          block.bookingCode,
          `${block.startDate} to ${block.endDate}`,
          block.hasExactTimes && block.checkedInAt !== null
            ? `arrived ${new Date(block.checkedInAt).toISOString().slice(11, 16)} UTC`
            : 'standard desk times (no recorded arrival)',
        ].join(' · ')}
        style={{ left: `${String(leftPercent)}%`, right: `${String(rightPercent)}%` }}
        className={cn(
          'absolute top-0.5 bottom-0.5 flex min-w-0 items-center gap-1 overflow-hidden rounded border px-1.5 text-left transition-colors',
          BLOCK_TONE[block.colourVariant],
          // A torn edge where the stay runs past the window, so a clamped
          // block is not mistaken for one that starts here.
          block.continuesBefore && 'border-l-dashed rounded-l-none border-l-2',
          block.continuesAfter && 'border-r-dashed rounded-r-none border-r-2',
        )}
      >
        <span className="truncate text-[10px] font-semibold">{block.guestName}</span>
        {widthInColumns > 1.4 ? (
          <span className="ml-auto shrink-0 rounded bg-black/25 px-1 text-[8px] font-bold">
            {block.mealPlan}
          </span>
        ) : null}
      </button>
    </div>
  );
}
