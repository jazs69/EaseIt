import { cn } from '@repo/ui';
import { BedDouble, Bot, Check, KeyRound, MessageSquare, Sparkles, Zap } from 'lucide-react';

import { AmbientGlow } from './primitives';

/* -------------------------------------------------------------------------- */
/*  Model                                                                     */
/* -------------------------------------------------------------------------- */

export type StayStatus = 'checked-in' | 'reserved' | 'housekeeping' | 'out-of-order';

export interface Stay {
  id: string;
  guest: string;
  status: StayStatus;
  /** 1-based column index of the arrival night. */
  start: number;
  /** Length of stay in nights. Half-open: a 2-night stay spans 2 columns. */
  nights: number;
}

export interface RoomRow {
  room: string;
  type: string;
  stays: readonly Stay[];
}

const DAYS: readonly string[] = [
  'Mon 13',
  'Tue 14',
  'Wed 15',
  'Thu 16',
  'Fri 17',
  'Sat 18',
  'Sun 19',
];
const NIGHTS = DAYS.length;

const STATUS_STYLES: Record<StayStatus, { bar: string; label: string }> = {
  'checked-in': {
    bar: 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200',
    label: 'Checked In',
  },
  reserved: {
    bar: 'border-blue-400/30 bg-blue-500/15 text-blue-200',
    label: 'Reserved',
  },
  housekeeping: {
    bar: 'border-amber-400/30 bg-amber-500/15 text-amber-200',
    label: 'Housekeeping',
  },
  'out-of-order': {
    bar: 'border-rose-400/30 bg-rose-500/15 text-rose-200',
    label: 'Out of Order',
  },
};

const ROWS: readonly RoomRow[] = [
  {
    room: '101',
    type: 'Standard',
    stays: [
      { id: 's1', guest: 'Mehta', status: 'checked-in', start: 1, nights: 3 },
      { id: 's2', guest: 'Fernandes', status: 'reserved', start: 5, nights: 2 },
    ],
  },
  {
    room: '102',
    type: 'Standard',
    stays: [
      { id: 's3', guest: 'Turndown', status: 'housekeeping', start: 1, nights: 1 },
      { id: 's4', guest: 'Iyer', status: 'reserved', start: 3, nights: 4 },
    ],
  },
  {
    room: '201',
    type: 'Deluxe',
    stays: [{ id: 's5', guest: 'Kapoor', status: 'checked-in', start: 1, nights: 5 }],
  },
  {
    room: '203',
    type: 'Deluxe',
    stays: [
      { id: 's6', guest: 'Singh', status: 'reserved', start: 1, nights: 2 },
      { id: 's7', guest: 'AC repair', status: 'out-of-order', start: 4, nights: 2 },
    ],
  },
  {
    room: '304',
    type: 'Deluxe King',
    stays: [{ id: 's8', guest: 'Jayesh', status: 'checked-in', start: 2, nights: 4 }],
  },
  {
    room: '305',
    type: 'Suite',
    stays: [{ id: 's9', guest: "D'Souza", status: 'reserved', start: 6, nights: 2 }],
  },
];

/* -------------------------------------------------------------------------- */
/*  Window chrome                                                             */
/* -------------------------------------------------------------------------- */

function WindowBar() {
  return (
    <div className="flex items-center gap-3 border-b border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
      </div>
      <span className="ml-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] font-medium text-zinc-400">
        Reservation Calendar
      </span>
      <span className="ml-auto hidden items-center gap-2 text-[11px] text-zinc-500 sm:flex">
        <span className="tabular">Business date 2026-10-15</span>
        <span className="text-zinc-700">/</span>
        <span className="text-zinc-400">Grand Marine Goa</span>
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Timeline                                                                  */
/* -------------------------------------------------------------------------- */

function TimelineRow({ row }: { row: RoomRow }) {
  return (
    <div className="flex items-stretch border-b border-white/[0.05] last:border-b-0">
      <div className="w-20 shrink-0 border-r border-white/[0.05] px-3 py-2.5 sm:w-28">
        <div className="tabular text-xs font-semibold text-white">{row.room}</div>
        <div className="truncate text-[10px] text-zinc-500">{row.type}</div>
      </div>

      {/* Track. Bars are absolutely positioned as a percentage of the week so
          the grid stays fluid from 375px up without a JS measure pass. */}
      <div className="relative h-12 flex-1">
        <div className="absolute inset-0 flex" aria-hidden="true">
          {DAYS.map((day) => (
            <div key={day} className="flex-1 border-r border-white/[0.04] last:border-r-0" />
          ))}
        </div>

        {row.stays.map((stay) => (
          <div
            key={stay.id}
            className={cn(
              'absolute top-1/2 flex h-8 -translate-y-1/2 items-center overflow-hidden rounded-md border px-2',
              STATUS_STYLES[stay.status].bar,
            )}
            style={{
              left: `calc(${String(((stay.start - 1) / NIGHTS) * 100)}% + 3px)`,
              width: `calc(${String((stay.nights / NIGHTS) * 100)}% - 6px)`,
            }}
          >
            <span className="truncate text-[11px] font-medium">{stay.guest}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  const shown: readonly StayStatus[] = ['checked-in', 'reserved', 'housekeeping'];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.08] px-4 py-3">
      {shown.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
          <span
            className={cn('size-2 rounded-full border', STATUS_STYLES[status].bar)}
            aria-hidden="true"
          />
          {STATUS_STYLES[status].label}
        </span>
      ))}
      <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-zinc-500 sm:inline-flex">
        <BedDouble className="size-3.5" aria-hidden="true" />
        <span className="tabular">84% occupancy</span>
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  AI agent overlay                                                          */
/* -------------------------------------------------------------------------- */

interface AgentStep {
  label: string;
}

const AGENT_STEPS: readonly AgentStep[] = [
  { label: 'Checked availability — Deluxe King, 4 nights' },
  { label: 'Verified rate parity and folio balance' },
  { label: 'Allocated Room 304' },
];

function AgentCard() {
  return (
    <div className="w-full overflow-hidden rounded-xl border border-white/[0.12] bg-zinc-950/80 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.9)] backdrop-blur-xl lg:w-80">
      <div className="flex items-center gap-2.5 border-b border-white/[0.08] px-4 py-3">
        <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-sky-400 to-indigo-600">
          <Bot className="size-4 text-white" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-white">EaseIt AI — Guest Agent</div>
          <div className="flex items-center gap-1 text-[10px] text-zinc-500">
            <MessageSquare className="size-2.5" aria-hidden="true" />
            WhatsApp
          </div>
        </div>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          Live
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="max-w-[85%] self-start rounded-2xl rounded-bl-sm border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[11px] leading-relaxed text-zinc-200">
          Any chance of an upgrade for tonight?
          <span className="mt-1 block text-[10px] text-zinc-500">Jayesh · Res #GM-10428</span>
        </div>

        <ul className="flex flex-col gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          {AGENT_STEPS.map((step) => (
            <li key={step.label} className="flex items-start gap-2 text-[10px] text-zinc-400">
              <Check className="mt-0.5 size-3 shrink-0 text-emerald-400" aria-hidden="true" />
              <span>{step.label}</span>
            </li>
          ))}
        </ul>

        <div className="max-w-[90%] self-end rounded-2xl rounded-br-sm border border-blue-400/20 bg-blue-500/15 px-3 py-2 text-[11px] leading-relaxed text-blue-50">
          You&apos;re upgraded to Room 304, a Deluxe King. Your digital key is on its way.
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-[10px] text-zinc-500">
        <Zap className="size-3 text-blue-400" aria-hidden="true" />
        <span className="tabular">Resolved in 1.8s</span>
        <span className="text-zinc-700">·</span>
        <span>no front-desk action</span>
        <KeyRound className="ml-auto size-3" aria-hidden="true" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section                                                                   */
/* -------------------------------------------------------------------------- */

export function PmsShowcase() {
  return (
    <section id="demo" className="relative isolate px-4 pb-20 sm:px-6 lg:px-8">
      <AmbientGlow at="50% 30%" rgb="59 130 246" opacity={0.18} />

      <div className="mx-auto max-w-6xl">
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-zinc-900/60 to-zinc-950/90 backdrop-blur-md">
          <WindowBar />

          <div className="relative">
            {/* Day header */}
            <div className="flex border-b border-white/[0.08] bg-white/[0.01]">
              <div className="w-20 shrink-0 border-r border-white/[0.05] px-3 py-2 text-[10px] font-medium tracking-wider text-zinc-500 uppercase sm:w-28">
                Room
              </div>
              <div className="flex flex-1">
                {DAYS.map((day) => (
                  <div
                    key={day}
                    className="tabular flex-1 border-r border-white/[0.04] px-1 py-2 text-center text-[10px] text-zinc-500 last:border-r-0"
                  >
                    {day}
                  </div>
                ))}
              </div>
            </div>

            {ROWS.map((row) => (
              <TimelineRow key={row.room} row={row} />
            ))}

            <Legend />

            {/* Desktop: the agent card floats over the grid. Mobile: it stacks
                below, because overlaying it would hide the calendar entirely. */}
            <div className="pointer-events-none absolute right-5 bottom-5 hidden lg:block">
              <div className="pointer-events-auto">
                <AgentCard />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 lg:hidden">
          <AgentCard />
        </div>

        <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-zinc-500">
          <Sparkles className="size-3.5 shrink-0 text-blue-400" aria-hidden="true" />
          Every allocation above is written inside one transaction — the database rejects a double
          booking rather than trusting the app layer.
        </p>
      </div>
    </section>
  );
}
