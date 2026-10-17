'use client';

/**
 * Per-property rollup, expandable.
 *
 * The expanded drawer links out to the property's own PMS rather than trying
 * to render a room-type grid here. That is deliberate: a room × date grid is
 * the centrepiece of a property-scoped screen (CLAUDE.md section 2), and
 * reproducing a thin version of it inside a portfolio rollup would be a second
 * implementation to keep in step with the first.
 */

import { cn } from '@repo/ui';
import type { PropertyCalendarSummary } from '@repo/types';
import { CalendarRange, ChevronDown, ExternalLink, Hotel, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { formatMoney } from '@/lib/money';

export interface PropertiesOverviewAccordionProps {
  properties: readonly PropertyCalendarSummary[];
}

export function PropertiesOverviewAccordion({
  properties,
}: PropertiesOverviewAccordionProps) {
  // A Set, not a single id: comparing two properties side by side is the whole
  // point of a portfolio view, so expanding one must not collapse another.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(propertyId: string): void {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(propertyId)) {
        next.delete(propertyId);
      } else {
        next.add(propertyId);
      }
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold text-white">Properties overview</h2>
        <p className="text-xs text-zinc-500">Click a property to view its reservations</p>
      </header>

      {properties.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.1] px-6 py-12 text-center">
          <p className="text-sm font-medium text-zinc-300">No properties in this selection.</p>
          <p className="mt-1 text-xs text-zinc-600">
            Clear the property filter to see your whole group.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {properties.map((property) => {
            const open = expanded.has(property.propertyId);
            const panelId = `property-panel-${property.propertyId}`;

            return (
              <li
                key={property.propertyId}
                className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]"
              >
                <button
                  type="button"
                  onClick={() => {
                    toggle(property.propertyId);
                  }}
                  aria-expanded={open}
                  aria-controls={panelId}
                  className="flex w-full flex-col gap-3 p-4 text-left transition-colors hover:bg-white/[0.02] lg:flex-row lg:items-center"
                >
                  {/* Identity */}
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <ChevronDown
                      className={cn(
                        'size-4 shrink-0 text-zinc-500 transition-transform duration-200',
                        open && 'rotate-180',
                      )}
                      aria-hidden="true"
                    />
                    <Hotel className="size-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-white">
                          {property.propertyName}
                        </span>
                        <span className="rounded border border-white/[0.1] bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold text-zinc-300">
                          {property.currency}
                        </span>
                        {!property.hasInventory ? (
                          <span className="inline-flex items-center gap-1 rounded border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                            <TriangleAlert className="size-2.5" aria-hidden="true" />
                            Not set up
                          </span>
                        ) : null}
                      </span>
                      <span className="tabular text-[11px] text-zinc-500">
                        ID: {property.propertyCode}
                      </span>
                    </span>
                  </span>

                  {/* Rollup metrics */}
                  <span className="grid shrink-0 grid-cols-3 gap-4 lg:gap-8">
                    <Metric
                      label="Avg. rate"
                      value={
                        property.averageRateMinor === null
                          ? '—'
                          : formatMoney(property.averageRateMinor, property.currency)
                      }
                      hint={
                        property.averageRateMinor === null
                          ? 'No room-nights sold in this window'
                          : `Across ${String(property.roomNightsSold)} room-night${property.roomNightsSold === 1 ? '' : 's'}`
                      }
                    />
                    <Metric
                      label="Avg. occupancy"
                      value={`${String(property.averageOccupancy)}%`}
                    />
                    <Metric label="Total rooms" value={String(property.totalRooms)} />
                  </span>
                </button>

                {open ? (
                  <div
                    id={panelId}
                    className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] px-4 py-3"
                  >
                    {property.hasInventory ? (
                      <>
                        <Link
                          href={`/calendar?hotelId=${encodeURIComponent(property.propertyCode)}`}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[11px] font-medium text-black transition hover:bg-zinc-200"
                        >
                          Open reservation calendar
                          <CalendarRange className="size-3" aria-hidden="true" />
                        </Link>
                        <Link
                          href={`/property-dashboard?hotelId=${encodeURIComponent(property.propertyCode)}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-zinc-200 transition hover:border-white/25"
                        >
                          Open property PMS
                          <ExternalLink className="size-3" aria-hidden="true" />
                        </Link>
                        <button
                          type="button"
                          disabled
                          title="Needs the rates module (CLAUDE.md section 2)"
                          className="cursor-not-allowed rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[11px] text-zinc-400 opacity-60"
                        >
                          Manage rates &amp; inventory
                        </button>
                      </>
                    ) : (
                      <p className="text-[11px] text-amber-200/80">
                        This property has no room types yet, so it reports no occupancy. Add room
                        types and rooms before it will appear in portfolio figures.
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <span className="flex flex-col gap-0.5" title={hint}>
      <span className="text-[9px] font-semibold tracking-wider text-zinc-600 uppercase">
        {label}
      </span>
      <span className="tabular text-sm font-semibold text-white">{value}</span>
    </span>
  );
}
