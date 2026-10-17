'use client';

/**
 * Reservation detail drawer, opened by clicking a block.
 *
 * Closes on Escape and on a backdrop click, and moves focus to the panel when
 * it opens — a drawer that traps nothing and announces nothing is a dead end
 * for anyone not using a mouse.
 */

import { cn } from '@repo/ui';
import {
  MEAL_PLAN_LABELS,
  RESERVATION_SUB_STATUS_LABELS,
  type TimelineBlock,
} from '@repo/types';
import { KeyRound, Mail, Phone, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { formatMoney } from '@/lib/money';

/** `2026-10-16` + `12:00` -> `Oct 16, 2026 · 12:00 PM`. */
function formatStayPoint(isoDate: string, wallClock: string): string {
  const [year = '', month = '01', day = '01'] = isoDate.split('-');
  const monthName =
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      Number(month) - 1
    ] ?? month;
  const [hourText = '0', minute = '00'] = wallClock.split(':');
  const hour24 = Number(hourText);
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${monthName} ${day}, ${year} · ${String(hour12)}:${minute} ${meridiem}`;
}

export interface ReservationDrawerProps {
  block: TimelineBlock | null;
  roomNumber: string | null;
  onClose: () => void;
  /** Opens the check-in sheet for this stay. */
  onCheckIn: (reservationId: string) => void;
}

export function ReservationDrawer({
  block,
  roomNumber,
  onClose,
  onCheckIn,
}: ReservationDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape to close. A document listener is correct here: the drawer is modal,
  // so it should respond wherever focus happens to be.
  useEffect(() => {
    if (block === null) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [block, onClose]);

  if (block === null) return null;

  const hasBalance = block.balanceAmountMinor > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close reservation details"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Reservation for ${block.guestName}`}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-md flex-col gap-5 overflow-y-auto border-l border-white/[0.1] bg-[#0b0b0d] p-5 shadow-2xl focus:outline-none"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-lg font-semibold text-white">{block.guestName}</h2>
            <span className="truncate font-mono text-[10px] text-zinc-600">
              {block.bookingCode}
            </span>
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

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10px] font-bold tracking-wider text-zinc-200 uppercase">
            {block.status.replace(/_/g, ' ')}
          </span>
          {block.subStatus !== null ? (
            <span className="rounded border border-rose-400/30 bg-rose-500/[0.14] px-2 py-0.5 text-[10px] font-bold tracking-wider text-rose-300 uppercase">
              {RESERVATION_SUB_STATUS_LABELS[block.subStatus]}
            </span>
          ) : null}
          {block.isMagicLinkActive ? (
            <span className="rounded-full border border-violet-400/25 bg-violet-500/[0.1] px-2 py-0.5 text-[10px] font-medium text-violet-300">
              Magic link active
            </span>
          ) : null}
        </div>

        {/* Money. The balance is derived from total minus paid by the API, so
            there is no third figure here that can disagree with the two above
            it (CLAUDE.md section 3.4). */}
        <section className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
          <h3 className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Folio
          </h3>
          <Row label="Total" value={formatMoney(block.totalAmountMinor, block.currency)} bold />
          <Row label="Paid" value={formatMoney(block.paidAmountMinor, block.currency)} />
          <Row
            label="Balance"
            value={formatMoney(block.balanceAmountMinor, block.currency)}
            tone={hasBalance ? 'text-rose-400' : 'text-emerald-400'}
            bold
          />
        </section>

        <section className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
          <h3 className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Stay
          </h3>
          <Row label="Room" value={roomNumber ?? 'Not assigned'} />
          <Row label="Check in" value={formatStayPoint(block.startDate, block.checkInTime)} />
          <Row label="Check out" value={formatStayPoint(block.endDate, block.checkOutTime)} />
          <Row label="Nights" value={String(block.nights)} />
          <Row
            label="Board"
            value={`${block.mealPlan} — ${MEAL_PLAN_LABELS[block.mealPlan]}`}
          />
          <Row label="Occupancy" value={`${String(block.adults)} adults, ${String(block.children)} children`} />
        </section>

        <section className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
          <h3 className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Guest
          </h3>
          {block.guestPhone !== null ? (
            <a
              href={`tel:${block.guestPhone.replace(/\s/g, '')}`}
              className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300"
            >
              <Phone className="size-3.5" aria-hidden="true" />
              {block.guestPhone}
            </a>
          ) : (
            <span className="text-xs text-zinc-600">No phone on file</span>
          )}
          {block.guestEmail !== null ? (
            <a
              href={`mailto:${block.guestEmail}`}
              className="flex items-center gap-2 truncate text-xs text-blue-400 hover:text-blue-300"
            >
              <Mail className="size-3.5 shrink-0" aria-hidden="true" />
              {block.guestEmail}
            </a>
          ) : (
            <span className="text-xs text-zinc-600">No email on file</span>
          )}
        </section>

        <div className="mt-auto flex flex-wrap gap-2 border-t border-white/[0.06] pt-4">
          {/* The one live action. Enabled only for a CONFIRMED stay, because
              the rest of the statuses are refused by the server anyway and a
              button that always fails teaches a clerk to distrust the screen.
              The blockers the server knows about — a dirty room, a missing
              ID — are shown inside the sheet rather than disabling this, since
              every one of them is fixable from in there. */}
          {block.status === 'CONFIRMED' ? (
            <button
              type="button"
              onClick={() => {
                onCheckIn(block.id);
              }}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-emerald-950 transition hover:bg-emerald-400"
            >
              <KeyRound className="size-3.5" aria-hidden="true" />
              Check in
            </button>
          ) : null}
          {[
            { label: 'Check out', why: 'Needs the frontdesk module' },
            { label: 'Add charge', why: 'Needs the folios module' },
            { label: 'Move room', why: 'Needs the frontdesk module' },
            { label: 'Cancel', why: 'Needs the reservations module' },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              disabled
              title={`${action.why} (CLAUDE.md section 2)`}
              className="cursor-not-allowed rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[11px] text-zinc-400 opacity-60"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  bold = false,
}: {
  label: string;
  value: string;
  tone?: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-zinc-500">{label}</span>
      <span
        className={cn(
          'tabular truncate text-right text-xs',
          bold ? 'font-semibold' : 'font-normal',
          tone ?? 'text-zinc-200',
        )}
      >
        {value}
      </span>
    </div>
  );
}
