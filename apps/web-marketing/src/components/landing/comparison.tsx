import { Check, X } from 'lucide-react';

import { SectionHeading } from './primitives';

export interface ComparisonRow {
  dimension: string;
  legacy: string;
  easeit: string;
}

const ROWS: readonly ComparisonRow[] = [
  {
    dimension: 'Night audit',
    legacy: 'Manual, 30–60 minutes at the desk every single night',
    easeit: 'Deterministic background job per property, resumable, ~40s',
  },
  {
    dimension: 'Channel sync',
    legacy: 'Polled every 15–30 min; overbookings absorbed as refunds',
    easeit: 'Ordered two-way push; oversell rejected by a database constraint',
  },
  {
    dimension: 'Guest check-in',
    legacy: 'Front-desk queue and paper ID forms at 2pm',
    easeit: 'Magic-link self check-in, ID upload and digital key',
  },
  {
    dimension: 'Direct bookings',
    legacy: 'OTA-dependent, 18–25% commission on every stay',
    easeit: 'Sub-second engine on your own domain, 0% commission',
  },
  {
    dimension: 'Multi-property',
    legacy: 'A separate install and login per hotel',
    easeit: 'One portfolio, row-level tenant isolation, one sign-in',
  },
  {
    dimension: 'Money handling',
    legacy: 'Floating-point rounding drift across folios and taxes',
    easeit: 'Integer minor units, single-pass rounding, immutable folio lines',
  },
  {
    dimension: 'Upgrades',
    legacy: 'On-premise server with scheduled downtime',
    easeit: 'Continuously deployed, no maintenance window',
  },
];

export function Comparison() {
  return (
    <section id="features" className="relative px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-12">
        <SectionHeading
          eyebrow="Why operators switch"
          title="Legacy PMS versus an autonomous hotel OS"
          description="The difference is not the feature list. It is where correctness is enforced — in a checklist taped to the desk, or in the database."
        />

        <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-md">
          {/* Column header. Hidden on mobile, where each row carries its own
              inline labels instead. */}
          <div className="hidden border-b border-white/[0.08] bg-white/[0.02] md:grid md:grid-cols-[1fr_1.4fr_1.4fr]">
            <div className="px-5 py-3 text-[10px] font-semibold tracking-[0.18em] text-zinc-500 uppercase">
              Capability
            </div>
            <div className="px-5 py-3 text-[10px] font-semibold tracking-[0.18em] text-zinc-500 uppercase">
              Traditional legacy PMS
            </div>
            <div className="px-5 py-3 text-[10px] font-semibold tracking-[0.18em] text-blue-400 uppercase">
              EaseIt Hotel OS
            </div>
          </div>

          <ul>
            {ROWS.map((row) => (
              <li
                key={row.dimension}
                className="grid gap-3 border-b border-white/[0.05] px-5 py-5 last:border-b-0 md:grid-cols-[1fr_1.4fr_1.4fr] md:items-start md:gap-0 md:px-0 md:py-0"
              >
                <div className="text-sm font-semibold text-white md:px-5 md:py-5">
                  {row.dimension}
                </div>

                <div className="flex items-start gap-2.5 md:px-5 md:py-5">
                  <X className="mt-0.5 size-4 shrink-0 text-rose-400/80" aria-hidden="true" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium tracking-wider text-zinc-600 uppercase md:hidden">
                      Legacy
                    </span>
                    <span className="text-sm leading-relaxed text-zinc-500">{row.legacy}</span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 md:bg-blue-500/[0.03] md:px-5 md:py-5">
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden="true" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium tracking-wider text-blue-400/70 uppercase md:hidden">
                      EaseIt
                    </span>
                    <span className="text-sm leading-relaxed text-zinc-300">{row.easeit}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
