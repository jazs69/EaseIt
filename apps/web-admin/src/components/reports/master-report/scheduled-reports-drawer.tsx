'use client';

/**
 * Scheduled report delivery.
 *
 * ===========================================================================
 * Deliberately empty, and it says why.
 *
 * A scheduled report needs three things this repository does not have: a table
 * to hold the schedules, the BullMQ worker that would run them on each
 * property's own timezone, and the mailer wiring to deliver the result. The
 * queue infrastructure is specified in CLAUDE.md section 2 and is not built.
 *
 * The alternative — a drawer with a "New schedule" form that writes nowhere —
 * is worse than this. An operator who sets up a 7am daily delivery and never
 * questions it again will not discover for weeks that nothing was ever sent,
 * and the one thing a report screen cannot afford is to be quietly
 * untrustworthy.
 *
 * So the control exists, opens, and states the position. When the queue lands,
 * this file is where the list goes.
 * ===========================================================================
 */

import { useEffect, useRef } from 'react';
import { CalendarClock, X } from 'lucide-react';

export function ScheduledReportsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Capture phase with propagation stopped, so one Escape closes this
        // drawer and not also whatever popover sits behind it — the same
        // hazard the action menus hit.
        event.stopImmediatePropagation();
        onClose();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close scheduled reports"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduled-reports-title"
        className="relative flex h-full w-full max-w-md flex-col border-l border-white/[0.08] bg-zinc-950"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
          <div>
            <h2
              id="scheduled-reports-title"
              className="flex items-center gap-2 text-sm font-semibold text-white"
            >
              <CalendarClock className="size-4 text-zinc-400" aria-hidden="true" />
              Scheduled reports
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Automated delivery of this report on a timetable.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3">
            <p className="text-xs leading-relaxed text-amber-200/90">
              No schedules, because scheduling is not built.
            </p>
          </div>

          <div className="mt-4 space-y-3 text-xs leading-relaxed text-zinc-400">
            <p>Delivering a report on a timetable needs three pieces that do not exist yet:</p>
            <ul className="space-y-2">
              <li className="flex gap-2">
                <span className="text-zinc-600">1.</span>
                <span>
                  <span className="text-zinc-200">A table to hold the schedules</span> — who
                  receives what, how often, and with which filters.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-zinc-600">2.</span>
                <span>
                  <span className="text-zinc-200">A job runner</span> — each property
                  schedules in its own timezone, so ten properties means ten independent
                  timetables, and one failing must not block another.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-zinc-600">3.</span>
                <span>
                  <span className="text-zinc-200">Delivery</span> — a report containing guest
                  names going out by email needs the same care as any other record with
                  personal data in it.
                </span>
              </li>
            </ul>
            <p>
              A form that wrote nowhere would be worse than this panel: somebody would set a
              7am delivery and not discover for weeks that nothing was ever sent. Until then,
              Export produces the same figures on demand.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
