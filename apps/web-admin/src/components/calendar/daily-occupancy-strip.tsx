import { cn } from '@repo/ui';
import type { DailyOccupancyItem } from '@repo/types';

/**
 * One card per day in the window.
 *
 * `isToday` comes from the server, decided against the reference property's own
 * business date — not from comparing against the browser's clock, which would
 * highlight the wrong card for anyone viewing a portfolio from another zone.
 */
export interface DailyOccupancyStripProps {
  dailyOccupancy: readonly DailyOccupancyItem[];
}

/** Occupancy bands. Low is not an error, so it is not red. */
function fillTone(percentage: number, isToday: boolean): string {
  if (isToday) return 'bg-emerald-400';
  if (percentage >= 80) return 'bg-emerald-500';
  if (percentage >= 50) return 'bg-sky-500';
  if (percentage > 0) return 'bg-amber-500';
  return 'bg-zinc-700';
}

export function DailyOccupancyStrip({ dailyOccupancy }: DailyOccupancyStripProps) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold text-white">Daily occupancy</h2>
        <p className="text-xs text-zinc-500">Overall occupancy across all properties</p>
      </header>

      <ul
        className={cn(
          'grid gap-2',
          // Never more than 7 across: a 31-day window wraps instead of
          // producing 31 unreadable slivers.
          'grid-cols-2 sm:grid-cols-4 lg:grid-cols-7',
        )}
      >
        {dailyOccupancy.map((day) => (
          <li
            key={day.date}
            className={cn(
              'flex flex-col gap-2 rounded-xl p-3',
              day.isToday
                ? 'border border-white/20 bg-zinc-950 shadow-lg'
                : 'border border-white/[0.08] bg-white/[0.02]',
            )}
          >
            <div className="flex items-start justify-between gap-1">
              <div className="flex flex-col">
                <span
                  className={cn(
                    'text-[10px] font-bold tracking-wider',
                    day.isToday ? 'text-emerald-400' : 'text-zinc-500',
                  )}
                >
                  {day.dayOfWeek}
                </span>
                <span className="tabular text-xs font-medium text-zinc-300">
                  {day.formattedDate}
                </span>
              </div>
              {day.isToday ? (
                <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[8px] font-bold tracking-wider text-emerald-300 uppercase">
                  Today
                </span>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-[10px] text-zinc-500">Occupancy</span>
                <span className="tabular text-sm font-bold text-white">
                  {day.occupancyPercentage}%
                </span>
              </div>

              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
                role="img"
                aria-label={`${String(day.occupancyPercentage)}% occupied: ${String(day.soldRooms)} of ${String(day.totalRooms)} rooms`}
              >
                <div
                  className={cn('h-full rounded-full transition-all', fillTone(day.occupancyPercentage, day.isToday))}
                  // A floor of 2% when anything is sold, so a single room in a
                  // 100-room property is still a visible sliver rather than
                  // nothing at all.
                  style={{
                    width: `${String(
                      day.occupancyPercentage > 0 ? Math.max(2, day.occupancyPercentage) : 0,
                    )}%`,
                  }}
                />
              </div>

              <span className="tabular text-[10px] text-zinc-600">
                {day.soldRooms} / {day.totalRooms} rooms
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
