import { Clock, Play, RefreshCw, Sparkles, Building2 } from 'lucide-react';

import { AmbientGlow, CtaButton, Pill, StatPill } from './primitives';

export interface HeroStat {
  value: string;
  label: string;
  icon: typeof Building2;
}

const STATS: readonly HeroStat[] = [
  { value: '10+', label: 'boutique hotels', icon: Building2 },
  { value: '99.9%', label: 'OTA sync uptime', icon: RefreshCw },
  { value: '< 1s', label: 'direct booking checkout', icon: Clock },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden px-4 pt-20 pb-16 sm:px-6 sm:pt-28 lg:px-8">
      <AmbientGlow at="50% 0%" rgb="59 130 246" opacity={0.2} />
      <AmbientGlow at="15% 20%" rgb="129 140 248" opacity={0.12} />
      <AmbientGlow at="85% 10%" rgb="168 85 247" opacity={0.1} />

      <div className="mx-auto flex max-w-4xl flex-col items-center gap-8 text-center">
        <Pill icon={Sparkles} className="animate-none">
          Introducing EaseIt AI 2.0
          <span className="text-zinc-600" aria-hidden="true">
            •
          </span>
          <span className="text-zinc-400">Autonomous Hospitality</span>
        </Pill>

        <h1 className="text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl lg:text-6xl">
          The modern operating system for{' '}
          <span className="bg-gradient-to-r from-sky-300 via-blue-400 to-indigo-400 bg-clip-text font-serif text-transparent italic">
            autonomous
          </span>{' '}
          hotels
        </h1>

        <p className="max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg">
          One platform for your property management system, two-way channel distribution and an AI
          guest concierge. Run the whole portfolio from a single tenant-isolated database — no
          overbooking, no nightly spreadsheet reconciliation, no OTA commission on direct stays.
        </p>

        <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
          <CtaButton href="#get-started" className="w-full sm:w-auto">
            Start Free Trial
          </CtaButton>
          <CtaButton href="#demo" variant="secondary" icon={Play} className="w-full sm:w-auto">
            View Live Demo
          </CtaButton>
        </div>

        <ul className="mt-4 flex flex-wrap items-center justify-center gap-3">
          {STATS.map((stat) => (
            <li key={stat.label}>
              <StatPill value={stat.value} label={stat.label} icon={stat.icon} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
