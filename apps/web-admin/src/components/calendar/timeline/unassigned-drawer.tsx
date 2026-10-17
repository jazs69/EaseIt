'use client';

/**
 * Bookings in this window with no room assigned, as a right slide-over.
 *
 * ===========================================================================
 * A drawer the clerk opens, not a banner that sits above the grid.
 *
 * This replaces a persistent amber strip. The strip was defensible — an
 * unassigned arrival is invisible on a room × date matrix, because every row
 * of that matrix *is* a room — but it occupied a permanent band of vertical
 * space on the one screen where vertical space is rooms you can see, and it
 * did so even when the count was zero.
 *
 * The count does not disappear with it: the `UA (n)` pill stays in the toolbar
 * with its red dot, so the information is always on screen and the *list* is
 * one click away. That is the trade — always-visible count, on-demand detail.
 *
 * Each card carries what assigning a room actually requires: who, which
 * booking, which nights, and which category the stay was sold as. The category
 * name is resolved from the payload's own `categories` list rather than
 * denormalised onto the block, so it cannot drift from the names the grid is
 * drawn with.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import type { TimelineBlock, TimelineCategory } from '@repo/types';
import { BedDouble, TriangleAlert, X } from 'lucide-react';
import { useEffect } from 'react';

import { formatMoney } from '@/lib/money';

export interface UnassignedDrawerProps {
  open: boolean;
  blocks: readonly TimelineBlock[];
  categories: readonly TimelineCategory[];
  onClose: () => void;
  /** Opens the reservation drawer for a booking, where assignment will live. */
  onSelectBlock: (block: TimelineBlock) => void;
}

export function UnassignedDrawer({
  open,
  blocks,
  categories,
  onClose,
  onSelectBlock,
}: UnassignedDrawerProps) {
  // Escape closes it. Subscribing to a browser event is what effects are for,
  // and the listener is torn down with the drawer rather than leaking.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const categoryName = (roomTypeId: string): string =>
    categories.find((category) => category.id === roomTypeId)?.name ?? 'Unknown category';

  return (
    <>
      {/* Outside click. A real overlay rather than a document listener: it also
          dims the grid, which is what tells you the drawer is modal. */}
      <button
        type="button"
        aria-label="Close unassigned bookings"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-black/50"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="unassigned-drawer-title"
        className={cn(
          'fixed top-0 right-0 z-50 flex h-full w-full max-w-sm flex-col',
          'border-l border-white/[0.1] bg-[#0b0b0d] shadow-2xl',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.08] px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <h2
              id="unassigned-drawer-title"
              className="flex items-center gap-1.5 text-sm font-semibold text-white"
            >
              <TriangleAlert className="size-4 text-amber-400" aria-hidden="true" />
              Unassigned bookings
            </h2>
            <p className="text-[11px] text-zinc-500">
              {blocks.length === 0
                ? 'Every booking in this window has a room'
                : `${String(blocks.length)} booking${blocks.length === 1 ? '' : 's'} in this window need a room`}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          {blocks.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-zinc-500">
              Nothing to assign. This list fills when a booking arrives without a room
              number — an OTA reservation, or a walk-in taken before a room was picked.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {blocks.map((block) => (
                <li
                  key={block.id}
                  className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-xs font-semibold text-white">
                        {block.guestName}
                      </span>
                      <span className="tabular text-[10px] text-zinc-500">
                        {block.bookingCode}
                      </span>
                    </div>
                    <span className="tabular shrink-0 text-[11px] font-semibold text-zinc-200">
                      {formatMoney(block.totalAmountMinor, block.currency)}
                    </span>
                  </div>

                  <dl className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-[10px] text-zinc-600">Stay</dt>
                      <dd className="tabular text-[10px] text-zinc-300">
                        {block.startDate} &rarr; {block.endDate} &middot; {block.nights}{' '}
                        night{block.nights === 1 ? '' : 's'}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-[10px] text-zinc-600">Category required</dt>
                      <dd className="flex min-w-0 items-center gap-1 text-[10px] text-zinc-300">
                        <BedDouble className="size-3 shrink-0 text-zinc-600" aria-hidden="true" />
                        <span className="truncate">{categoryName(block.roomTypeId)}</span>
                      </dd>
                    </div>
                  </dl>

                  {/* Opens the reservation drawer, which is where assignment
                      will live once the `frontdesk` module can write it. The
                      button does not pretend to assign a room on its own: a
                      room move is a transactional write guarded by the
                      exclusion constraint (CLAUDE.md section 3.1), not
                      something a list item can fire off. */}
                  <button
                    type="button"
                    onClick={() => {
                      onSelectBlock(block);
                      onClose();
                    }}
                    className="w-full rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-semibold text-black transition hover:bg-zinc-200"
                  >
                    Assign room
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
