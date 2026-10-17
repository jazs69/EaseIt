import { cn } from '@repo/ui';
import {
  Check,
  CreditCard,
  type LucideIcon,
  MoonStar,
  RefreshCw,
  Smartphone,
  TrendingUp,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { GlassPanel, SectionHeading } from './primitives';

/* -------------------------------------------------------------------------- */
/*  Card shell                                                                */
/* -------------------------------------------------------------------------- */

export interface BentoCardProps {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  className?: string;
  children?: ReactNode;
}

function BentoCard({
  icon: Icon,
  eyebrow,
  title,
  description,
  className,
  children,
}: BentoCardProps) {
  return (
    <GlassPanel interactive className={cn('flex flex-col gap-4 p-6', className)}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.03]">
          <Icon className="size-4 text-blue-400" aria-hidden="true" />
        </span>
        <span className="text-[10px] font-semibold tracking-[0.18em] text-zinc-500 uppercase">
          {eyebrow}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold tracking-tight text-white">{title}</h3>
        <p className="text-sm leading-relaxed text-zinc-400">{description}</p>
      </div>

      {children ? <div className="mt-auto pt-2">{children}</div> : null}
    </GlassPanel>
  );
}

/* -------------------------------------------------------------------------- */
/*  Inline visuals                                                            */
/* -------------------------------------------------------------------------- */

const AUDIT_STEPS: readonly string[] = [
  'Validate open cashier shifts',
  'Roll unarrived bookings to no-show',
  'Post room charges and taxes',
  'Settle zero-balance folios',
  'Snapshot occupancy, ADR, RevPAR',
  'Advance the business date',
];

function NightAuditVisual() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
          Run 2026-10-14
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          <Check className="size-2.5" aria-hidden="true" />
          Closed in 41s
        </span>
      </div>
      <ol className="flex flex-col gap-2">
        {AUDIT_STEPS.map((step, index) => (
          <li key={step} className="flex items-center gap-2.5">
            <span className="tabular grid size-4 shrink-0 place-items-center rounded-full border border-white/[0.1] bg-white/[0.04] text-[9px] text-zinc-400">
              {index + 1}
            </span>
            <span className="flex-1 truncate text-[11px] text-zinc-400">{step}</span>
            <span
              className="h-1 w-10 shrink-0 rounded-full bg-gradient-to-r from-emerald-500/60 to-emerald-400/20"
              aria-hidden="true"
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

function ChannelVisual() {
  const channels: readonly { name: string; ms: string }[] = [
    { name: 'Booking.com', ms: '220ms' },
    { name: 'Expedia', ms: '310ms' },
    { name: 'Agoda', ms: '265ms' },
    { name: 'Airbnb', ms: '402ms' },
  ];
  return (
    <ul className="flex flex-col gap-1.5">
      {channels.map((channel) => (
        <li
          key={channel.name}
          className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
        >
          <RefreshCw className="size-3 shrink-0 text-blue-400" aria-hidden="true" />
          <span className="flex-1 truncate text-[11px] text-zinc-300">{channel.name}</span>
          <span className="tabular text-[10px] text-emerald-300">{channel.ms}</span>
        </li>
      ))}
    </ul>
  );
}

function CommissionVisual() {
  return (
    <div className="flex items-end gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">OTA commission</span>
        <span className="tabular text-xl font-semibold text-zinc-500 line-through decoration-rose-400/60">
          22%
        </span>
      </div>
      <TrendingUp className="mb-1 size-4 shrink-0 text-emerald-400" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">Direct</span>
        <span className="tabular bg-gradient-to-r from-sky-300 to-indigo-400 bg-clip-text text-xl font-semibold text-transparent">
          0%
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section                                                                   */
/* -------------------------------------------------------------------------- */

export function FeatureBento() {
  return (
    <section id="agents" className="relative px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-12">
        <SectionHeading
          eyebrow="AI Agents"
          title="Meet the agents running your back office"
          description="Four autonomous workers that close the books, hold rate parity across every channel, and move guests through check-in without a queue."
        />

        {/* 6-column bento: 4+2 on the first row, 3+3 on the second. Collapses
            to a single column below lg. */}
        <div className="grid gap-4 lg:grid-cols-6">
          <BentoCard
            icon={MoonStar}
            eyebrow="Agent 01"
            title="Autonomous Night Audit"
            description="A deterministic, resumable background job per property, scheduled in that hotel's own timezone. Each step commits independently, so an interrupted run resumes where it stopped instead of double-posting."
            className="lg:col-span-4"
          >
            <NightAuditVisual />
          </BentoCard>

          <BentoCard
            icon={RefreshCw}
            eyebrow="Agent 02"
            title="Zero-Overbooking Channel Sync"
            description="Two-way rate and inventory distribution with an ordered, debounced push queue. Overselling is blocked by a database constraint, not a retry."
            className="lg:col-span-2"
          >
            <ChannelVisual />
          </BentoCard>

          <BentoCard
            icon={Smartphone}
            eyebrow="Agent 03"
            title="Magic Link Guest Portal"
            description="One SMS or WhatsApp link: mobile self check-in, ID and digital key upload, folio review and card-on-file settlement. No app install, no front-desk queue at 2pm."
            className="lg:col-span-3"
          >
            <div className="flex flex-wrap gap-2">
              {['Self check-in', 'ID upload', 'Digital key', 'Folio settle'].map((step) => (
                <span
                  key={step}
                  className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] text-zinc-400"
                >
                  {step}
                </span>
              ))}
            </div>
          </BentoCard>

          <BentoCard
            icon={CreditCard}
            eyebrow="Agent 04"
            title="Commission-Free Direct Engine"
            description="A sub-second booking widget on your own domain, keeping the 18–25% you currently hand to the OTAs."
            className="lg:col-span-3"
          >
            <CommissionVisual />
          </BentoCard>
        </div>
      </div>
    </section>
  );
}
