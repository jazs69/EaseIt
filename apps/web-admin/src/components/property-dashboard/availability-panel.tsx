'use client';

/**
 * Right-hand sidebar: availability by category, then operational alerts.
 *
 * The inventory numbers are colour-coded by how much of the category is left,
 * as a proportion rather than an absolute: "2 left" is calm for a 4-room suite
 * category and alarming for a 40-room one, so a fixed threshold would cry wolf
 * on small categories and stay silent on big ones.
 */

import { cn } from '@repo/ui';
import type { AvailabilityBreakdown, SystemAlert } from '@repo/types';
import { ChevronDown, ExternalLink, TriangleAlert } from 'lucide-react';

import { formatMoneyRounded } from '@/lib/money';

/** Scarcity as a share of the category, not a fixed count. */
function inventoryTone(available: number, physical: number): string {
  if (available === 0) return 'text-rose-400';
  if (physical === 0) return 'text-zinc-500';
  const share = available / physical;
  if (share <= 0.2) return 'text-rose-400';
  if (share <= 0.5) return 'text-amber-400';
  return 'text-emerald-400';
}

export interface AvailabilityPanelProps {
  availability: AvailabilityBreakdown;
  alerts: readonly SystemAlert[];
  targetDate: string;
}

export function AvailabilityPanel({
  availability,
  alerts,
  targetDate,
}: AvailabilityPanelProps) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 xl:w-80">
      {/* Availability */}
      <section className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
        <header className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Availability</h2>
          <span className="tabular text-[10px] text-zinc-500">{targetDate}</span>
        </header>

        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Rooms available by category on {targetDate}, with the base rate for each
          </caption>
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th
                scope="col"
                className="px-4 py-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Room category
              </th>
              <th
                scope="col"
                className="px-2 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                Inventory
              </th>
              <th
                scope="col"
                className="px-4 py-2 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
              >
                <span className="inline-flex items-center gap-0.5">
                  Base price
                  <ChevronDown className="size-2.5" aria-hidden="true" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {availability.rows.map((row) => (
              <tr
                key={row.roomTypeId}
                className="border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]"
              >
                <td className="max-w-[9rem] px-4 py-2">
                  <span className="block truncate text-xs text-zinc-300" title={row.name}>
                    {row.name}
                  </span>
                </td>
                <td className="px-2 py-2 text-right">
                  <span
                    className={cn(
                      'tabular text-xs font-semibold',
                      inventoryTone(row.availableCount, row.physical),
                    )}
                    title={`${row.availableCount} of ${row.physical} available · ${row.sold} sold · ${row.blocked} blocked`}
                  >
                    {row.availableCount}
                  </span>
                </td>
                <td className="tabular px-4 py-2 text-right text-xs text-zinc-400">
                  {formatMoneyRounded(row.baseRateMinor, row.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <footer className="flex items-center justify-between gap-2 border-t border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
          <span className="text-[11px] text-zinc-400">Total available rooms</span>
          <span className="tabular text-sm font-bold text-white">
            {availability.totalAvailableRooms}
            <span className="text-[11px] font-normal text-zinc-600">
              {' / '}
              {availability.totalPhysicalRooms}
            </span>
          </span>
        </footer>
      </section>

      {/* Alerts */}
      {alerts.map((alert) => (
        <section
          key={alert.id}
          className={cn(
            'flex flex-col gap-2.5 rounded-xl border p-4',
            alert.severity === 'OVERDUE'
              ? 'border-rose-500/25 bg-rose-500/[0.06]'
              : alert.severity === 'WARNING'
                ? 'border-amber-400/25 bg-amber-500/[0.05]'
                : 'border-white/[0.08] bg-white/[0.02]',
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[9px] font-bold tracking-wider uppercase',
                alert.severity === 'OVERDUE'
                  ? 'bg-rose-500/20 text-rose-300'
                  : alert.severity === 'WARNING'
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-white/10 text-zinc-300',
              )}
            >
              {alert.severity}
            </span>
            <TriangleAlert
              className={cn(
                'size-3.5',
                alert.severity === 'OVERDUE' ? 'text-rose-400' : 'text-amber-400',
              )}
              aria-hidden="true"
            />
          </div>

          <h3 className="text-sm font-semibold text-white">{alert.title}</h3>
          <p className="text-[11px] leading-relaxed text-zinc-400">{alert.body}</p>

          {alert.actionLabel !== null && alert.actionHref !== null ? (
            <a
              href={alert.actionHref}
              // External and operator-facing. `noreferrer` as well as
              // `noopener` so the destination learns nothing about the
              // internal URL the clerk came from.
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-start gap-1.5 text-[11px] font-medium text-blue-400 underline-offset-2 transition-colors hover:text-blue-300 hover:underline"
            >
              <span>{alert.actionLabel}</span>
              <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            </a>
          ) : alert.actionLabel !== null ? (
            <span className="text-[11px] text-zinc-500">{alert.actionLabel}</span>
          ) : null}
        </section>
      ))}
    </aside>
  );
}
