'use client';

/**
 * One row of the operational reservation feed.
 *
 * Four columns: room badge, guest, category and board basis, money. The
 * expander holds the actions a clerk reaches for — folio, charges, check-out —
 * which are rendered disabled until the modules that own them exist, rather
 * than omitted. A disabled control with a reason says "not yet"; a missing one
 * says "look somewhere else".
 */

import { cn } from '@repo/ui';
import {
  MEAL_PLAN_LABELS,
  RESERVATION_SUB_STATUS_LABELS,
  ReservationStatus,
  type DashboardReservation,
  type ReservationSubStatus,
} from '@repo/types';
import {
  BedDouble,
  ChevronDown,
  PersonStanding,
  Phone,
  Users,
} from 'lucide-react';
import { useState } from 'react';

import { formatMoney } from '@/lib/money';

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

/** `2026-10-07` + `12:00` -> `Oct 07, 2026 12:00 PM`. */
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

  return `${monthName} ${day}, ${year} ${String(hour12)}:${minute} ${meridiem}`;
}

const STATUS_STYLE: Record<ReservationStatus, string> = {
  CONFIRMED: 'border-sky-400/25 bg-sky-500/[0.12] text-sky-300',
  CHECKED_IN: 'border-emerald-400/25 bg-emerald-500/[0.12] text-emerald-300',
  CHECKED_OUT: 'border-zinc-400/20 bg-zinc-500/[0.12] text-zinc-300',
  CANCELLED: 'border-rose-400/25 bg-rose-500/[0.12] text-rose-300',
  NO_SHOW: 'border-zinc-500/25 bg-zinc-600/[0.15] text-zinc-400',
  ON_HOLD: 'border-slate-400/25 bg-slate-500/[0.12] text-slate-300',
  TENTATIVE: 'border-amber-400/25 bg-amber-500/[0.12] text-amber-300',
};

const STATUS_LABEL: Record<ReservationStatus, string> = {
  CONFIRMED: 'CONFIRMED',
  CHECKED_IN: 'CHECKED-IN',
  CHECKED_OUT: 'CHECKED-OUT',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO SHOW',
  ON_HOLD: 'ON HOLD',
  TENTATIVE: 'TENTATIVE',
};

const SUB_STATUS_STYLE: Record<ReservationSubStatus, string> = {
  PENDING_DEPARTURE: 'border-rose-400/30 bg-rose-500/[0.14] text-rose-300',
  ARRIVING_TODAY: 'border-amber-400/30 bg-amber-500/[0.14] text-amber-300',
  OVERSTAY: 'border-red-400/40 bg-red-500/[0.18] text-red-300',
  OVERDUE_ARRIVAL: 'border-orange-400/30 bg-orange-500/[0.14] text-orange-300',
};

/* -------------------------------------------------------------------------- */
/*  Card                                                                      */
/* -------------------------------------------------------------------------- */

export function ReservationCard({ reservation }: { reservation: DashboardReservation }) {
  const [expanded, setExpanded] = useState(false);
  const hasBalance = reservation.balanceAmountMinor > 0;

  return (
    <li className="rounded-xl border border-white/[0.08] bg-white/[0.02] transition-colors hover:border-white/[0.14]">
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:gap-5">
        {/* Room badge */}
        <div className="flex shrink-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
            <BedDouble className="size-5 text-zinc-400" aria-hidden="true" />
          </span>
          <span className="tabular text-base font-bold tracking-tight text-white lg:w-16">
            {reservation.roomNumber ?? (
              <span className="text-xs font-medium text-zinc-500">Unassigned</span>
            )}
          </span>
        </div>

        {/* Guest */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold tracking-wide text-white uppercase">
              {reservation.guestName}
            </span>
            {reservation.subStatus !== null ? (
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wider uppercase',
                  SUB_STATUS_STYLE[reservation.subStatus],
                )}
              >
                {RESERVATION_SUB_STATUS_LABELS[reservation.subStatus]}
              </span>
            ) : null}
          </div>

          {reservation.guestPhone !== null ? (
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Phone className="size-3 shrink-0" aria-hidden="true" />
              {reservation.guestPhone}
            </span>
          ) : null}

          <span className="tabular text-[11px] text-zinc-400">
            {formatStayPoint(reservation.checkInDate, reservation.checkInTime)}
            {' — '}
            {formatStayPoint(reservation.checkOutDate, reservation.checkOutTime)}
          </span>

          <span className="truncate font-mono text-[10px] text-zinc-600">
            {reservation.bookingCode}
          </span>
        </div>

        {/* Category and board basis */}
        <div className="flex shrink-0 flex-col gap-1.5 lg:w-44">
          <span className="flex items-center gap-1.5 text-xs text-zinc-300">
            <PersonStanding className="size-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
            <span className="truncate">{reservation.roomTypeName}</span>
          </span>
          <span className="flex items-center gap-2">
            <span
              className="rounded border border-white/[0.1] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300"
              title={MEAL_PLAN_LABELS[reservation.mealPlan]}
            >
              {reservation.mealPlan}
            </span>
            <span className="tabular flex items-center gap-1 text-[11px] text-zinc-500">
              <Users className="size-3" aria-hidden="true" />
              {reservation.adults} / {reservation.children}
            </span>
            <span className="tabular text-[11px] text-zinc-600">
              {reservation.nights}N
            </span>
          </span>
        </div>

        {/* Money and status */}
        <div className="flex shrink-0 items-center gap-4 lg:w-52 lg:justify-end">
          <div className="flex flex-col items-start gap-1 lg:items-end">
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wider uppercase',
                STATUS_STYLE[reservation.status],
              )}
            >
              {STATUS_LABEL[reservation.status]}
            </span>
            <span className="tabular text-sm font-bold text-white">
              {formatMoney(reservation.totalAmountMinor, reservation.currency)}
            </span>
            {hasBalance ? (
              <span className="tabular text-[11px] font-medium text-rose-400">
                Bal: {formatMoney(reservation.balanceAmountMinor, reservation.currency)}
              </span>
            ) : (
              <span className="text-[11px] text-emerald-400/80">Settled</span>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setExpanded((value) => !value);
            }}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} actions for ${reservation.guestName}`}
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/[0.08] text-zinc-500 transition-colors hover:border-white/20 hover:text-zinc-200"
          >
            <ChevronDown
              className={cn('size-4 transition-transform duration-200', expanded && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] px-4 py-3">
          {/* Rendered disabled with a reason rather than hidden: the clerk can
              see the action exists and why it is not available yet. */}
          {[
            { label: 'View folio', why: 'Needs the folios module (CLAUDE.md section 2)' },
            { label: 'Add charges', why: 'Needs the folios module (CLAUDE.md section 2)' },
            { label: 'Check out', why: 'Needs the frontdesk module (CLAUDE.md section 2)' },
            { label: 'Room move', why: 'Needs the frontdesk module (CLAUDE.md section 2)' },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              disabled
              title={action.why}
              className="cursor-not-allowed rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-zinc-400 opacity-60"
            >
              {action.label}
            </button>
          ))}
          {reservation.isMagicLinkActive ? (
            <span className="ml-auto rounded-full border border-violet-400/25 bg-violet-500/[0.1] px-2 py-0.5 text-[10px] font-medium text-violet-300">
              Magic link active
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
