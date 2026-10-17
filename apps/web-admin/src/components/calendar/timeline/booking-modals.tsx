'use client';

/**
 * The three booking sheets the Create menu opens.
 *
 * ===========================================================================
 * These render the real form and **cannot submit**, on purpose.
 *
 * Creating a reservation is the write path CLAUDE.md section 3.1 governs: it
 * has to run inside one transaction that increments `inventory_day.sold` on
 * every stay date, take locks in a fixed order, and come with the
 * parallel-booking race test that proves exactly one of N concurrent requests
 * for the last room succeeds. None of that exists yet — there is no
 * `reservations` module and no test runner.
 *
 * So the alternative to a disabled form was a form that writes directly and
 * oversells. The fields are here to be reviewed; the submit button states what
 * it is waiting for. A disabled control with a reason says "not yet"; a
 * missing one says "look somewhere else".
 * ===========================================================================
 */

import type { TimelineCalendar } from '@repo/types';
import { Info, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { BookingModal } from './create-menu';

const TITLES: Record<BookingModal, { title: string; blurb: string }> = {
  walkin: {
    title: 'Walk-in booking',
    blurb: 'A guest at the desk with no prior reservation. Assigns a room immediately.',
  },
  enquiry: {
    title: 'Reservation enquiry',
    blurb: 'A lead that holds no inventory until it is confirmed.',
  },
  group: {
    title: 'Group booking',
    blurb: 'Several rooms on one reservation, with a shared folio.',
  },
};

export interface BookingModalsProps {
  modal: BookingModal | null;
  calendar: TimelineCalendar;
  onClose: () => void;
}

export function BookingModals({ modal, calendar, onClose }: BookingModalsProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (modal === null) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [modal, onClose]);

  if (modal === null) return null;

  const { title, blurb } = TITLES[modal];
  const isGroup = modal === 'group';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-white/[0.1] bg-[#0b0b0d] p-5 shadow-2xl focus:outline-none"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-white">{title}</h2>
            <p className="text-xs text-zinc-500">{blurb}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/25 bg-amber-500/[0.06] px-3 py-2.5">
          <Info className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          <p className="text-[11px] leading-relaxed text-amber-200/90">
            This form cannot be submitted yet. Creating a booking must increment the inventory
            counters inside one transaction and ship with the parallel-booking race test
            (CLAUDE.md section 3.1), and the <code>reservations</code> module does not exist.
            Writing without that would let two guests take the last room.
          </p>
        </div>

        <fieldset disabled className="flex flex-col gap-3 opacity-70">
          <Field label="Guest name" placeholder="e.g. Shivam Rao" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone" placeholder="+91 ..." />
            <Field label="Email" placeholder="guest@example.com" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Arrival" type="date" defaultValue={calendar.windowStart} />
            <Field label="Departure" type="date" defaultValue={calendar.windowEnd} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Room category"
              options={calendar.categories.map((category) => category.name)}
            />
            <Select label="Board basis" options={['EP', 'CP', 'MAP', 'AP']} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Adults" type="number" defaultValue="2" />
            <Field label="Children" type="number" defaultValue="0" />
            <Field
              label={isGroup ? 'Rooms' : 'Nights'}
              type="number"
              defaultValue={isGroup ? '3' : '2'}
            />
          </div>
        </fieldset>

        <footer className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/[0.1] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/25 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled
            title="Needs the reservations module and its race test (CLAUDE.md sections 3.1 and 6.3)"
            className="cursor-not-allowed rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black opacity-40"
          >
            {isGroup ? 'Create group booking' : 'Create booking'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  placeholder,
  type = 'text',
  defaultValue,
}: {
  label: string;
  placeholder?: string;
  type?: string;
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        {label}
      </span>
      <input
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-white placeholder:text-zinc-600 disabled:cursor-not-allowed"
      />
    </label>
  );
}

function Select({ label, options }: { label: string; options: readonly string[] }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        {label}
      </span>
      <select className="rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-white disabled:cursor-not-allowed">
        {options.map((option) => (
          <option key={option} className="bg-zinc-900">
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
